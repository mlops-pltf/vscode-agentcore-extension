# AgentCore Chat — Implementation Plan

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

## 0. Ground rules

1. **Python is the brain, JS is the renderer.** Building payloads, parsing responses, keeping protocol state and mocking all live in `python/`. `extension.js` and the webview only pass messages along and draw normalized events. A new protocol or response shape should never need a JS change.
2. **No live AgentCore is available locally.** Every response shape is an *assumption*. It's captured as a fixture, covered by a unit test, and replayable through a mock runtime that goes through **the same parser** as the real calls.
3. **Assumptions are cheap to correct.** A debug setting dumps raw response lines to an Output channel. Anyone with real access can paste a real response into `python/tests/fixtures/` and the tests show what breaks.
4. Stay on the Python 3.9 standard library plus boto3 (the local venv is 3.9, so no `match` and no `X | Y` type hints). No new JS dependencies in this plan.

## 1. Facts checked against botocore 1.42.97 (not assumptions)

| Item | Fact |
|---|---|
| `bedrock-agentcore.invoke_agent_runtime` input | required: `agentRuntimeArn`, `payload` (bytes). optional: `runtimeSessionId`, `contentType`, `accept`, `qualifier`, `runtimeUserId`, … |
| output | `response` (StreamingBody), `contentType`, `runtimeSessionId`, `statusCode` |
| `StreamingBody.iter_lines()` | yields `b''` for blank lines, so standard SSE event framing works |
| `bedrock-agentcore-control.get_agent_runtime` | returns `protocolConfiguration.serverProtocol` ∈ `HTTP, A2A, MCP, AGUI` |
| `list_agent_runtimes` | returns `agentRuntimeArn, agentRuntimeName, description, status, …` (**no protocol**) |
| `list_registry_records` | **requires** `registryId`; returns `recordArn, name, description, descriptorType, status` (**no runtime ARN**) |
| `list_discoverable_registry_records` | **does not exist** (the current commented-out code would fail) |

## 2. Assumptions (to verify once someone has access)

| # | Assumption | Risk | How it's handled |
|---|---|---|---|
| A1 | HTTP agents accept `{"prompt": "<text>"}` | **Confirmed** by user | One constant `HTTP_PROMPT_KEY` in `http_protocol.py` |
| A2 | HTTP responses are `text/event-stream` (SSE `data:` lines) **or** `application/json` | Low | Parser branches on `contentType`, with a sniffing fallback |
| A3 | SSE `data:` payload is one of: plain text, JSON string, `{"data": str}` (Strands), `{"event":{"contentBlockDelta":{"delta":{"text"}}}}` (raw Bedrock), `{"text"/"delta"/"content"/"output"/"response"/"result": …}` | High | Ordered extractor list, one fixture per shape |
| A4 | Strands sends **both** `{"event": …}` and `{"data": …}` for the same token, and ends with `{"result": "<full text>"}` | Med | Raw `event` text and the final `result` are buffered and only used if the stream produced no `data`-style text (avoids doubled output) |
| A5 | A2A agents get a JSON-RPC 2.0 body through the same `invoke_agent_runtime`, method `message/send` (optionally `message/stream`) | Med | Method picked by the `agentcore.a2aStreaming` setting (default off) |
| A6 | A2A parts use `kind` (spec ≥0.2.x); older agents use `type` | Low | Accept both |
| A7 | A2A result is a `Message` or a `Task`; stream events add `status-update` and `artifact-update` | Med | Handle each `kind`; ignore unknown ones (they still appear in the raw debug log) |
| A8 | A2A conversation continuity comes from `contextId` (from the server, sent back on the next turn); `taskId` is sent back only when state is `input-required` | Med | State kept per `sessionId` in Python |
| A9 | `runtimeSessionId` must be ≥33 chars | Low | UUID4 (36 chars) |
| A10 | The SSO role-session name (last segment of the assumed-role ARN) identifies the user, and roles have `bedrock-agentcore:InvokeAgentRuntimeForUser` | Med: IAM may be missing | Dedicated error message (T1.5b); value shown in the raw debug log |
| A11 | If an agent's events can't be JSON-serialized, the server may send `json.dumps(str(event))`, i.e. a JSON string holding a Python dict repr | Low | `ast.literal_eval` on string events that look like `{...}`; fixture `python_repr.sse` |
| A12 | `traceId` is sent as the `X-Amzn-Trace-Id` header (confirmed in the boto3 1.42.97 model), so it takes the X-Ray format `Root=1-<8 hex time>-<24 hex>` *(was: W3C 32-hex)* | Med: accepted values not documented | On `ValidationException` retry once without it (T6.28); prefer the `traceId` AgentCore returns |
| A13 | CloudWatch GenAI Observability lives at `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#gen-ai-observability` | Med: no deep link per trace found | Opens the dashboard only; one constant to fix (`tracing.CLOUDWATCH_URL`) |
| A14 | AgentCore's agent card follows the A2A spec: `skills[].{name,description,examples}`, `capabilities.streaming`, `version` (boto3 returns it as a free-form JSON document) | Low | Missing fields are optional (`cards.summarize`); fixture from a real card when available |

## 3. Message contracts (Python ⇄ extension ⇄ webview)

**Webview → Python** (the extension adds `settings` to every message):

```text
list_profiles   {}
list_agents     {profile, refresh?}       # refresh skips the 5-minute cache
invoke_agent    {requestId, profile, agentArn, protocol: "HTTP"|"A2A", prompt, sessionId}
cancel          {requestId}
reset_session   {sessionId}
restartBackend / showLogs / ssoLogin   # webview -> extension only (not forwarded to Python)
settings (injected) {mock: bool, region: str, a2aStreaming: bool, debugRaw: bool}   # added by extension.js to every message
```

**Python → webview** (everything is one JSON object per stdout line):

```text
profiles      {data: [str]}
agents        {profile, data: [{name, arn, description, protocol: "HTTP"|"A2A"|null}], note?}
                                # note e.g. "1 non-chat agent (MCP/AGUI) hidden"; stale replies (other profile) are ignored
sso_expired   {profile, requestId?}
chunk         {requestId, text}                 # append to the bubble
status        {requestId, text}                 # small grey line: "working…", "tool: search"
done          {requestId, meta: {state, protocol, mock, contentType, ms, contextId?, taskId?, taskState?}}
                                # state = completed|cancelled (the request); taskState = the A2A task's state
error         {requestId?, message}
raw           {requestId, line}                 # extension sends this to the Output channel only
bridge        {state: "ready"|"restarting"|"down"}
settings      {data: {mock, region, a2aStreaming, debugRaw}}   # extension -> webview when settings change; also embedded in the HTML at load
```

## 4. Tasks

Each task is one small commit that can be reviewed alone. "Done when" is the check that it works.

### Phase 0: Hygiene & security (no behaviour change)

- [x] **T0.1** `python/requirements.txt` → `boto3>=1.40.0`.
  *Done when:* a fresh managed venv can `import boto3` and create a `bedrock-agentcore` client.
- [x] **T0.2** Re-sync the venv when requirements change: store a sha256 of `requirements.txt` in `<venv>/.req-hash`, and run `pip install -r` again on mismatch (`extension.js::_ensurePythonEnv`).
  *Done when:* editing requirements and reloading triggers a reinstall exactly once.
- [x] **T0.3** Webview CSP with a per-render nonce (`default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-…'`).
  *Done when:* the panel works and DevTools shows no CSP violations.
- [x] **T0.4** Replace every `innerHTML` built from data (profiles, agents) with `document.createElement('option')` + `textContent`.
  *Done when:* a profile named `<img src=x onerror=alert(1)>` shows up as text.
- [x] **T0.5** Check the profile name against `^[\w.@+-]+$` before `aws sso login`; show an error message otherwise.
  *Done when:* a profile containing `; rm` is refused.

- [x] **T0.6** *(found while testing Phase 1)* Activity Bar icon shows as a gray square. Cause: `media/robot.svg` has `xmlns="http://w3.org"` instead of `http://www.w3.org/2000/svg`. VS Code uses the icon as a CSS mask, and an invalid SVG makes the mask fail, so the whole box gets filled. Fix the namespace.
  *Done when:* the Activity Bar shows the robot outline, and it follows the theme colour (dim when inactive, bright when selected).
- [x] **T0.7** Replace the generic robot with an "agent in a speech bubble" icon (picked from 3 candidates compared side by side in the Activity Bar). 1.5px strokes to match VS Code's built-in icons; still `currentColor` so it follows the theme.

### Phase 1: Python restructure (same behaviour, new structure)

Original target layout (superseded by the design review, see "Design review" below):

```text
python/
  bridge.py              # stdin loop, dispatch, threads, send() lock
  agentcore/
    __init__.py
    events.py            # Emitter: chunk/status/done/error/raw helpers bound to requestId
    cancel.py            # CancelToken: flag + closes the streaming body to unblock reads
    sse.py               # iter_sse_events(lines) -> yields data strings
    text_extract.py      # extract_text(obj) -> (text|None, kind)  (A3/A4)
    http_protocol.py     # build_payload(), handle_response()
    a2a_protocol.py      # build_payload(), handle_response(), session state
    aws.py               # boto3 session/client creation, invoke(), list_agents()
    mock_runtime.py      # fake invoke() returning {contentType, response: FakeBody}
  tests/
    fixtures/            # *.sse / *.json captured or hand-written responses
    test_sse.py
    test_text_extract.py
    test_http_protocol.py   (now test_protocol_http.py)
    test_a2a_protocol.py
    test_bridge_smoke.py
```

- [x] **T1.1** `events.py`: thread-safe `send()` (a `threading.Lock` around print + flush) and an `Emitter(request_id)` class with `chunk/status/done/error/raw`.
- [x] **T1.2** `bridge.py`: move to the dispatch-table style (`HANDLERS = {"list_profiles": …}`); unknown action → `error`. Python behaviour stays the same.
- [x] **T1.3** Run each `invoke_agent` on its own `threading.Thread`, tracked in `ACTIVE = {requestId: CancelToken}`; the stdin loop never blocks.
- [x] **T1.4** `cancel`: set the token's event **and** call `body.close()` on the live StreamingBody so a blocked read returns; emit `done` with `meta.state="cancelled"`.
- [x] **T1.5** `aws.py`: `get_session(profile)` (cached per profile), `invoke(profile, arn, session_id, payload_bytes, accept)` → raw boto response. SSO errors become a single `SsoExpired` exception.
- [x] **T1.5b** `aws.get_runtime_user_id(profile)`: `sts.get_caller_identity()` once per profile (cached). For `arn:aws:sts::<acct>:assumed-role/<role>/<session>` use `<session>` (usually the SSO email); otherwise fall back to `UserId`. Send it as `runtimeUserId` on every invoke. An `AccessDeniedException` that mentions `InvokeAgentRuntimeForUser` → a clear `error`: "Your role lacks bedrock-agentcore:InvokeAgentRuntimeForUser". The mock returns `mock-user@example.com`.
- [x] **T1.6** `mock_runtime.py`: `invoke(...)` with the same signature returning `{"contentType", "response": FakeBody, "statusCode"}`. `FakeBody` has `iter_lines()`, `read()`, `close()` and sleeps ~80 ms between lines. Scenarios are picked by protocol and prompt keyword (`json`, `error`, `slow`, `tool`, `input`).
  *Done when:* `aws.invoke` and `mock_runtime.invoke` can be swapped with `settings.mock`.
  *Note:* the bridge uses the mock unless `settings.mock` is explicitly `false` (safe default: never hit AWS by accident).

### Phase 2: HTTP protocol handler

- [x] **T2.1** `sse.py::iter_sse_events(lines)`: standard framing (collect `data:` lines, join with `\n`, emit on a blank line or at end of stream; ignore `event:`/`id:`/`:comment`). Bytes are decoded as UTF-8 with `errors="replace"`.
- [x] **T2.2** `text_extract.py::extract_text(obj)`: ordered rules for A3; returns `(text, "data"|"raw_event"|"other")`; non-text dicts → `(None, …)`.
- [x] **T2.3** `http_protocol.build_payload(prompt)` → `json.dumps({HTTP_PROMPT_KEY: prompt}).encode()`; `accept="application/json, text/event-stream"`.
- [x] **T2.4** `http_protocol.handle_response(resp, emitter, cancel)`:
  - SSE → for each event: try `json.loads`, else plain text → `extract_text` → `chunk`. Buffer `raw_event` text (A4) and flush it at the end only if nothing else was emitted.
  - JSON → `read()` the whole body, `extract_text`; also handle the Strands `AgentResult` shape (`{"role","content":[{"text"}]}`). If no text, emit the pretty JSON inside a fenced ```json block.
  - Other / unknown content type → decode and emit as-is.
  - `statusCode >= 400` → `error` with the body text.
- [x] **T2.5** Tests: one fixture for each A3 shape plus a Strands "both" stream (expect no doubled text) and a JSON body.

### Design review (between Phases 2 and 3, branch `refactor-design-validation`)

Checked the design against the plan and the phases still to come (A2A, settings, webview). Behaviour is unchanged; the existing tests pass with the same assertions.

- [x] **R1** `errors.py`: `SsoExpired`/`AgentCoreError` move out of `aws.py`, so protocol and mock code don't depend on boto3.
- [x] **R2** `response.py`: `AgentResponse.events()` handles content types, SSE framing, sniffing, `[DONE]`, the A11 repr fix, cancel, the raw debug log and error statuses **once**. It yields `Event(value, whole_body)`. Protocols only interpret events, so A2A reuses all of it.
- [x] **R3** `protocols/` package: an `AgentProtocol` base (`name`, `accept`, `build_payload(ctx)`, `handle(response, emitter, ctx)`), an `InvokeContext` dataclass (prompt, session, settings, `session_state`), and a registry. `http_protocol.py` → `protocols/http.py` (`HttpProtocol`).
- [x] **R4** `sessions.py`: per-session state store, plus a `reset_session` bridge action (it was in the contract but not implemented).
- [x] **R5** `invocations.py` + `backends.py`: the request registry, worker threads, cancel and the invoke flow move out of `bridge.py`, which now only reads commands and dispatches them.
- [x] **R6** `events.claim_stdout()`: the real stdout is kept for protocol messages and stray `print()`s go to stderr, so they can't corrupt the JSON stream.
- [x] **R7** `done.meta.mock` flag on every reply, so a missing setting can never pass off mock replies as real (shown by the T6.8 badge).
- [x] **R8** Fix in `extension.js`: the webview's first message could be lost. The listener was attached only after `await _startPythonBridge()` (slow during venv setup). The listener is now attached first and messages queue until Python is running. Checked with a simulated 1.5 s setup: the old code dropped `list_profiles`, the new code delivers it.

Current layout:

```text
python/
  bridge.py                # stdin loop + dispatch table only
  agentcore/
    errors.py              # SsoExpired, AgentCoreError
    events.py              # send(), claim_stdout(), Emitter(request_id)
    cancel.py              # CancelToken
    backends.py            # backend_for(settings): aws or mock_runtime
    invocations.py         # start/cancel/wait_all, worker thread per request
    sessions.py            # per-session state, reset
    response.py            # AgentResponse.events() -> Event(value, whole_body)
    sse.py                 # SSE framing
    text_extract.py        # HTTP reply-shape rules (A3/A4)
    protocols/
      __init__.py          # registry: get(name)
      base.py              # AgentProtocol, InvokeContext
      http.py              # HttpProtocol
      a2a.py               # A2aProtocol (Phase 3)
    aws.py                 # boto3: clients, identity, invoke
    mock_runtime.py        # fake invoke with the same functions as aws.py
  tests/                   # unittest; fixtures/ holds raw reply bodies
```

### Phase 3: A2A protocol handler

- [x] **T3.1** `protocols/a2a.py`: `A2aProtocol(AgentProtocol)`, registered in `protocols/__init__.py`. Conversation state (`contextId`, `pendingTaskId`) lives in `ctx.session_state` (R4) and is cleared by `reset_session`.
- [x] **T3.2** `build_payload(ctx)` (streaming from `ctx.settings["a2aStreaming"]`, rpc id = `ctx.request_id`) → JSON-RPC 2.0: `method` = `message/stream` or `message/send`; `params.message = {kind:"message", role:"user", messageId: uuid4, parts:[{kind:"text", text}], contextId?, taskId?}`.
- [x] **T3.3** `parts_to_text(parts)`: `text` → text; `data` → fenced json; `file` → `📎 name (uri)`. Accepts both `kind` and `type` (A6).
- [x] **T3.4** `handle_result(result)` by `kind` (A7):
  - `message` → chunk(parts)
  - `task` → artifacts' parts → chunk; if there are none, `status.message` → chunk; record `id`/`contextId`/`status.state`
  - `status-update` → `status.message` → **status** line (or chunk if `final` and nothing was emitted yet); state `failed` → error
  - `artifact-update` → chunk (respect `append`; the first artifact chunk of a new artifact starts with a blank-line separator)
- [x] **T3.5** `handle(response, emitter, ctx)`: each `response.events()` value is a JSON-RPC envelope (many when streamed, one for send) → `handle_result`. `error` in the envelope → `error` with `code: message`.
- [x] **T3.6** Update `SessionState` from the results (A8); `done.meta` includes `contextId`, `taskId`, `state`. If the state is `input-required`, add a status line "Agent is waiting for your input".
- [x] **T3.8** `python/tools/chat_cli.py`: terminal chat through the real bridge (`--protocol A2A`, `--stream`, `--real`, `--raw`), for trying A2A before the panel toggle exists and for checking real agents without VS Code.
- [x] **T3.7** Tests: send→Message, send→Task with artifacts, send→Task failed, stream with status+artifact updates, JSON-RPC error, legacy `type` parts, and contextId carried into the second payload.

### Phase 4: Agent listing & protocol detection

- [x] **T4.1** `aws.list_agents(profile)`: `list_agent_runtimes` (paginate), keep `status == "READY"`, then `get_agent_runtime` per agent (thread pool, max 8) to read `protocolConfiguration.serverProtocol`. Only keep `HTTP`/`A2A`; `MCP`/`AGUI` are skipped and counted in a status note. Registry is **not** used (decided Q1).
- [x] **T4.1b** Remove the `agentcore.registryId` setting from `package.json` and the `registryId` injection in `extension.js`.
- [x] **T4.2** Mock listing: 3 agents (`demo-http-strands` HTTP, `demo-a2a` A2A, `demo-unknown` null).
- [x] **T4.3** Cache the agent list per profile for 5 min; the refresh button skips the cache.

### Phase 5: Extension host (`extension.js`)

- [x] **T5.1** New settings in `package.json`: `agentcore.mock` (bool, default `false`), `agentcore.a2aStreaming` (bool, `false`), `agentcore.debugRawResponses` (bool, `false`), `agentcore.region` (string, default `eu-central-1`; empty = use the profile's region). Region overrides the profile's region in Python (client and agent-list caches are keyed by it). Changing mock/region reloads the agent list; changing `pythonPath` restarts the bridge.
- [x] **T5.2** Add `settings` to every message sent to Python.
- [x] **T5.3** Output channel "AgentCore Chat": receives Python stderr and `raw` events (when debug is on); `raw` is never forwarded to the webview.
- [x] **T5.4** Bridge supervision: on unexpected `exit`, post `bridge:restarting` and respawn with backoff (1 s, 3 s, 10 s). A 4th crash within 60 s → `bridge:down` plus an error notification with "Show Logs" / "Restart". Commands **AgentCore: Show Logs** and **AgentCore: Restart Backend** (resets the backoff). Messages sent while restarting are queued and delivered.
- [x] **T5.5** Kill the Python process on `deactivate` as well as on view dispose.

### Phase 6: Webview

Done in three rounds, each on branch `phase-6-webview`, tested by the user and committed before the next round starts.

#### Round 6a: Foundation (no visible change)

- [x] **T6.0** *(from the design review)* Move the webview out of the template string in `extension.js` into `media/webview/{main.js,main.css}`, loaded via `asWebviewUri`. CSP: `script-src ${cspSource} 'nonce-…'`, `style-src ${cspSource}`. No more `\${}` escaping, and the files can be linted and edited normally. Do this first in Phase 6, before the UI grows.

*Done when:* the panel looks and behaves exactly as before (Phase 5 tests 1-2 pass again), `extension.js` contains no webview HTML/CSS/JS, and DevTools shows no CSP violations.

#### Round 6b: Chat core

- [x] **T6.1** Protocol toggle: a segmented control `HTTP | A2A` next to the agent picker. Picking an agent sets it from `agent.protocol` when known. A manual override is saved per agent ARN in `vscode.setState`. The toggle shows an "auto" dot when it matches the detected protocol. Unknown protocol → HTTP with a "choose" hint. *Also:* changing agent mid-chat starts a new chat, because an A2A context belongs to one agent.
- [x] **T6.2** Changing the protocol mid-conversation asks "Start new session?", since an A2A context can't be reused by HTTP. Implemented as an in-panel notice ([Switch] / [Cancel]), because VS Code webviews block `window.confirm`. A new chat sends `reset_session` for the old session id.
- [x] **T6.3** Request IDs: each send creates `requestId`; bubbles are stored in `Map<requestId, el>`; every incoming event is routed by ID (fixes the mixed-up replies).
- [x] **T6.4** While waiting for or streaming a reply: **Send is disabled** and a **Stop** button is enabled (posts `cancel`). Both go back on `done`/`error`. Enter in the textbox does nothing while busy. *(Refined from user feedback.)*
- [x] **T6.5** `status` events render as a small muted line inside the bubble (the latest one replaces the previous).
- [x] **T6.6** Footer on `done`: `A2A · 1.8s · task completed` (from `meta`).
- [x] **T6.7** `bridge` events: a thin banner ("Reconnecting…" / "Backend stopped — Show Logs"). The banner replaces the Phase 5 red chat lines; replies in progress are marked "Backend stopped before the reply finished." The banner buttons post `restartBackend` / `showLogs`, which run the matching commands.
- [x] **T6.8** "MOCK" badge in the header when `settings.mock` is on, so nobody confuses fake replies with real ones.

*Done when:* an A2A agent can be chatted with from the panel (toggle set automatically), two prompts in a row never mix, Stop cancels a slow reply, and the MOCK badge and backend banner behave as described.

#### Round 6c: Polish

- [x] **T6.9** Redesign Send as an icon button with a **right-pointing arrow** (inline SVG, `currentColor`, with `title`/`aria-label` "Send"); Stop is a square icon in the same spot.
- [x] **T6.10** Chat placement. *Decided (2026-11-21):* the chat lives in the **Secondary Side Bar (right)** by default, as a tab next to Copilot Chat, so all chats are in one place. No setting: users who prefer the left use **Move View** (VS Code remembers), and **Reset Location** returns it to the right. `engines.vscode` raised to `^1.147.0`, since that's the version confirmed to place extension containers in the Secondary Side Bar. A dual-registration + `agentcore.chatLocation` setting was tried and dropped as unnecessary. **AgentCore: Open Chat** focuses the view wherever it is, and Python is kept alive when VS Code re-creates the view after a move.
- [x] **T6.11** Typing indicator: until the first `chunk` (or `status`) arrives, the agent bubble shows three softly bouncing dots instead of a static `...`. Respects `prefers-reduced-motion` (falls back to a gentle pulse/static dots).

*Done when:* the arrow/stop button, typing dots and right-side placement work in both light and dark themes.

#### Round 6d: Premium look (added 2026-11-21, from user feedback before Phase 7)

Goal: the panel should feel as polished as Copilot / Claude chat (not identical), because it will be shown to customers. Chosen direction: **composer pickers**, with a slim toolbar on top and the agent and protocol chosen inside the input card. Still no new libraries: inline SVG icons, VS Code theme variables (`--vscode-chat-*` where available), and DOM built with `textContent`/`createElement` (never `innerHTML`).

Split into three sub-rounds (tested and committed one at a time):

##### 6d.1: Layout and look

- [x] **T6.12** Responsive layout. Nothing is cut off down to ~220 px wide: selects and labels shrink with ellipsis (`min-width: 0`), and icon buttons never shrink or wrap away. *(Bug: MOCK, ↻ and + disappeared in narrow panels.)*
- [x] **T6.13** Slim toolbar. One row: profile picker (compact), MOCK badge, icon buttons **Refresh** and **New chat** (inline SVG, tooltips). The SSO banner, hidden-agents note and backend banner sit below it.
- [x] **T6.14** Composer card: a rounded input card (focus ring in the theme's focus colour) with an auto-growing textarea (up to ~8 lines), placeholder "Ask *agent*…", and a footer row with the **agent chip** (picker), **protocol chip** (HTTP | A2A), a muted "⏎ send · ⇧⏎ new line" hint (hidden when narrow) and the Send/Stop icon.
- [x] **T6.15** Message design. User prompts are right-aligned subtle bubbles. Agent replies have no box: a small robot avatar and the agent name above full-width text, the footer muted underneath, and errors inline. New messages fade in gently (respecting reduced motion).
- [x] **T6.17** Empty state. When the chat is empty, show a welcome card with the robot icon, the agent's name, description and protocol, and 2–3 suggestion chips that fill the composer when clicked.

*Done when:* at ~220 px wide every control is still usable; the toolbar, composer card (with agent and protocol chips), new message style and welcome screen look right in light and dark themes; all 6b behaviour still works (e2e checks updated).

##### Design review 2 (after 6d.1, before 6d.2)

The JS side grows a lot in 6d.2, 6d.3 and 6e, so it gets the same treatment the Python side got in review 1. No behaviour change; the committed JS tests (R12) prove it.

- [x] **R12** Commit the JS tests that so far lived in a temp folder: `test/node/webview.e2e.spec.js` (the real panel in jsdom, wired to the real Python bridge, covering all 6b/6c/6d.1 behaviour) and `test/node/host.spec.js` (real `extension.js` with a stubbed `vscode` module and real Python: settings injection, raw-line routing, crash restart and backoff, give-up, deactivate, view hand-over). Uses Node's built-in `node:test`; `jsdom` is a dev-only dependency. Runs with `npm run test:js`. (Named `*.spec.js` so the VS Code test runner, which picks up `test/**/*.test.js`, doesn't load them.) *Done first, so R9-R11 are checked by it.*
- [x] **R10** Panel markup moves from `extension.js` to `media/webview/index.html`, with `{{placeholders}}` for the nonce, CSP source, asset URLs and starting values.
- [x] **R11** Split `extension.js` by responsibility: `src/pythonEnv.js` (find or create the venv, re-sync requirements), `src/pythonBridge.js` (spawn, supervise with backoff, queue, route stdout/stderr/raw), `src/chatView.js` (webview provider and webview → extension messages). `extension.js` only wires them together and registers commands.
- [x] **R9** Split the panel script into files: `media/webview/dom.js` (element helpers, icons), `chat.js` (welcome card, bubbles, footer, typing dots), `main.js` (state, wiring, and a handler table for extension → webview messages instead of an if/else chain). These are **classic scripts sharing one `AgentCore` namespace, not ES modules**: jsdom can't run ES modules, and Node would need `.mjs` files (unconfirmed MIME support in webviews). Classic scripts load unchanged in the webview, in jsdom and in `node:test`. In 6d.2, Markdown comes as `markdown.js`, split into `parse(text)` (pure data, unit-tested without a browser) and `render(tree)` (builds DOM nodes).
- **Design note for 6d.2:** every editor action from the panel uses **one** message, `{type: "editor", op, ...}`, with `op` ∈ `copy`, `openLink`, `insertAtCursor`, `newFile`, `insertInTerminal`. It's handled by one function, `runEditorAction` in `src/editorActions.js` (called from `chatView.js`), which does its own validation (known ops only; links `http(s)` only; text capped at 1 MB; terminal insert never sends Enter, and multi-line text is pasted so shells with bracketed paste don't run it line by line).

##### 6d.2: Rich replies

- [x] **T6.16** Markdown for agent replies. A small, safe renderer that builds DOM nodes: paragraphs, headings, **bold**/*italic*, `inline code`, fenced code blocks (language label + **Copy**), bulleted/numbered lists, block quotes, rules and links. Links open in the browser through the extension, `http(s)` only. Re-rendered as text streams in (at most once per animation frame). User prompts stay plain text.
- [x] **T6.18** Reply actions: a **Copy** button on agent replies (on hover/focus) that copies the original Markdown. Copying goes through the extension (`vscode.env.clipboard`), so it works in every webview.
- [x] **T6.19** Code block actions (from research, matching Copilot): besides **Copy**, **Insert at Cursor** (active editor), **Open in New File** (untitled document in the block's language), and for shell blocks (`bash`, `sh`, `zsh`, `shell`, `console`) **Insert into Terminal**, which inserts the command but **does not run it**. All go through the extension.
- [x] **T6.24** **Retry** on failed replies only (error or backend lost): resends the same prompt with the same agent and protocol. It is not offered on successful replies, because re-running an agent can have side effects.

*Done 2026-11-21* (links carry no `href`: VS Code's webview opens any `<a href>` by itself, skipping the extension's check and prompt). *Done when:* the mock's `markdown` reply renders headings, lists, code (with language label) and links correctly while streaming; Copy reply, the code-block actions and Retry work; nothing is built with `innerHTML`.

##### 6d.3: Behaviour and accessibility

- [x] **T6.20** Elapsed timer while waiting: the typing indicator shows *Thinking · 4s* until the first words arrive, so long waits are understandable.
- [x] **T6.21** Smart scrolling: auto-scroll only while the user is at the bottom. If they scroll up to read, leave the view alone and show a **↓ Jump to latest** button.
- [x] **T6.22** Keyboard: **↑** in an empty composer recalls the last prompt, and **Esc** stops a reply in progress. *(Trimmed 2026-11-21 by the user: no keybinding for Open Chat.)*
- **T6.23** Accessibility: *deferred 2026-11-21 by the user ("maybe later"); see section 7.*

*Done 2026-11-21.* Scrolling up (wheel, trackpad or scrollbar) stops following at once, even near the bottom; only moving down to the bottom resumes it. The mock's `slow` also delays one-piece answers (A2A `message/send`, HTTP `json`) by 3s, so the timer shows there too. *Done when:* the timer, smart scrolling, ↑ recall and Esc work.

#### Round 6e: AgentCore depth (added 2026-11-21, from web research; builds on 6d)

*Split 2026-11-21 into two branches the user pulls and tests on the office laptop (real AgentCore): `phase-6e1-agent-card` (T6.25, T6.26) and `phase-6e2-sessions-trace-identity` (T6.27-T6.29, on top of 6e1). Verified here with the mock and automated tests only.*

Goal: features specific to AgentCore that generic chat tools don't have, as selling points. Logic stays in Python; every new AWS call degrades gracefully if the role lacks the permission (logged, never blocks chatting). APIs confirmed in boto3 1.42.97: `get_agent_card`, `stop_runtime_session`.

- [x] **T6.25** Agent Card (Python). New bridge action `get_agent_card {profile, agentArn}` → event `agent_card {agentArn, card}` where `card = {name, description, version, skills: [{name, description, examples}], streaming}` (or `null` plus a note). Only for A2A agents, cached per agent like the agent list. `AccessDenied` (needs `bedrock-agentcore:GetAgentCard`) → `card: null`. The mock returns a card with skills and `streaming: true`.
- [x] **T6.26** Use the card. The empty state (T6.17) shows the agent's **skills**, with their examples as suggestion chips (falling back to generic chips) and the version. **Automatic A2A streaming:** `agentcore.a2aStreaming` becomes `auto` (default) / `on` / `off`. With `auto`, Python uses `message/stream` when the cached card says `capabilities.streaming`, otherwise `message/send`. *(Resolves Q3 per agent instead of globally.)*
- [x] **T6.27** Free server resources: when a session ends (New chat, agent change, protocol switch), Python calls `stop_runtime_session` for every agent that session used (profile, region and ARN recorded at invoke time), in the background. Errors (`AccessDenied`, session already gone) are logged only. Needs `bedrock-agentcore:StopRuntimeSession`. Stop (cancel) does *not* end the session, so the user can continue.
- [x] **T6.28** Trace ID per reply: Python generates a trace id for every invoke, sends it as `traceId`, and returns it in `done.meta.traceId`. The reply's actions get **Copy trace ID** and **Open CloudWatch** (GenAI Observability page for the region, opened through the extension). If AgentCore rejects the id format (`ValidationException`), it retries once without it and logs a warning (A12).
- [x] **T6.29** Identity at a glance: new bridge action `whoami {profile}` → `identity {profile, account, region, user}` (from `sts:GetCallerIdentity`, already used for `runtimeUserId`; cached). Shown as the profile picker's tooltip and in the Output channel. The mock returns a fake identity.

*Done when:* with the mock, an A2A agent shows its skills as chips and streams automatically, New chat logs a stopped session, each reply can copy its trace id and open CloudWatch, and the profile tooltip shows the account, region and user. The Python tests cover the card parsing, auto-streaming choice, stop-session bookkeeping and the trace-id fallback.

##### Round 6e: checks on the office laptop (real AgentCore)

Use `agentcore.mock = false`, a real profile, and **AgentCore: Show Logs** (Output channel) open. Branch `phase-6e1-agent-card` covers 1-3; `phase-6e2-sessions-trace-identity` covers all.

1. **Agent Card (A14):** pick an A2A agent. Expected: version, skills and example chips on the welcome card. If not, the log says why (`No permission to read the Agent Card` = missing `bedrock-agentcore:GetAgentCard`; `No Agent Card: ...` = other). To keep the real card as a test fixture, save the output of `aws bedrock-agentcore get-agent-card --agent-runtime-arn <arn>` (needs a recent AWS CLI v2).
2. **Auto streaming:** with `a2aStreaming = auto`, the footer says `A2A · streamed` only for agents whose card has `capabilities.streaming: true`.
3. **Old setting values:** set `a2aStreaming` to `true`/`false` in settings.json: still works (`on`/`off`).
4. **Trace ID (A12):** send a message; hover the reply: **Copy trace ID** gives `1-xxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx`. Watch the log for `AgentCore refused traceId ... retrying without it`: if it appears, the format is wrong (replies still work). Look the id up in CloudWatch → X-Ray traces / Transaction search.
5. **Open in CloudWatch (A13):** opens the GenAI Observability page in the right region (asks before opening).
6. **Stop session:** after a chat, click **+** (New chat). Log: `Stopped runtime session ... on <agent>`, or `Could not stop ... (needs bedrock-agentcore:StopRuntimeSession)`.
7. **Identity:** hover the profile picker: your user, account and region. Also logged as `Profile <name>: ...`.

### Phase 7: Docs & verification

- [x] **T7.1** README: required IAM permissions (`InvokeAgentRuntime`, `InvokeAgentRuntimeForUser`, `ListAgentRuntimes`, `GetAgentRuntime`, and the optional `GetAgentCard`, `StopRuntimeSession`), settings table, how to use mock mode, how to capture a real response (`debugRawResponses`) and turn it into a fixture, and a tip on where the chat lives (right, as a tab next to Copilot Chat), moving it to the left (right-click → Move View, or drag) and back (right-click → Reset Location).
- [x] **T7.2** `python/tests/README.md` + `npm run test:py` script (`python -m unittest discover python/tests`).
- [ ] **T7.3** Manual test checklist (below) run in the Extension Development Host with `agentcore.mock=true`.
- [x] **T7.4** CHANGELOG entry.
- [x] **T7.5** Add `python/tests/**`, `python/tools/**` and `**/__pycache__/**` to `.vscodeignore` so tests and fixtures are not shipped in the `.vsix`. *(Also `docs/**`, `*.vsix`, `**/*.pyc`; checked with `vsce ls`.)*
- [x] **T7.6** *(added 2026-11-21)* Fix ESLint: install the missing `globals` dev dependency, browser globals for `media/webview`, CommonJS for the rest. `npm run lint` is clean, so `npm test` (which lints first) works again.

### Phase 8: Searchable agent picker (added 2026-11-21; user request: "we have a lot of agents")

The native `<select>` can't be searched, so the agent chip opens our own picker. The hidden `<select>` stays the single source of truth: the picker only shows it and sets it (with a `change` event), so all agent-change logic in `main.js` (new chat mid-conversation, protocol, welcome card) is untouched. Panel-only; no Python change.

- [x] **T8.1** Picker (`media/webview/picker.js`): the chip becomes a button showing the current agent; clicking it opens a panel **above** the composer (full composer width) with a search box (focused, "Search N agents...") and the agent list. Each row: name, protocol (HTTP / A2A / ?) and a one-line description; the current agent is marked. It follows the `<select>` through a MutationObserver, so loading / "No agents found" / SSO states show in the chip, and the chip is disabled while there are no agents.
- [x] **T8.2** Search: filters as you type, case-insensitive, on name **and** description; matches highlighted (built with text nodes and `<mark>`, never HTML). No match: "No agents match" with a **Refresh agents** link.
- [x] **T8.3** Keyboard and mouse: ↑/↓ move (wrapping), Enter picks, Esc closes (without stopping a reply), Tab or a click outside closes; hovering a row highlights it.
- [x] **T8.4** Tests: panel tests for opening, filtering, highlighting, keyboard, picking (incl. mid-chat new chat), empty states, and untrusted names/descriptions shown as text; README and CHANGELOG.

- [x] **T8.5** *(added 2026-11-21; user report: the dots don't bounce on the office laptop, VS Code 1.109)* With `prefers-reduced-motion: reduce` (an OS setting, often on in remote desktops) the typing dots now **fade in turn** instead of standing still. Likely cause to confirm at the office: `matchMedia('(prefers-reduced-motion: reduce)').matches` in Webview Developer Tools.

*Done 2026-11-21 (mock); a long real list still to try at the office.* *Done when:* with the mock, searching filters and picks agents by mouse and keyboard; with a long real list (office), finding an agent by part of its name or description is quick.

### Phase 9: Sample agent, reply format guide, tables (added 2026-11-21)

User requests: "add the doc" (what agents should return), "tables like |Day|Focus| are not rendering", and "add a sample agent, make sure you are using BedrockAgentCoreApp". Checked against the real SDKs: `bedrock-agentcore` 1.27.0, `strands-agents` 1.65.0, starter toolkit 0.3.14 (its `launch` is now `deploy`).

- [x] **T9.1** `docs/AGENT_REPLY_FORMAT.md`: request, recommended SSE events, one-piece answers, errors, Markdown, A2A results, Agent Card, how to check a real agent; linked from the README.
- [x] **T9.2** GitHub-style **tables** in `markdown.js`: header + delimiter row, alignment (`:---:`, `---:`), inline Markdown in cells, `\|` in cells, rows padded to the header; wide tables scroll sideways. A header without its delimiter row (still streaming) stays a paragraph. The mock's `markdown` sample gains a table.
- [x] **T9.3** **Mid-stream errors**: `BedrockAgentCoreApp` turns an exception in the entrypoint into an event `{"error", "error_type", "message"}`. Before, the chat showed "An error occurred during streaming" as reply text and "completed"; now `text_extract` returns kind `error` and the HTTP protocol ends the reply with "Agent error: <type>: <message>" (text so far kept, Retry offered).
- [x] **T9.4** `samples/http-agent/`: `agent.py` with `BedrockAgentCoreApp` + Strands (async generator entrypoint forwarding only `data` and `current_tool_use`; one agent per `context.session_id`; tools `current_time`, `word_count`; Markdown system prompt; `MODEL_ID`; `ECHO_MODE=1` for no model), `requirements.txt`, README (run locally with curl, deploy with the starter toolkit, use from the extension). Its own venv (Python 3.10+; the extension's dev venv is 3.9).
- [x] **T9.5** `samples/http-agent/test_agent.py` (`npm run test:sample`): the real `BedrockAgentCoreApp` through Starlette's test client with a fake Strands agent; the streamed bytes are read by the extension's own `HttpProtocol`. Covers text and tool status, one agent per session, missing prompt, an exception reaching the extension as an error, echo mode, `/ping`. `samples/**` left out of the `.vsix`.

*Done 2026-11-21 (tests and mock); deploying the sample is for the office.* *Done when:* tables render in the chat; the sample's stream is read correctly by the extension (tests); at the office, the deployed sample answers in the chat with tool status, Markdown and a table.

### Phase 10: Whole JSON replies as Markdown (added 2026-11-21)

User request: show the entire JSON reply converted to Markdown, not only its message field, "otherwise I have to ask people to rewrite all the agents". User chose the proposed defaults. Built before seeing real replies, so every rule is one small function in `json_markdown.py`, to adjust when real examples arrive (as fixtures).

- [x] **T10.1** `python/agentcore/json_markdown.py`: JSON to Markdown. The main text (the field we already recognise) first, as Markdown; then the other fields: single values as `**Key:** value` (keys made readable: `source_documents` -> "Source documents"), lists of single values as bullets, lists of similar objects as a table, nested objects under a bold label, deeper than 3 levels as a JSON block. Hidden fields (any level, case-insensitive): a built-in list (`role`, `usage`, `metrics`, token counts, trace/request/session ids, stop reason, latency) plus the new setting `agentcore.jsonHiddenFields`.
- [x] **T10.2** Setting `agentcore.jsonReplies`: `full` (default: main text + other fields), `text` (old behaviour: main text only), `raw` (always a JSON block). Applies to one-piece JSON replies (HTTP), the extra fields of a stream's **final** event (`result` / assistant `message`; per-token events are never expanded), and A2A `data` parts.
- [x] **T10.3** "Open raw JSON": replies built from JSON carry it in `done.meta.rawJson` (capped at 200 KB); the reply gets a button that opens it in a new JSON editor tab (the existing `newFile` editor action).
- [x] **T10.4** Mock keyword `structured` (HTTP: one-piece JSON with message, status, confidence, sources, nested details and hidden metrics; A2A: a text part plus a data part), tests (converter rules, settings, HTTP/A2A paths, panel button), README/CHANGELOG and the reply format guide.

*Done 2026-11-21 (tests and mock); rules still to tune with real replies from the office.* Also fixed: ESLint now ignores every `.venv` (the sample agent's venv came in with Phase 9). *Done when:* with the mock, `structured` shows all fields readably in `full`, only the message in `text`, a JSON block in `raw`, and "Open raw JSON" opens the original; at the office, real agents' JSON replies read well (send examples to tune the rules).

### Phase 11: Releases (added 2026-11-21)

*Decided (2026-11-21):* no release per phase. **0.9.0 now** as an internal beta (everything up to Phase 10, for the office test and a few colleagues), **1.0.0** for customers once the office checklists pass, then a minor version per future phase (1.1.0, ...) and patch versions for fixes. Releases are made from `main` and published as GitHub Releases with the `.vsix` attached.

- [x] **T11.1** Package metadata: version `0.9.0`, display name "AgentCore Chat", description, categories AI/Chat, keywords, `repository`, `license` (**MIT, copyright Saumalya Sarkar**, chosen 2026-11-21), `LICENSE` file, `.vscodeignore` for `.github/**`. `vsce package` runs without warnings or prompts (it stops on a missing LICENSE or repository in CI).
- [x] **T11.2** CHANGELOG: `[Unreleased]` becomes `[0.9.0] - beta`, with an empty `[Unreleased]` above it.
- [x] **T11.3** CI (`.github/workflows/ci.yml`): on pull requests and pushes to `main`: lint, Python tests on 3.10 (oldest boto3 supports) and 3.13, JS tests, sample agent tests, and a `vsce package` check.
- [x] **T11.4** Release (`.github/workflows/release.yml`): on a `v*` tag, run CI, check the tag matches `package.json`, package the `.vsix`, and create a GitHub Release with that version's CHANGELOG section as notes (0.x versions marked as pre-release).
- [x] **T11.5** `RELEASING.md`: the steps (changelog, version, merge, tag) and how to install from a release.
- [x] **T11.8** *(2026-11-21, user request)* Minimum VS Code lowered from 1.147 to **1.109** (`engines.vscode ^1.109.0`, `@types/vscode ~1.109.0` so `vsce` accepts it). No API we use is newer than 1.109. Unverified: whether 1.109 supports `viewsContainers.secondarySidebar`; if not, VS Code puts the chat view in the Explorer instead (still works; drag it anywhere). Check on the office laptop.
- [ ] **T11.6** Merge everything into `main` (one pull request from `phase-11-release`; the user opens and merges it) and tag `v0.9.0`.
- [ ] **T11.7** *(later)* 1.0.0 after the office checklists (round 6e, T7.3, Phase 8-10 office checks) pass.

*Done when:* pushing `v0.9.0` produces a GitHub Release with an installable `.vsix`.

### Phase 12: Ask another agent with @ (added 2026-11-25)

User request: "call the agents from the chat box using @, like '@agent1, can you tell me ...'". *Decided (2026-11-25):* an `@agent` message goes **only to that agent**; the picker keeps its agent for messages without `@`; **one agent per message** (several `@`s, hand-offs between agents: later).

- [x] **T12.1** Mention pop-up (`media/webview/mentions.js`): typing `@` at the **start** of the message opens the agent list above the composer, filtered by what follows (`@bil`); ↑/↓ move, Enter or Tab insert `@name `, Esc closes it (without stopping a reply), a click picks. Rows are the agent picker's (shared from `picker.js`).
- [x] **T12.2** The mention is highlighted in the message box (a mirror layer behind the transparent textarea) and in the sent message's bubble.
- [x] **T12.3** Sending: a message starting with `@name` (optionally followed by `,` or `:`) goes to that agent with its own protocol (override, else detected, else HTTP); the agent receives the text **without** the mention; the reply shows that agent's name. Unknown `@name` or nothing after it: a notice, nothing sent. Retry resends to the same agent. The hint reads "@ agent · ⏎ send · ⇧⏎ new line".
- [x] **T12.4** Python: conversation state per **agent within a chat** (`sessions` keyed by session id + agent ARN), so agent1's A2A context or pending question isn't sent to agent2; New chat clears all of them (stopping each runtime session already works per agent).
- [x] **T12.5** Tests (Python session keying, panel: pop-up, keyboard, insertion, sending, unknown names, per-agent protocol, Retry), README and CHANGELOG.

*Known limit:* agents don't see each other's replies; "@agent2, summarise that" doesn't know what "that" is.

*Done 2026-11-25 (mock, user-tested).* *Done when:* with the mock, `@demo-http-strands hi` from a demo-a2a chat is answered by the HTTP agent over HTTP, the next plain message goes back to demo-a2a with its A2A context intact, and the pop-up works by keyboard and mouse.

### Phase 13: Tool calls as steps in the reply (added 2026-11-25)

User request: show agent text and tool calls in between while streaming, with a `BedrockAgentCoreApp` + Strands sample showing how, and a mock demo. Before this, a tool call was only a passing "Using tool: x" status line above the reply (removed at the end, once per tool name).

- [x] **T13.1** Python `tool_steps.py`: tool events become `tool` events for the panel `{id, name, input, status, result}` (`status` running / success / error). Understood shapes: `{"current_tool_use": {toolUseId, name, input}}` (Strands; partial input text ignored), `{"tool_result": {toolUseId, status, content}}` (the sample's), and Strands' own `{"message": ...}` events: assistant `toolUse` blocks (full input) and user `toolResult` blocks. Inputs and results are shortened (300 / 1000 characters). Steps are per call (`toolUseId`), so repeat calls of one tool show; an update is only sent when something changed. The old "Using tool" status line goes.
- [x] **T13.2** Panel: a reply is a sequence of text and tool steps in arrival order; each step sits where it happened and stays: spinner while running, then ✓ / ✕, "Used `current_time`" with a short input summary; expandable (native `<details>`, kept open across re-renders) to show the input and result. Steps still running when the reply ends are marked stopped. Copy reply copies only the text.
- [x] **T13.3** Mock keyword `tools` on the HTTP agent: text, then three tool calls (success, success via a Strands-style result message, error) with pauses, and text between them.
- [x] **T13.4** Sample agent (`samples/http-agent/agent.py`): forwards each call once when it starts, its full input when known, and its result (`tool_result`, shortened) from Strands' events; tests with a fake Strands agent read through the extension's parser.
- [x] **T13.5** Tests (Python parsing, HTTP protocol, panel steps), reply format guide, README, CHANGELOG.
- [x] **T13.6** *(added 2026-11-26, user request: "get the final output separate, like GitHub Copilot")* With tool calls, the reply splits into a **working** group (narration and steps up to the last tool call: open while the agent works, "Working... (2 tools so far)"; folded when done, "Used 3 tools · 1 failed") and the **final answer** below it (the text after the last tool call: the model's last turn). The group stays open if there's no answer or the user opened/closed it while working. Copy reply copies the final answer. Replies without tools are unchanged. Panel-only; nothing new needed from agents. Text after a tool call moves into the group if another tool call follows.

*Done 2026-11-26 (mock, user-tested; spinner slowed to 1.4s a turn).* *Done when:* the mock's `tools` reply shows text and three tool steps in order, which stay after the reply and expand to input and result; the sample's stream gives the same through the extension's parser.

### Phase 14: Chat history (added 2026-11-26)

User request: "history chat, save the chats based on session-id" (was deferred until approval). *Decided (2026-11-26):* **view and continue**: a past chat reopens with all its messages and can be continued under the same session id; a note says the agent may not remember it if its session ended (New chat stops AgentCore sessions). A2A agents get their `contextId` (and a pending question's task) back from the saved chat, so they usually can continue.

- [x] **T14.1** Python `history.py`: one JSON file per session id in a folder the extension passes (`AGENTCORE_HISTORY_DIR` = VS Code global storage `/history`): title (first prompt), agent(s), times, mock flag, and per turn the prompt as shown, agent, protocol, the reply (text and tool steps, as the panel shows them), how it ended (completed / cancelled / error) and its meta (footer, trace id, contextId...). Recorded by Python as it sends the events (no extra work for the panel), written atomically after each turn; newest 200 chats kept.
- [x] **T14.2** Bridge actions: `list_history` -> `history {items}` (newest first), `get_history {sessionId}` -> `history_chat {chat}`, `delete_history {sessionId | all}`, `resume_session {sessionId}` (restores each A2A agent's context into `sessions`).
- [x] **T14.3** Setting `agentcore.history` (default on): off = nothing new is saved (saved chats stay until deleted). The panel passes what it showed (`display`: prompt with @mention, agent name).
- [x] **T14.4** Panel: a **History** button in the toolbar opens the list in the chat area (title, agent, message count, date, MOCK tag; delete per chat, Clear all, Back). Opening one ends the current chat (as New chat does), shows the past messages (replies with their tool steps, footers, Copy, trace and raw JSON buttons; no Retry), adds the "may not remember" note, sets the picker to that chat's last agent if it still exists, and continues under the same session id.
- [x] **T14.5** Tests (Python history and bridge actions; panel: list, open, continue, delete, setting off), README, CHANGELOG. Privacy note in the README: chats are stored unencrypted on this computer; how to turn it off or clear it.

*Done 2026-11-26 (mock and tests). A continued chat sends the saved session id as runtimeSessionId; AgentCore starts a fresh runtime session under it if the old one was stopped.* *Done when:* with the mock, chats appear in History after a reply, reopen with their replies and tool steps, continue (an A2A agent gets the same contextId as before), and can be deleted; with the setting off nothing new is saved.

### Design review 3 (after Phase 14, 2026-11-26)

A scan for stale, redundant and oversized code after Phases 8-14. No unused functions were found; these were. User chose all except D2.

- [x] **R13** (D1) The mock's `tool` demo started a call but never finished it, so since Phase 13 it ended as "Stopped web_search". It now sends a result.
- [x] **R14** (S1) Remove the `TOOL` kind from `text_extract.py` (and its test): unused since `tool_steps.py` (Phase 13).
- [x] **R15** (S2) Remove the VS Code template leftovers: `test/extension.test.js` (a "Sample test"), `vsc-extension-quickstart.md`, `.vscode-test.mjs`, and the dev dependencies only they used (`@vscode/test-cli`, `@vscode/test-electron`, `@types/mocha`). `npm test` runs lint, the Python tests and the JS tests.
- [x] **R16** (S3) Unused `import re` in a test.
- [x] **R17** (S4) "Python 3.10+" in the README and the setup error (boto3 dropped 3.9; CI tests 3.10).
- [x] **R18** (S5) `python/tools/chat_cli.py` shows tool steps.
- [x] **R19** (S6) Section 7 no longer lists chat history as deferred.
- [x] **R20** (R1) `json_markdown.py` reuses `text_extract`'s list of text field names instead of keeping a copy that had to stay in the same order.
- [x] **R21** (R2) One keyboard-list helper (↑/↓ with wrap-around, highlighted row, scroll into view) shared by the agent picker and the @ list.
- [x] **R22** (A1) Split the two largest panel files by feature: chat history into `media/webview/history.js`, tool steps and the working group into `media/webview/steps.js`. No behaviour change; the panel tests guard it.
- **D2** *(skipped 2026-11-26, open idea)* A2A tool calls as steps. Strands' A2A server sends no tool events (only text), and A2A has no standard for them. Proposed if wanted later: agents add a data part with the HTTP shapes (`current_tool_use`, `tool_result`) to a `working` status update.

### Fix: agent read timeout and retries (2026-11-26)

User request: raise the URL timeout to 10 minutes. There was no timeout in our code; boto3's default 60 s **read** timeout applied, so an agent silent for over a minute failed with "Read timeout on endpoint URL". Found while checking: boto3 then **retried** the call up to 5 times in total, re-running the agent (and repeating what it did).

- [x] **F1** `bedrock-agentcore` client: `read_timeout=600` (gap between bytes, not total; AgentCore allows 15 min), connect timeout stays 60 s, other services keep boto3's defaults.
- [x] **F2** Same client: `retries={"total_max_attempts": 1}`: no automatic re-runs; a failed reply shows Retry. (`max_attempts` counts retries after the first try, so it would still have allowed one; a test that times out a real boto3 call checks it's sent once.)

*Unit-tested; to check at the office with an agent that takes over a minute.*

### Phase 15: Choose agents with the picker or with @ (added 2026-11-26)

User feedback: having both the picker and @ (Phase 12) is confusing; wants a toggle in the panel (if it keeps the look minimal), and expects choosing a different agent with @ to start a new chat. *Decided (2026-11-26):* one way at a time, switched with a small **@ button** in the composer; each chat is with one agent in both modes. Replaces Phase 12's "one message to another agent, same chat".

- [x] **T15.1** The @ button (next to the agent name, `aria-pressed`): off = **picker** (default; button muted; `@` is plain text, no pop-up, no highlight), on = **@ mode** (button highlighted). One switch for the whole panel: new chats, History and reloads keep it (webview state).
- [x] **T15.2** @ mode: the picker is **not shown** (user, 2026-11-26); the placeholder says which agent the chat is with ("Ask demo-a2a, or type @ for another agent..."). A message starting with `@agent` goes to that agent; if it's a **different agent than the chat's, a new chat starts** with that message as its first; the same agent just continues. Messages without @ go to the chat's agent. Placeholder and hint mention @.
- [x] **T15.3** Picker mode: exactly as before Phase 12 (switching agent starts a new chat).
- [x] **T15.5** *(user, 2026-11-26)* The History button is disabled while a reply is coming in (opening a saved chat ended the current one mid-reply).
- [x] **T15.6** *(user, 2026-11-26)* The "Earlier chat, continued..." note only for a reopened chat whose last message is more than 3 days old (`OLD_CHAT_MS`).
- [ ] **T15.4** Tests (both modes, the button, new chat on a different @ agent, same agent continues, remembered mode, History disabled while replying, the 3-day note), README, CHANGELOG. *Committed before the tests were updated (user asked, after manual testing); the Phase 12 @ tests still expect the old behaviour.*

## 5. Manual test checklist (mock mode)

Run in the Extension Development Host (F5) with `agentcore.mock = true` and **AgentCore: Show Logs** open. *(Updated in Phase 7 for rounds 6d and 6e.)*

1. **Panel:** the chat opens in the Secondary Side Bar with the MOCK badge; the profile tooltip shows `mock-user@example.com`, account and region. The agent list shows 3 agents and "1 non-chat agent (MCP/AGUI) hidden".
2. **A2A welcome:** `demo-a2a` is selected with the toggle on A2A (dot). The welcome card shows `A2A agent · v1.2.0`, two skills, and three example chips; a chip fills the composer without sending.
3. **HTTP:** pick `demo-http-strands` (generic chips). Send `hi`: dots and "Thinking", then streamed text, no doubled words, footer `HTTP · …s · completed`. Send `json please`: one-piece answer.
4. **A2A:** pick `demo-a2a`, send `hi`: footer `A2A · streamed · …` (auto streaming from the card). Send a second message: the raw log (`debugRawResponses` on) shows the same `contextId`. Set `a2aStreaming = off`: the footer loses "streamed".
5. **Markdown:** send `markdown please`: formatted while streaming; code-block Copy / Insert at Cursor / Open in New File; Insert into Terminal on the `bash` block puts both lines at the prompt without running them; the link opens only after VS Code asks.
6. **Reply actions:** hover a reply: Copy reply (raw Markdown), Copy trace ID (`1-…`), Open in CloudWatch (asks first).
7. **Stop and timer:** send `slow`: "Thinking · 1s, 2s"; press Esc: the reply ends "cancelled" and you can send at once. On A2A with streaming off, `slow` waits 3s and then answers in one piece.
8. **Two prompts back to back:** each reply stays in its own bubble.
9. **Input required:** on A2A send `need input`: the question and "waiting for your input"; the next message continues the same task.
10. **Errors and Retry:** send `error`: red error with Retry; Retry replaces it in place. Send `please fail` on A2A: error with Retry and a trace ID.
11. **Scrolling and ↑:** while a long reply streams, scroll up: the view stays and "Jump to latest" appears. In the empty composer, ↑ recalls your last prompt.
12. **New chat:** click +: the log shows `Stopped runtime session … on demo_…` (and a permission warning if you used `demo-unknown`).
13. **Backend restart:** `pkill -f bridge.py`: "Reconnecting…", then it works again; a reply in progress offers Retry.

## 6. Open questions

- **Q1** ~~Registry vs runtimes?~~ **Decided 2026-11-21:** list runtimes directly; drop the registry.
- **Q2** ~~HTTP body?~~ **Decided 2026-11-21:** `{"prompt": "..."}` (confirms A1).
- **Q3** ~~A2A streaming?~~ **Decided 2026-11-21:** unknown → default `message/send`; `agentcore.a2aStreaming` (default `false`) switches to `message/stream`. Both paths built and tested. *Update:* round 6e (T6.26) makes this automatic per agent from its Agent Card (`auto` default).
- **Q4** ~~Qualifier?~~ **Decided 2026-11-21:** no qualifier sent; AgentCore uses the DEFAULT endpoint.
- **Q5** ~~runtimeUserId?~~ **Decided 2026-11-21:** derive it from the SSO identity (see T1.5b, A10).

## 7. Out of scope here (next "swanky" round)
 *Also deferred (2026-11-21):* accessibility (T6.23: `role="log"`, a `role="status"` announcer, full keyboard reachability with focus rings, `aria-label`s, VoiceOver check) and the Open Chat keybinding; sending code context (selection / active file / "Ask AgentCore about selection").
Markdown + code highlighting with Copy/Insert buttons, codicons, editor-selection context (`@selection`), status bar agent switcher, chat history persistence, export to Markdown.
