"""HTTP-protocol agents: request payload and response parsing.

Request:  {"prompt": "<text>"}  (confirmed, Q2)
Response: one of (assumption A2)
  text/event-stream  SSE; each event's data is JSON or plain text
  application/json   one JSON body
  anything else      sniffed: SSE-looking, JSON-looking, or shown as text
"""
import ast
import json
from typing import Any, Iterable, List, Optional

from agentcore.aws import AgentCoreError
from agentcore.cancel import CancelToken
from agentcore.events import Emitter
from agentcore.sse import iter_sse_events
from agentcore.text_extract import DATA, FINAL, RAW_EVENT, TOOL, extract_text

HTTP_PROMPT_KEY = "prompt"
ACCEPT = "application/json, text/event-stream"


def build_payload(prompt: str) -> bytes:
    return json.dumps({HTTP_PROMPT_KEY: prompt}).encode("utf-8")


def handle_response(response: dict, emitter: Emitter, token: CancelToken) -> dict:
    """Stream the reply to the emitter; return extra metadata for the done event."""
    content_type = (response.get("contentType") or "").split(";")[0].strip().lower()
    body = response["response"]
    token.attach(body)

    if content_type == "text/event-stream":
        _handle_stream(_tap(body.iter_lines(), emitter, token), emitter, token)
        return {"contentType": content_type}

    text = _decode(body.read())
    emitter.raw(text)
    status = response.get("statusCode") or 200
    if status >= 400:
        raise AgentCoreError(f"Agent returned HTTP {status}: {text.strip()[:500]}")
    if content_type == "application/json" or content_type.endswith("+json"):
        _handle_json(text, emitter)
    else:
        _handle_unknown(text, emitter, token)
    return {"contentType": content_type}


def _handle_stream(lines: Iterable[bytes], emitter: Emitter, token: CancelToken) -> None:
    streamed = False
    raw_event_texts: List[str] = []
    final_text: Optional[str] = None
    tools_seen = set()
    plain_lines: List[str] = []  # kept in case the "SSE" stream has no data: lines at all

    def remember(lines_):
        for line in lines_:
            if line:
                plain_lines.append(_decode(line))
            yield line

    for data in iter_sse_events(remember(lines)):
        if token.cancelled:
            return
        if data.strip() == "[DONE]":
            continue
        text, kind = extract_text(_parse(data))
        if not text:
            continue
        if kind == DATA:
            emitter.chunk(text)
            streamed = True
        elif kind == RAW_EVENT:
            raw_event_texts.append(text)
        elif kind == FINAL:
            final_text = text
        elif kind == TOOL and text not in tools_seen:
            tools_seen.add(text)
            emitter.status(f"Using tool: {text}")

    if token.cancelled or streamed:
        return
    # Nothing streamed as "data": fall back to whatever else we saw (A4)
    if raw_event_texts:
        emitter.chunk("".join(raw_event_texts))
    elif final_text:
        emitter.chunk(final_text)
    elif plain_lines and not any(l.startswith("data:") for l in plain_lines):
        emitter.chunk("\n".join(plain_lines))


def _handle_json(text: str, emitter: Emitter) -> None:
    try:
        obj = json.loads(text)
    except ValueError:
        emitter.chunk(text)
        return
    reply, _ = extract_text(obj)
    if reply:
        emitter.chunk(reply)
    else:
        # Unknown shape: show it rather than nothing
        emitter.chunk("```json\n" + json.dumps(obj, indent=2) + "\n```")


def _handle_unknown(text: str, emitter: Emitter, token: CancelToken) -> None:
    if any(line.startswith("data:") for line in text.splitlines()):
        _handle_stream(text.splitlines(), emitter, token)
        return
    stripped = text.strip()
    if stripped[:1] in ("{", "[", '"'):
        _handle_json(stripped, emitter)
    else:
        emitter.chunk(text)


def _parse(data: str) -> Any:
    """Decode one event's data: JSON if possible, otherwise plain text."""
    try:
        obj = json.loads(data)
    except ValueError:
        return data
    # Some servers fall back to json.dumps(str(event)), giving a Python dict repr (A11)
    if isinstance(obj, str) and obj.startswith("{") and obj.endswith("}"):
        try:
            return ast.literal_eval(obj)
        except (ValueError, SyntaxError):
            pass
    return obj


def _tap(lines: Iterable[bytes], emitter: Emitter, token: CancelToken):
    """Pass lines through, logging them raw and stopping on cancel."""
    for line in lines:
        if token.cancelled:
            return
        emitter.raw(_decode(line))
        yield line


def _decode(data) -> str:
    return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
