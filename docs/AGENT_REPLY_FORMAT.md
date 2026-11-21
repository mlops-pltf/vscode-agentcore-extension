# Agent reply format

What an agent on Amazon Bedrock AgentCore Runtime should send so the **AgentCore Chat** extension shows its reply properly. AgentCore passes the agent's response through unchanged, so this is about what *your agent* writes.

**Short version:** build HTTP agents with `BedrockAgentCoreApp` and stream `{"data": "<text>"}` events (see the [sample agent](../samples/http-agent/)), and build A2A agents with the official A2A SDK (or Strands' A2A server). Write answers in Markdown.

## HTTP agents

**Request** the agent receives: `POST /invocations` with the body

```json
{"prompt": "<the user's message>"}
```

The chat's session id comes in the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (in `BedrockAgentCoreApp`: `context.session_id`). It stays the same for the whole chat and changes on **New chat**.

### Recommended: stream Server-Sent Events

`Content-Type: text/event-stream`. Each event is one `data:` line with JSON, followed by a blank line:

```
data: {"current_tool_use": {"name": "web_search"}}

data: {"data": "Hello"}

data: {"data": " there, here is the answer."}

```

With `BedrockAgentCoreApp`, an `async def` entrypoint that `yield`s dicts produces exactly this:

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
async def invoke(payload, context):
    async for event in my_agent.stream_async(payload["prompt"]):   # e.g. a Strands Agent
        if isinstance(event.get("data"), str):
            yield {"data": event["data"]}
        elif isinstance(event.get("current_tool_use"), dict):
            yield {"current_tool_use": {"name": event["current_tool_use"].get("name")}}
```

Forwarding only these two keys is cleaner than yielding raw Strands events, which carry Python objects that don't serialize to JSON cleanly.

| Event | What the chat does |
|---|---|
| `{"data": "<piece of text>"}` | Shows it at once. **The main one.** |
| `"<piece of text>"` (a JSON string) | Shows it at once. |
| `{"current_tool_use": {"name": "x"}}` | Status line "Using tool: x" (once per tool). |
| `{"result": "<full text>"}` or `{"result": {"role": "assistant", "content": [{"text": "..."}]}}` | The complete answer. **Used only if nothing was streamed**, so it never repeats. |
| `{"event": {"contentBlockDelta": {"delta": {"text": "..."}}}}` | Raw Bedrock events; used only if no `data` events came (Strands sends both). |
| `{"delta": {"text": "..."}}`, `{"text": ...}`, `{"content": ...}`, `{"output": ...}`, `{"response": ...}`, `{"answer": ...}`, `{"completion": ...}` | Streamed text as well. |
| `{"error": "<what went wrong>", "error_type": "ValueError"}` | Ends the reply with a red error ("Agent error: ValueError: ...") and Retry; text already shown stays. `BedrockAgentCoreApp` sends this by itself when the entrypoint raises. |
| `[DONE]` | Ignored. |
| Anything else (lifecycle events and so on) | Skipped. |

**Rules for streaming:**

- **Send only the new piece of text in each event**, never the whole text so far, or the reply shows up repeated.
- **Keep spaces and newlines inside the pieces** (`" there,"`, `"\n\n## Heading"`): pieces are joined exactly as sent.
- **JSON-encode each event**, so newlines in a piece stay on one `data:` line as `\n`.

### Also fine: one answer, not streamed

`Content-Type: application/json` (in `BedrockAgentCoreApp`: return a value instead of yielding), any of:

```json
{"result": "The answer"}
{"response": "The answer"}
{"result": {"role": "assistant", "content": [{"text": "The answer"}]}}
"The answer"
```

A `text/plain` body is shown as is.

**Extra fields are shown too** (setting `agentcore.jsonReplies`, default `full`): the main text comes first, then every other field as readable Markdown, so agents don't need to squeeze everything into one message:

```json
{"message": "Deployed.", "status": "success",
 "sources": [{"title": "Runbook", "url": "https://..."}], "next_steps": ["Run smoke tests"]}
```

becomes "Deployed.", then **Status:** success, a *Sources* table and a *Next steps* list. Single values become `Key: value` lines, lists of single values bullets, lists of similar objects tables, nested objects a labelled section (deeper than three levels: a JSON block). Plumbing fields such as `role`, `usage`, `metrics`, token counts and trace/session ids are hidden (more with `agentcore.jsonHiddenFields`), and the reply's **Open raw JSON** button shows the original. In a stream, the same applies to the extra fields of the **final** event (`result` or the assistant `message`), shown after the streamed text; per-token events are never expanded.

### Both ways

- **Markdown is rendered**: headings, **bold**/*italic*, lists (nested), tables, quotes, links (http/https), and fenced code blocks with a language (`` ```python ``), which get Copy / Insert / New File buttons (and Insert into Terminal for shell code).
- **Errors**: an HTTP status of 400 or more is shown as a red error with the response body; keep that body short and readable.

## A2A agents

Follow the A2A protocol (JSON-RPC 2.0). The chat sends `message/send`, or `message/stream` when your Agent Card says you stream (setting `agentcore.a2aStreaming = auto`).

| You return | Shown as |
|---|---|
| A **Task** with `status.state: "completed"` and `artifacts[].parts` like `{"kind": "text", "text": "..."}` | The reply text (several artifacts are separated by a blank line). |
| A **Message** with text `parts` | The reply text. |
| Streaming: `status-update` with a message | A status line (e.g. "Searching docs..."). |
| Streaming: `artifact-update` pieces with `append: true` | Text streamed in as it arrives. |
| `status.state: "input-required"` with your question in `status.message` | Your question as the reply, plus "Agent is waiting for your input"; the user's next message continues the same task. |
| `"failed"` / `"rejected"` with the reason in `status.message` | A red error with that reason, and Retry. |
| A JSON-RPC `error` | "A2A error <code>: <message>". |
| `{"kind": "data", "data": {...}}` parts | Readable Markdown, like JSON replies above (or a JSON block with `jsonReplies = raw`). |
| `{"kind": "file", ...}` parts | "📎 name (uri)". |

- **Conversation**: keep the same `contextId` across turns; the chat sends it back on every message.
- **Agent Card**: set `capabilities.streaming: true` if you stream, and give each skill a `name`, a `description` and 1-3 `examples`. The examples become the suggestion chips on the chat's welcome screen.

## Checking a real agent

Turn on `agentcore.debugRawResponses` in VS Code, send a message, and open **AgentCore: Show Logs**: the `[raw ...]` lines show exactly what your agent sent. If a reply shows up as a JSON block or looks wrong, those lines are what's needed to fix either the agent or the extension (they can become a test fixture: see the main README).
