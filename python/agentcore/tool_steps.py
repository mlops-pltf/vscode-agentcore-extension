"""Tool calls in an HTTP agent's stream, as steps for the chat (Phase 13).

The chat shows each tool call inside the reply, where it happened:
running, then done or failed, with a short input and result. This module
turns stream events into step updates:

    {"id": "<toolUseId>", "name": "current_time", "status": "running"|"success"|"error",
     "input": "<short JSON>", "result": "<short text>"}       (input/result only when known)

Shapes understood (see docs/AGENT_REPLY_FORMAT.md):
  {"current_tool_use": {"toolUseId", "name", "input"}}       Strands, and the sample agent
  {"tool_result": {"toolUseId", "status", "content"}}        the sample agent
  {"message": {"role": "assistant", "content": [{"toolUse": {...}}]}}     Strands' own events
  {"message": {"role": "user", "content": [{"toolResult": {...}}]}}
"""
import json
from typing import Any, List, Optional

MAX_INPUT = 300
MAX_RESULT = 1000


def _short(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _input(value: Any) -> Optional[str]:
    """A tool's input, if complete. While the model writes it, Strands sends
    unfinished JSON text; that is skipped until it parses."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if value is None or value == {} or value == "":
        return None
    return _short(value, MAX_INPUT)


def _result_text(content: Any) -> Optional[str]:
    if isinstance(content, list):
        pieces = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                pieces.append(block["text"])
            elif isinstance(block, dict) and "json" in block:
                pieces.append(json.dumps(block["json"], ensure_ascii=False))
        content = "\n".join(pieces)
    if content is None or content == "":
        return None
    return _short(content, MAX_RESULT)


def _use(tool: dict) -> Optional[dict]:
    name = tool.get("name")
    tool_id = tool.get("toolUseId") or name
    if not isinstance(name, str) or not name or not tool_id:
        return None
    step = {"id": str(tool_id), "name": name, "status": "running"}
    text = _input(tool.get("input"))
    if text:
        step["input"] = text
    return step


def _result(result: dict) -> Optional[dict]:
    tool_id = result.get("toolUseId")
    if not tool_id:
        return None
    step = {"id": str(tool_id), "status": "error" if result.get("status") == "error" else "success"}
    text = _result_text(result.get("content"))
    if text:
        step["result"] = text
    return step


def steps_in(event: Any) -> List[dict]:
    """The tool step updates carried by one stream event (usually none)."""
    if not isinstance(event, dict):
        return []
    steps = []
    if isinstance(event.get("current_tool_use"), dict):
        steps.append(_use(event["current_tool_use"]))
    if isinstance(event.get("tool_result"), dict):
        steps.append(_result(event["tool_result"]))
    message = event.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), list):
        for block in message["content"]:
            if not isinstance(block, dict):
                continue
            if message.get("role") == "assistant" and isinstance(block.get("toolUse"), dict):
                steps.append(_use(block["toolUse"]))
            elif message.get("role") == "user" and isinstance(block.get("toolResult"), dict):
                steps.append(_result(block["toolResult"]))
    return [step for step in steps if step]


class StepTracker:
    """Sends a step update only when it changes something, and never moves a
    finished step back to running (Strands repeats a call's details later)."""

    def __init__(self):
        self._steps = {}

    def update(self, step: dict) -> Optional[dict]:
        known = self._steps.get(step["id"])
        if known is None:
            if "name" not in step:
                step = {**step, "name": "tool"}  # a result for a call we never saw
            self._steps[step["id"]] = dict(step)
            return step
        merged = {**known, **step}
        merged["status"] = known["status"] if step["status"] == "running" else step["status"]
        if merged == known:
            return None
        self._steps[step["id"]] = merged
        return merged
