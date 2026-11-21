"""A2A-protocol agents: JSON-RPC 2.0 request and reply interpretation.

Request (A5): a JSON-RPC call, "message/send" or (with the a2aStreaming
setting) "message/stream", carrying one user Message.

Reply: one JSON-RPC envelope (send) or an SSE stream of envelopes (stream),
read by response.py. Each envelope's "result" is one of (A7):
  message          the agent's direct answer
  task             a unit of work with a status and, when done, artifacts
  status-update    (stream) the task's state changed, maybe with a message
  artifact-update  (stream) a piece of an artifact, i.e. the answer text
Parts are text, data or file, tagged with "kind" (or "type" in older
versions, A6).

Conversation (A8): the server's contextId is sent back on every later turn
of the chat session; the taskId only while the task waits for input.
"""
import json
import uuid
from typing import Any, Dict, List, Optional

from agentcore.errors import AgentCoreError
from agentcore.events import Emitter
from agentcore.protocols.base import AgentProtocol, InvokeContext
from agentcore.response import AgentResponse

METHOD_SEND = "message/send"
METHOD_STREAM = "message/stream"

# Task states where the task is over or paused (A2A TaskState values)
FAILED_STATES = ("failed", "rejected")
WAITING_STATES = ("input-required", "auth-required")


class A2aProtocol(AgentProtocol):
    name = "A2A"

    def build_payload(self, ctx: InvokeContext) -> bytes:
        message = {
            "kind": "message",
            "role": "user",
            "messageId": str(uuid.uuid4()),
            "parts": [{"kind": "text", "text": ctx.prompt}],
        }
        if ctx.session_state.get("contextId"):
            message["contextId"] = ctx.session_state["contextId"]
        if ctx.session_state.get("pendingTaskId"):
            message["taskId"] = ctx.session_state["pendingTaskId"]

        method = METHOD_STREAM if ctx.settings.get("a2aStreaming") else METHOD_SEND
        request = {"jsonrpc": "2.0", "id": ctx.request_id, "method": method,
                   "params": {"message": message}}
        return json.dumps(request).encode("utf-8")

    def handle(self, response: AgentResponse, emitter: Emitter, ctx: InvokeContext) -> dict:
        turn = _Turn(emitter)
        for event in response.events():
            turn.envelope(event.value)

        _remember(ctx.session_state, turn)
        if turn.failure:
            raise AgentCoreError(turn.failure)
        if turn.state in WAITING_STATES:
            emitter.status("Agent is waiting for your input")

        meta = {"contentType": response.content_type, "taskState": turn.state}
        if turn.context_id:
            meta["contextId"] = turn.context_id
        if turn.task_id:
            meta["taskId"] = turn.task_id
        return meta


class _Turn:
    """What one reply has shown so far, so nothing is printed twice."""

    def __init__(self, emitter: Emitter):
        self.emitter = emitter
        self.context_id: Optional[str] = None
        self.task_id: Optional[str] = None
        self.state: Optional[str] = None
        self.failure: Optional[str] = None
        self.emitted = False
        self.artifacts_seen: Dict[str, bool] = {}

    def chunk(self, text: str) -> None:
        if text:
            self.emitter.chunk(text)
            self.emitted = True

    def envelope(self, value: Any) -> None:
        if isinstance(value, str):
            self.chunk(value)  # not JSON-RPC at all: show what we got
            return
        if not isinstance(value, dict):
            return
        if "error" in value:
            error = value["error"] or {}
            self.failure = f"A2A error {error.get('code', '?')}: {error.get('message', 'unknown error')}"
            return
        result = value.get("result", value)  # some servers stream bare results
        if isinstance(result, dict):
            self.result(result)

    def result(self, result: dict) -> None:
        kind = _kind(result)
        self.context_id = result.get("contextId") or self.context_id
        if kind == "message":
            self.task_id = result.get("taskId") or self.task_id
            self.chunk(parts_to_text(result.get("parts")))
        elif kind == "task":
            self.task_id = result.get("id") or self.task_id
            self.task(result)
        elif kind == "status-update":
            self.task_id = result.get("taskId") or self.task_id
            self.status_update(result)
        elif kind == "artifact-update":
            self.task_id = result.get("taskId") or self.task_id
            self.artifact(result.get("artifact") or {}, append=result.get("append", False))
        else:
            self.chunk("```json\n" + json.dumps(result, indent=2) + "\n```")

    def task(self, task: dict) -> None:
        # A stream may end with a full Task snapshot: skip artifacts already streamed
        for artifact in task.get("artifacts") or []:
            if artifact.get("artifactId") not in self.artifacts_seen:
                self.artifact(artifact, append=False)
        self.set_state(task.get("status") or {}, final=True)

    def status_update(self, update: dict) -> None:
        self.set_state(update.get("status") or {}, final=update.get("final", False))

    def set_state(self, status: dict, final: bool) -> None:
        state = status.get("state")
        if state:
            self.state = state
        text = parts_to_text((status.get("message") or {}).get("parts"))
        if state in FAILED_STATES:
            self.failure = f"Agent task {state}" + (f": {text}" if text else "")
        elif state in WAITING_STATES or (final and not self.emitted):
            # The agent's question, or its only answer: show it as reply text
            self.chunk(("\n\n" if self.emitted else "") + text if text else "")
        elif text:
            self.emitter.status(text)

    def artifact(self, artifact: dict, append: bool) -> None:
        artifact_id = artifact.get("artifactId") or "artifact"
        text = parts_to_text(artifact.get("parts"))
        new_artifact = artifact_id not in self.artifacts_seen
        self.artifacts_seen[artifact_id] = True
        if new_artifact and not append and self.emitted and text:
            text = "\n\n" + text  # separate multiple artifacts
        self.chunk(text)


def parts_to_text(parts: Optional[List[dict]]) -> str:
    """Render A2A parts: text as-is, data as a JSON block, files as a reference."""
    pieces = []
    for part in parts or []:
        kind = part.get("kind") or part.get("type")
        if kind == "text":
            pieces.append(part.get("text", ""))
        elif kind == "data":
            pieces.append("\n```json\n" + json.dumps(part.get("data"), indent=2) + "\n```\n")
        elif kind == "file":
            file = part.get("file") or {}
            where = file.get("uri") or ("embedded" if file.get("bytes") else "no content")
            pieces.append(f"\n📎 {file.get('name') or 'file'} ({where})\n")
    return "".join(pieces)


def _kind(result: dict) -> Optional[str]:
    """The result's kind; older servers omit "kind", so infer it from the fields."""
    if result.get("kind"):
        return result["kind"]
    if "artifact" in result:
        return "artifact-update"
    if "status" in result and "final" in result:
        return "status-update"
    if "status" in result and "id" in result:
        return "task"
    if "parts" in result and "role" in result:
        return "message"
    return None


def _remember(state: dict, turn: _Turn) -> None:
    """Carry the conversation into the next turn (A8)."""
    if turn.context_id:
        state["contextId"] = turn.context_id
    if turn.state in WAITING_STATES and turn.task_id:
        state["pendingTaskId"] = turn.task_id
    else:
        state.pop("pendingTaskId", None)
