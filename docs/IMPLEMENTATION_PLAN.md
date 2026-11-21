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

## 3. Message contracts (Python ⇄ extension ⇄ webview)

**Webview → Python** (the extension adds `settings` to every message):

```text
list_profiles   {}
list_agents     {profile}
invoke_agent    {requestId, profile, agentArn, protocol: "HTTP"|"A2A", prompt, sessionId}
cancel          {requestId}
reset_session   {sessionId}
settings (injected) {mock: bool, a2aStreaming: bool, debugRaw: bool}
```

**Python → webview** (everything is one JSON object per stdout line):

```text
profiles      {data: [str]}
agents        {data: [{name, arn, description, protocol: "HTTP"|"A2A"|null}]}
sso_expired   {profile, requestId?}
chunk         {requestId, text}                 # append to the bubble
status        {requestId, text}                 # small grey line: "working…", "tool: search"
done          {requestId, meta: {protocol, contentType, contextId?, taskId?, state?, ms}}
error         {requestId?, message}
raw           {requestId, line}                 # extension sends this to the Output channel only
bridge        {state: "ready"|"restarting"|"down"}
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

Target layout:

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
    test_http_protocol.py
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

- [ ] **T2.1** `sse.py::iter_sse_events(lines)`: standard framing (collect `data:` lines, join with `\n`, emit on a blank line or at end of stream; ignore `event:`/`id:`/`:comment`). Bytes are decoded as UTF-8 with `errors="replace"`.
- [ ] **T2.2** `text_extract.py::extract_text(obj)`: ordered rules for A3; returns `(text, "data"|"raw_event"|"other")`; non-text dicts → `(None, …)`.
- [ ] **T2.3** `http_protocol.build_payload(prompt)` → `json.dumps({HTTP_PROMPT_KEY: prompt}).encode()`; `accept="application/json, text/event-stream"`.
- [ ] **T2.4** `http_protocol.handle_response(resp, emitter, cancel)`:
  - SSE → for each event: try `json.loads`, else plain text → `extract_text` → `chunk`. Buffer `raw_event` text (A4) and flush it at the end only if nothing else was emitted.
  - JSON → `read()` the whole body, `extract_text`; also handle the Strands `AgentResult` shape (`{"role","content":[{"text"}]}`). If no text, emit the pretty JSON inside a fenced ```json block.
  - Other / unknown content type → decode and emit as-is.
  - `statusCode >= 400` → `error` with the body text.
- [ ] **T2.5** Tests: one fixture for each A3 shape plus a Strands "both" stream (expect no doubled text) and a JSON body.

### Phase 3: A2A protocol handler

- [ ] **T3.1** `a2a_protocol.SessionState` (`contextId`, `pendingTaskId`) in a dict keyed by `sessionId`; cleared on `reset_session`.
- [ ] **T3.2** `build_payload(prompt, state, streaming, rpc_id)` → JSON-RPC 2.0: `method` = `message/stream` or `message/send`; `params.message = {kind:"message", role:"user", messageId: uuid4, parts:[{kind:"text", text}], contextId?, taskId?}`.
- [ ] **T3.3** `parts_to_text(parts)`: `text` → text; `data` → fenced json; `file` → `📎 name (uri)`. Accepts both `kind` and `type` (A6).
- [ ] **T3.4** `handle_result(result)` by `kind` (A7):
  - `message` → chunk(parts)
  - `task` → artifacts' parts → chunk; if there are none, `status.message` → chunk; record `id`/`contextId`/`status.state`
  - `status-update` → `status.message` → **status** line (or chunk if `final` and nothing was emitted yet); state `failed` → error
  - `artifact-update` → chunk (respect `append`; the first artifact chunk of a new artifact starts with a blank-line separator)
- [ ] **T3.5** `handle_response(resp, …)`: SSE (stream) → each event is a JSON-RPC envelope → `handle_result`; JSON (send) → single envelope. `error` in the envelope → `error` with `code: message`.
- [ ] **T3.6** Update `SessionState` from the results (A8); `done.meta` includes `contextId`, `taskId`, `state`. If the state is `input-required`, add a status line "Agent is waiting for your input".
- [ ] **T3.7** Tests: send→Message, send→Task with artifacts, send→Task failed, stream with status+artifact updates, JSON-RPC error, legacy `type` parts, and contextId carried into the second payload.

### Phase 4: Agent listing & protocol detection

- [ ] **T4.1** `aws.list_agents(profile)`: `list_agent_runtimes` (paginate), keep `status == "READY"`, then `get_agent_runtime` per agent (thread pool, max 8) to read `protocolConfiguration.serverProtocol`. Only keep `HTTP`/`A2A`; `MCP`/`AGUI` are skipped and counted in a status note. Registry is **not** used (decided Q1).
- [ ] **T4.1b** Remove the `agentcore.registryId` setting from `package.json` and the `registryId` injection in `extension.js`.
- [ ] **T4.2** Mock listing: 3 agents (`demo-http-strands` HTTP, `demo-a2a` A2A, `demo-unknown` null).
- [ ] **T4.3** Cache the agent list per profile for 5 min; the refresh button skips the cache.

### Phase 5: Extension host (`extension.js`)

- [ ] **T5.1** New settings in `package.json`: `agentcore.mock` (bool, default `false`), `agentcore.a2aStreaming` (bool, `false`), `agentcore.debugRawResponses` (bool, `false`), `agentcore.region` (string, optional).
- [ ] **T5.2** Add `settings` to every message sent to Python.
- [ ] **T5.3** Output channel "AgentCore Chat": receives Python stderr and `raw` events (when debug is on); `raw` is never forwarded to the webview.
- [ ] **T5.4** Bridge supervision: on unexpected `exit`, post `bridge:restarting` and respawn with backoff (1 s, 3 s, 10 s; give up after 3 failures in 60 s → `bridge:down` plus an error notification with a "Show Logs" button).
- [ ] **T5.5** Kill the Python process on `deactivate` as well as on view dispose.

### Phase 6: Webview

- [ ] **T6.1** Protocol toggle: a segmented control `HTTP | A2A` next to the agent picker. Picking an agent sets it from `agent.protocol` when known. A manual override is saved per agent ARN in `vscode.setState`. The toggle shows an "auto" dot when it matches the detected protocol.
- [ ] **T6.2** Changing the protocol mid-conversation asks "Start new session?", since an A2A context can't be reused by HTTP.
- [ ] **T6.3** Request IDs: each send creates `requestId`; bubbles are stored in `Map<requestId, el>`; every incoming event is routed by ID (fixes the mixed-up replies).
- [ ] **T6.4** While streaming, the Send button becomes Stop and posts `cancel`; it goes back on `done`/`error`.
- [ ] **T6.5** `status` events render as a small muted line inside the bubble (the latest one replaces the previous).
- [ ] **T6.6** Footer on `done`: `A2A · 1.8s · task completed` (from `meta`).
- [ ] **T6.7** `bridge` events: a thin banner ("Reconnecting…" / "Backend stopped — Show Logs").
- [ ] **T6.8** "MOCK" badge in the header when `settings.mock` is on, so nobody confuses fake replies with real ones.

### Phase 7: Docs & verification

- [ ] **T7.1** README: settings table, how to use mock mode, how to capture a real response (`debugRawResponses`) and turn it into a fixture.
- [ ] **T7.2** `python/tests/README.md` + `npm run test:py` script (`python -m unittest discover python/tests`).
- [ ] **T7.3** Manual test checklist (below) run in the Extension Development Host with `agentcore.mock=true`.
- [ ] **T7.4** CHANGELOG entry.

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
- **Q3** ~~A2A streaming?~~ **Decided 2026-11-21:** unknown → default `message/send`; `agentcore.a2aStreaming` (default `false`) switches to `message/stream`. Both paths built and tested.
- **Q4** ~~Qualifier?~~ **Decided 2026-11-21:** no qualifier sent; AgentCore uses the DEFAULT endpoint.
- **Q5** ~~runtimeUserId?~~ **Decided 2026-11-21:** derive it from the SSO identity (see T1.5b, A10).

## 7. Out of scope here (next "swanky" round)

Markdown + code highlighting with Copy/Insert buttons, codicons, editor-selection context (`@selection`), status bar agent switcher, chat history persistence, export to Markdown.
