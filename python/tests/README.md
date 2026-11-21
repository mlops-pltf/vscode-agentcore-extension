# Tests

All of the backend's logic is in Python, so most behaviour is tested here. No AWS account is needed:
AWS calls are checked with botocore's `Stubber`, and the bridge runs against the built-in mock.

## Running

From the repository root, with the dev venv set up (see the main README):

```
npm run test:py
# or directly:
.venv/bin/python -m unittest discover -s python/tests -t python
# one file or one test:
.venv/bin/python -m unittest discover -s python/tests -t python -p test_cards.py
.venv/bin/python -m unittest discover -s python/tests -t python -k markdown
```

`-t python` makes `python/` the import root, so tests import `agentcore` and `tests.helpers`.

## What is where

| File | Covers |
|---|---|
| `test_sse.py` | SSE framing: events, multi-line data, comments, CRLF |
| `test_text_extract.py` | Pulling reply text out of the many HTTP event shapes (Strands, raw Bedrock, delta and generic shapes, plain strings) |
| `test_response.py` | `AgentResponse`: content types, error statuses, cancel, raw logging; session state, mock choice, stray prints |
| `test_protocol_http.py` | HTTP agents: payload, streamed and single-body replies, sniffing, `[DONE]`, tool status, no doubled text |
| `test_protocol_a2a.py` | A2A agents: JSON-RPC payload, Message/Task/status/artifact results, context and input-required, errors |
| `test_agents.py` | Agent listing: chat-only filter, cache, region, `ListAgentRuntimes`/`GetAgentRuntime` via Stubber |
| `test_cards.py` | Agent Cards: parsing, cache, permission errors, automatic streaming choice |
| `test_tracing_sessions_identity.py` | Trace ids and the `traceId` fallback, stopping sessions, caller identity |
| `test_bridge_smoke.py` | `bridge.py` as a subprocess, like the extension runs it: concurrent replies, cancel, A2A conversations, new actions |

`helpers.py` has a recording emitter, fake responses and an `InvokeContext` builder.

## Fixtures

`fixtures/http/` and `fixtures/a2a/` hold raw response bodies. Most are written from documented or
assumed shapes (see `docs/IMPLEMENTATION_PLAN.md`, section 2); replace or add real ones as you capture
them (see [fixtures/README.md](fixtures/README.md)).

## JavaScript tests

The chat panel and the extension host are tested with `npm run test:js` (Node's built-in test runner
and jsdom; files in `test/node/`). The panel tests start this Python backend in mock mode, so they also
need the dev venv.
