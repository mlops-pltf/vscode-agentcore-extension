"""Fake AgentCore runtime for local development without AWS access.

Exposes the same functions as aws.py. Responses are raw bytes in the shapes
we *assume* real agents send (docs/IMPLEMENTATION_PLAN.md section 2), so they
flow through exactly the same parsing code as real responses.

Keywords in the prompt pick a scenario:
  json   HTTP agent answers with a single application/json body
  slow   one second between lines, or 3 seconds before a one-piece answer
         (A2A message/send, HTTP json); to try cancelling and the timer
  error  the agent container fails (RuntimeClientError)
  tool      the agent reports a tool call before answering
  input     A2A task stops in the input-required state (answer it to continue)
  fail      A2A task ends in the failed state
  rpcerror  A2A agent returns a JSON-RPC error
  markdown  the reply is a Markdown sample (headings, lists, code, links)
"""
import json
import threading
import uuid
from typing import List, Optional

from agentcore import aws
from agentcore.errors import AgentCoreError

FAST_DELAY = 0.04
SLOW_DELAY = 1.0

MARKDOWN_SAMPLE = """## Deploying the demo agent

Here is how to **deploy** it with *one* command, plus a few `settings` worth knowing.

1. Read the [AgentCore guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html).
2. Configure the agent:
   - pick a region, e.g. `eu-central-1`
   - pick an execution role
3. Launch it.

```bash
agentcore configure --entrypoint agent.py
agentcore launch
```

The handler can stay this small:

```python
def handler(payload):
    return {"result": payload["prompt"].upper()}
```

> Tip: run `agentcore status` to check the endpoint.

---

Links that are not web links stay plain text: [local file](file:///etc/hosts)."""


class FakeBody:
    """Stands in for botocore's StreamingBody."""

    def __init__(self, lines: List[bytes], delay: float):
        self._lines = lines
        self._delay = delay
        self._closed = threading.Event()

    def iter_lines(self, chunk_size: int = 1024, keepends: bool = False):
        for line in self._lines:
            # wait() returns early if close() is called, so cancel is instant
            if self._closed.wait(self._delay):
                return
            yield line

    def read(self) -> bytes:
        # A one-piece answer arrives after the delay; close() during the wait
        # fails the read, like reading a closed stream
        if self._closed.wait(self._delay):
            raise ValueError("read of closed file")
        return b"\n".join(self._lines)

    def close(self) -> None:
        self._closed.set()


def list_profiles():
    # Reading ~/.aws/config needs no network, so show the real profiles
    return aws.list_profiles()


_MOCK_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/"


def list_agents(profile: str, region: Optional[str] = None) -> List[dict]:
    return [
        {"name": "demo-http-strands", "arn": _MOCK_ARN + "demo_http_strands-Ab12Cd34Ef",
         "description": "Mock Strands agent over HTTP (SSE streaming)", "protocol": "HTTP"},
        {"name": "demo-a2a", "arn": _MOCK_ARN + "demo_a2a-Gh56Ij78Kl",
         "description": "Mock agent speaking A2A (JSON-RPC)", "protocol": "A2A"},
        {"name": "demo-unknown", "arn": _MOCK_ARN + "demo_unknown-Mn90Op12Qr",
         "description": "Mock agent whose protocol could not be read", "protocol": None},
        {"name": "demo-mcp-tools", "arn": _MOCK_ARN + "demo_mcp_tools-St34Uv56Wx",
         "description": "Mock MCP server (not a chat agent, should be hidden)", "protocol": "MCP"},
    ]


def get_runtime_user_id(profile: str) -> str:
    return "mock-user@example.com"


def invoke(profile: str, agent_arn: str, session_id: str, payload: bytes,
           accept: str, user_id: Optional[str] = None, region: Optional[str] = None) -> dict:
    request = json.loads(payload)
    is_a2a = request.get("jsonrpc") == "2.0"
    prompt = _a2a_prompt(request) if is_a2a else request.get("prompt", "")
    words = prompt.lower()

    if is_a2a and "rpcerror" in words:
        return _json({"jsonrpc": "2.0", "id": request.get("id"),
                      "error": {"code": -32603, "message": "mock internal error"}})
    if "error" in words:
        raise AgentCoreError("RuntimeClientError: mock agent raised ValueError('something broke')")

    delay = SLOW_DELAY if "slow" in words else FAST_DELAY
    one_piece_delay = 3 * SLOW_DELAY if "slow" in words else 0
    reply = (f"You said: {prompt!r}. This is a mock reply from "
             f"{agent_arn.rsplit('/', 1)[-1]}, streamed word by word.")
    if "markdown" in words:
        reply = MARKDOWN_SAMPLE
        if delay == FAST_DELAY:
            delay = FAST_DELAY / 4  # a long reply; still visibly streaming

    if is_a2a:
        task_id = request.get("params", {}).get("message", {}).get("taskId")
        if task_id:
            reply = f"Thanks, continuing task {task_id}. " + reply
        if request.get("method") == "message/stream":
            return _sse(_a2a_stream_events(request, reply, words), delay)
        return _json(_a2a_send_result(request, reply, words), one_piece_delay)
    if "json" in words:
        return _json({"result": {"role": "assistant", "content": [{"text": reply}]}}, one_piece_delay)
    return _sse(_http_stream_events(reply, words), delay)


# ---------- response builders ----------

def _sse(events: List[dict], delay: float) -> dict:
    lines = []
    for event in events:
        lines.append(b"data: " + json.dumps(event).encode("utf-8"))
        lines.append(b"")  # blank line ends an SSE event
    return {"contentType": "text/event-stream", "statusCode": 200,
            "response": FakeBody(lines, delay)}


def _json(obj: dict, delay: float = 0) -> dict:
    return {"contentType": "application/json", "statusCode": 200,
            "response": FakeBody([json.dumps(obj).encode("utf-8")], delay)}


# ---------- HTTP (Strands-style stream, assumptions A3/A4) ----------

def _http_stream_events(reply: str, words: str) -> List[dict]:
    events = [{"init_event_loop": True}, {"start": True}]
    if "tool" in words:
        events.append({"current_tool_use": {"toolUseId": "tool-1", "name": "web_search",
                                            "input": {"query": "agentcore"}}})
    for token in _tokens(reply):
        # Strands emits the raw Bedrock event AND a "data" event for each token
        events.append({"event": {"contentBlockDelta": {"delta": {"text": token}}}})
        events.append({"data": token})
    events.append({"result": reply})
    return events


# ---------- A2A (JSON-RPC 2.0, assumptions A5-A8) ----------

def _a2a_prompt(request: dict) -> str:
    parts = request.get("params", {}).get("message", {}).get("parts", [])
    return " ".join(p.get("text", "") for p in parts if p.get("kind", p.get("type")) == "text")


def _envelope(request: dict, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request.get("id"), "result": result}


def _ids(request: dict):
    message = request.get("params", {}).get("message", {})
    context_id = message.get("contextId") or f"ctx-{uuid.uuid4()}"
    task_id = message.get("taskId") or f"task-{uuid.uuid4()}"
    return context_id, task_id


def _agent_message(text: str, context_id: str, task_id: str) -> dict:
    return {"kind": "message", "role": "agent", "messageId": str(uuid.uuid4()),
            "contextId": context_id, "taskId": task_id,
            "parts": [{"kind": "text", "text": text}]}


def _a2a_send_result(request: dict, reply: str, words: str) -> dict:
    context_id, task_id = _ids(request)
    task = {"kind": "task", "id": task_id, "contextId": context_id}
    if "input" in words:
        question = "Which environment should I use: dev or prod?"
        task["status"] = {"state": "input-required",
                          "message": _agent_message(question, context_id, task_id)}
    elif "fail" in words:
        task["status"] = {"state": "failed",
                          "message": _agent_message("Could not reach the deployment API.", context_id, task_id)}
    else:
        task["status"] = {"state": "completed"}
        task["artifacts"] = [{"artifactId": "artifact-1", "name": "response",
                              "parts": [{"kind": "text", "text": reply}]}]
    return _envelope(request, task)


def _a2a_stream_events(request: dict, reply: str, words: str) -> List[dict]:
    context_id, task_id = _ids(request)

    def status(state: str, text: Optional[str] = None, final: bool = False) -> dict:
        update = {"kind": "status-update", "taskId": task_id, "contextId": context_id,
                  "status": {"state": state}, "final": final}
        if text:
            update["status"]["message"] = _agent_message(text, context_id, task_id)
        return _envelope(request, update)

    events = [
        _envelope(request, {"kind": "task", "id": task_id, "contextId": context_id,
                            "status": {"state": "submitted"}}),
        status("working", "Thinking..."),
    ]
    if "tool" in words:
        events.append(status("working", "Calling tool: web_search"))
    if "input" in words:
        events.append(status("input-required", "Which environment should I use: dev or prod?", final=True))
        return events
    if "fail" in words:
        events.append(status("failed", "Could not reach the deployment API.", final=True))
        return events

    tokens = _tokens(reply)
    for i, token in enumerate(tokens):
        events.append(_envelope(request, {
            "kind": "artifact-update", "taskId": task_id, "contextId": context_id,
            "artifact": {"artifactId": "artifact-1", "name": "response",
                         "parts": [{"kind": "text", "text": token}]},
            "append": i > 0, "lastChunk": i == len(tokens) - 1,
        }))
    events.append(status("completed", final=True))
    return events


def _tokens(text: str) -> List[str]:
    # Split into word-sized tokens that keep their trailing space, like a model stream
    words = text.split(" ")
    return [w + " " for w in words[:-1]] + [words[-1]]
