"""Find the reply text inside one decoded HTTP-agent event.

Agents built with different frameworks stream different shapes, and we can't
test against real ones (assumption A3 in docs/IMPLEMENTATION_PLAN.md). Each
shape we know about is one rule below, checked in order.

extract_text() returns (text, kind). The kind tells the caller how to use it:
  "data"       a piece of streamed reply text: show it right away
  "raw_event"  a raw Bedrock model event: Strands also sends the same text as
               "data", so only use these if no "data" text arrived (A4)
  "final"      the complete answer sent at the end: only use it if nothing
               was streamed, otherwise the whole reply would repeat (A4)
  "tool"       the name of a tool the agent is calling
  None         not reply text (lifecycle events etc.)
"""
from typing import Any, Optional, Tuple

DATA, RAW_EVENT, FINAL, TOOL = "data", "raw_event", "final", "tool"

Result = Tuple[Optional[str], Optional[str]]

# Generic keys some agents use for a plain-text reply
_TEXT_KEYS = ("text", "content", "output", "response", "answer", "completion")


def extract_text(obj: Any) -> Result:
    if isinstance(obj, str):
        return obj, DATA
    if not isinstance(obj, dict):
        return None, None

    # Strands: {"data": "<token>", "delta": {...}, ...}
    if isinstance(obj.get("data"), str):
        return obj["data"], DATA

    # Raw Bedrock ConverseStream event: {"event": {"contentBlockDelta": {"delta": {"text": ...}}}}
    if isinstance(obj.get("event"), dict):
        delta = obj["event"].get("contentBlockDelta", {}).get("delta", {})
        if isinstance(delta.get("text"), str):
            return delta["text"], RAW_EVENT
        return None, None

    # Strands tool call in progress: {"current_tool_use": {"name": ...}}
    tool = obj.get("current_tool_use")
    if isinstance(tool, dict) and tool.get("name"):
        return tool["name"], TOOL

    # End of stream: {"result": "<full text>"} or {"result": {"role": "assistant", "content": [...]}}
    if "result" in obj:
        text = obj["result"] if isinstance(obj["result"], str) else _message_text(obj["result"])
        return (text, FINAL) if text else (None, None)

    # Strands adds every finished message to the stream; tool results come as role "user"
    if isinstance(obj.get("message"), dict):
        message = obj["message"]
        if message.get("role") == "assistant":
            text = _message_text(message)
            return (text, FINAL) if text else (None, None)
        return None, None
    if isinstance(obj.get("message"), str):
        return obj["message"], DATA

    # {"delta": {"text": ...}} or {"delta": "..."}
    delta = obj.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("text"), str):
        return delta["text"], DATA
    if isinstance(delta, str):
        return delta, DATA

    for key in _TEXT_KEYS:
        value = obj.get(key)
        if isinstance(value, str):
            return value, DATA
        if isinstance(value, list):
            text = _content_text(value)
            if text:
                return text, DATA
        if isinstance(value, dict):
            return extract_text(value)

    return None, None


def _message_text(message: Any) -> Optional[str]:
    """Text of a Bedrock/Strands message: {"role": ..., "content": [{"text": ...}, ...]}."""
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return _content_text(content)
    return None


def _content_text(blocks: list) -> Optional[str]:
    texts = [b["text"] for b in blocks if isinstance(b, dict) and isinstance(b.get("text"), str)]
    return "".join(texts) or None
