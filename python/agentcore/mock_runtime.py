"""Fake AgentCore runtime for local development without AWS access.

Exposes the same functions as aws.py. Responses are raw bytes in the shapes
we *assume* real agents send (docs/IMPLEMENTATION_PLAN.md section 2), so they
flow through exactly the same parsing code as real responses.

Keywords in the prompt pick a scenario:
  json   HTTP agent answers with a single application/json body
  slow   one second between lines (to try cancelling)
  error  the agent container fails (RuntimeClientError)
  tool   the agent reports a tool call before answering
  input  A2A task stops in the input-required state
"""
import json
import threading
import uuid
from typing import List, Optional

from agentcore import aws
from agentcore.aws import AgentCoreError

FAST_DELAY = 0.04
SLOW_DELAY = 1.0


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
        return b"\n".join(self._lines)

    def close(self) -> None:
        self._closed.set()


def list_profiles():
    # Reading ~/.aws/config needs no network, so show the real profiles
    return aws.list_profiles()


def get_runtime_user_id(profile: str) -> str:
    return "mock-user@example.com"


def invoke(profile: str, agent_arn: str, session_id: str, payload: bytes,
           accept: str, user_id: Optional[str] = None) -> dict:
    request = json.loads(payload)
    is_a2a = request.get("jsonrpc") == "2.0"
    prompt = _a2a_prompt(request) if is_a2a else request.get("prompt", "")
    words = prompt.lower()

    if "error" in words:
        raise AgentCoreError("RuntimeClientError: mock agent raised ValueError('something broke')")

    delay = SLOW_DELAY if "slow" in words else FAST_DELAY
    reply = (f"You said: {prompt!r}. This is a mock reply from "
             f"{agent_arn.rsplit('/', 1)[-1]}, streamed word by word.")

    if is_a2a:
        if request.get("method") == "message/stream":
            return _sse(_a2a_stream_events(request, reply, words), delay)
        return _json(_a2a_send_result(request, reply, words))
    if "json" in words:
        return _json({"result": {"role": "assistant", "content": [{"text": reply}]}})
    return _sse(_http_stream_events(reply, words), delay)


# ---------- response builders ----------

def _sse(events: List[dict], delay: float) -> dict:
    lines = []
    for event in events:
        lines.append(b"data: " + json.dumps(event).encode("utf-8"))
        lines.append(b"")  # blank line ends an SSE event
    return {"contentType": "text/event-stream", "statusCode": 200,
            "response": FakeBody(lines, delay)}


def _json(obj: dict) -> dict:
    return {"contentType": "application/json", "statusCode": 200,
            "response": FakeBody([json.dumps(obj).encode("utf-8")], 0)}


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
