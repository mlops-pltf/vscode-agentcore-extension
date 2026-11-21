"""Read an InvokeAgentRuntime response as a series of decoded events.

HTTP and A2A agents both reply in one of two framings:
  text/event-stream  many events, one per SSE "data:" block
  application/json   one event: the whole body
Anything else is sniffed. Content types, SSE framing, cancel, the raw debug
log and error statuses are handled here once, so protocol modules only have
to interpret events.
"""
import ast
import json
from typing import Any, Iterable, Iterator, List, NamedTuple, Union

from agentcore.cancel import CancelToken
from agentcore.errors import AgentCoreError
from agentcore.events import Emitter
from agentcore.sse import iter_sse_events


class Event(NamedTuple):
    value: Any         # parsed JSON, or a str for non-JSON text
    whole_body: bool   # True when this is the entire (non-streamed) response


class AgentResponse:
    def __init__(self, raw: dict, emitter: Emitter, token: CancelToken):
        self.content_type = (raw.get("contentType") or "").split(";")[0].strip().lower()
        self.status = raw.get("statusCode") or 200
        self._body = raw["response"]
        self._emitter = emitter
        self._token = token
        token.attach(self._body)

    @property
    def cancelled(self) -> bool:
        return self._token.cancelled

    def events(self) -> Iterator[Event]:
        if self.content_type == "text/event-stream":
            yield from self._stream_events(self._tapped_lines())
            return

        text = _decode(self._body.read())
        self._emitter.raw(text)
        if self.status >= 400:
            raise AgentCoreError(f"Agent returned HTTP {self.status}: {text.strip()[:500]}")

        if self.content_type == "application/json" or self.content_type.endswith("+json"):
            yield Event(_parse(text), True)
        elif any(line.startswith("data:") for line in text.splitlines()):
            yield from self._stream_events(text.splitlines())
        elif text.strip()[:1] in ("{", "[", '"'):
            yield Event(_parse(text.strip()), True)
        else:
            yield Event(text, True)

    def _stream_events(self, lines: Iterable[Union[bytes, str]]) -> Iterator[Event]:
        plain_lines: List[str] = []  # kept in case the "SSE" stream has no data: lines at all

        def remember(lines_):
            for line in lines_:
                if line:
                    plain_lines.append(_decode(line))
                yield line

        yielded = False
        for data in iter_sse_events(remember(lines)):
            if self.cancelled:
                return
            yielded = True
            if data.strip() == "[DONE]":
                continue
            yield Event(_parse(data), False)

        if not yielded and plain_lines and not self.cancelled:
            yield Event("\n".join(plain_lines), True)

    def _tapped_lines(self) -> Iterator[bytes]:
        """Lines of the streaming body, logged raw, stopping on cancel."""
        for line in self._body.iter_lines():
            if self.cancelled:
                return
            self._emitter.raw(_decode(line))
            yield line


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


def _decode(data) -> str:
    return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
