"""Shared test helpers: fake responses and an emitter that records events."""
import os

from agentcore.cancel import CancelToken
from agentcore.events import Emitter
from agentcore.mock_runtime import FakeBody
from agentcore.protocols import InvokeContext
from agentcore.response import AgentResponse

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


class RecordingEmitter(Emitter):
    def __init__(self):
        super().__init__("test", debug_raw=True)
        self.events = []

    def _send(self, msg_type, **fields):
        self.events.append({"type": msg_type, **fields})

    def of(self, msg_type):
        return [e for e in self.events if e["type"] == msg_type]

    @property
    def text(self):
        return "".join(e["text"] for e in self.of("chunk"))


def fake_response(body: bytes, content_type: str, status: int = 200, delay: float = 0) -> dict:
    return {"contentType": content_type, "statusCode": status,
            "response": FakeBody(body.split(b"\n"), delay)}


def fixture_response(relpath: str, content_type: str = None) -> dict:
    with open(os.path.join(FIXTURES, relpath), "rb") as f:
        body = f.read()
    if content_type is None:
        content_type = "text/event-stream" if relpath.endswith(".sse") else "application/json"
    return fake_response(body, content_type)


def context(prompt: str = "hi", session_state: dict = None, **settings) -> InvokeContext:
    # A fixed A2A method unless a test asks otherwise ("auto" would look up an Agent Card)
    settings.setdefault("a2aStreaming", "off")
    return InvokeContext(request_id="test", prompt=prompt, session_id="s" * 36,
                         settings=settings, session_state={} if session_state is None else session_state)


def handle(protocol, raw: dict, emitter: Emitter, token: CancelToken = None, ctx: InvokeContext = None) -> dict:
    """Run a protocol's handle() on a raw (fake) InvokeAgentRuntime response."""
    response = AgentResponse(raw, emitter, token or CancelToken())
    return protocol.handle(response, emitter, ctx or context())
