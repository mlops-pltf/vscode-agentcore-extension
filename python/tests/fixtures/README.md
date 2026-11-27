# Response fixtures

Each file is a raw agent response body, exactly as AgentCore returns it.

- `*.sse`: `text/event-stream` bodies (blank line between events)
- `*.json`: `application/json` bodies

Most of these are **hand-written from assumptions** (see `docs/IMPLEMENTATION_PLAN.md`, section 2).
When you get access to a real agent, turn on `agentcore.debugRawResponses`, copy the raw lines from
the "AgentCore Chat" Output channel into a new file here, and add a test case for it.
