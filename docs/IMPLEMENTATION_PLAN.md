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
| A12 | `traceId` accepts a W3C-style 32-hex trace id | Med: format not documented in what we found | Sent as-is; on `ValidationException` retry once without it (T6.28) |
| A13 | CloudWatch GenAI Observability lives at `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#gen-ai-observability` | Med: no deep link per trace found | Opens the dashboard only; one constant to fix |
| A14 | AgentCore's agent card follows the A2A spec: `skills[].{name,description,examples}`, `capabilities.streaming`, `version` | Low | Missing fields are optional; fixture from a real card when available |

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

Goal: features specific to AgentCore that generic chat tools don't have, as selling points. Logic stays in Python; every new AWS call degrades gracefully if the role lacks the permission (logged, never blocks chatting). APIs confirmed in boto3 1.42.97: `get_agent_card`, `stop_runtime_session`.

- [ ] **T6.25** Agent Card (Python). New bridge action `get_agent_card {profile, agentArn}` → event `agent_card {agentArn, card}` where `card = {name, description, version, skills: [{name, description, examples}], streaming}` (or `null` plus a note). Only for A2A agents, cached per agent like the agent list. `AccessDenied` (needs `bedrock-agentcore:GetAgentCard`) → `card: null`. The mock returns a card with skills and `streaming: true`.
- [ ] **T6.26** Use the card. The empty state (T6.17) shows the agent's **skills**, with their examples as suggestion chips (falling back to generic chips) and the version. **Automatic A2A streaming:** `agentcore.a2aStreaming` becomes `auto` (default) / `on` / `off`. With `auto`, Python uses `message/stream` when the cached card says `capabilities.streaming`, otherwise `message/send`. *(Resolves Q3 per agent instead of globally.)*
- [ ] **T6.27** Free server resources: when a session ends (New chat, agent change, protocol switch), Python calls `stop_runtime_session` for every agent that session used (profile, region and ARN recorded at invoke time), in the background. Errors (`AccessDenied`, session already gone) are logged only. Needs `bedrock-agentcore:StopRuntimeSession`. Stop (cancel) does *not* end the session, so the user can continue.
- [ ] **T6.28** Trace ID per reply: Python generates a trace id for every invoke, sends it as `traceId`, and returns it in `done.meta.traceId`. The reply's actions get **Copy trace ID** and **Open CloudWatch** (GenAI Observability page for the region, opened through the extension). If AgentCore rejects the id format (`ValidationException`), it retries once without it and logs a warning (A12).
- [ ] **T6.29** Identity at a glance: new bridge action `whoami {profile}` → `identity {profile, account, region, user}` (from `sts:GetCallerIdentity`, already used for `runtimeUserId`; cached). Shown as the profile picker's tooltip and in the Output channel. The mock returns a fake identity.

*Done when:* with the mock, an A2A agent shows its skills as chips and streams automatically, New chat logs a stopped session, each reply can copy its trace id and open CloudWatch, and the profile tooltip shows the account, region and user. The Python tests cover the card parsing, auto-streaming choice, stop-session bookkeeping and the trace-id fallback.

### Phase 7: Docs & verification

- [ ] **T7.1** README: required IAM permissions (`InvokeAgentRuntime`, `InvokeAgentRuntimeForUser`, `ListAgentRuntimes`, `GetAgentRuntime`, and the optional `GetAgentCard`, `StopRuntimeSession`), settings table, how to use mock mode, how to capture a real response (`debugRawResponses`) and turn it into a fixture, and a tip on where the chat lives (right, as a tab next to Copilot Chat), moving it to the left (right-click → Move View, or drag) and back (right-click → Reset Location).
- [ ] **T7.2** `python/tests/README.md` + `npm run test:py` script (`python -m unittest discover python/tests`).
- [ ] **T7.3** Manual test checklist (below) run in the Extension Development Host with `agentcore.mock=true`.
- [ ] **T7.4** CHANGELOG entry.
- [ ] **T7.5** Add `python/tests/**`, `python/tools/**` and `**/__pycache__/**` to `.vscodeignore` so tests and fixtures are not shipped in the `.vsix`.

## 5. Manual test checklist (mock mode)

1. Open the panel → the mock profile list loads, with the MOCK badge visible.
2. Pick `demo-http-strands` → the toggle switches to HTTP (auto). Send "hi" → streamed text, no doubled tokens, footer shows HTTP.
3. Send "json please" → single JSON-response path.
4. Pick `demo-a2a` → the toggle switches to A2A. Send "hi" → task artifact text; send a second message → the raw log shows the same `contextId`.
5. Turn on `a2aStreaming` → status lines appear, then streamed artifact text.
6. Send "slow" and press Stop → the bubble ends with "cancelled" and you can send again right away.
7. Send two prompts back to back → each reply stays in its own bubble.
8. Send "input" on A2A → the "waiting for your input" status shows and the next reply continues the same task.
9. Send "error" → a red error, and the UI recovers.
10. Kill the Python process (`pkill -f bridge.py`) → "Reconnecting…", then it works again.

## 6. Open questions

- **Q1** ~~Registry vs runtimes?~~ **Decided 2026-11-21:** list runtimes directly; drop the registry.
- **Q2** ~~HTTP body?~~ **Decided 2026-11-21:** `{"prompt": "..."}` (confirms A1).
- **Q3** ~~A2A streaming?~~ **Decided 2026-11-21:** unknown → default `message/send`; `agentcore.a2aStreaming` (default `false`) switches to `message/stream`. Both paths built and tested. *Update:* round 6e (T6.26) makes this automatic per agent from its Agent Card (`auto` default).
- **Q4** ~~Qualifier?~~ **Decided 2026-11-21:** no qualifier sent; AgentCore uses the DEFAULT endpoint.
- **Q5** ~~runtimeUserId?~~ **Decided 2026-11-21:** derive it from the SSO identity (see T1.5b, A10).

## 7. Out of scope here (next "swanky" round)
 *Also deferred (2026-11-21):* accessibility (T6.23: `role="log"`, a `role="status"` announcer, full keyboard reachability with focus rings, `aria-label`s, VoiceOver check) and the Open Chat keybinding; chat history (until the extension is approved), and sending code context (selection / active file / "Ask AgentCore about selection").
Markdown + code highlighting with Copy/Insert buttons, codicons, editor-selection context (`@selection`), status bar agent switcher, chat history persistence, export to Markdown.
