"""What every agent protocol implements, and the context each request gets."""
from dataclasses import dataclass

from agentcore.events import Emitter
from agentcore.response import AgentResponse


@dataclass
class InvokeContext:
    request_id: str
    prompt: str
    session_id: str
    settings: dict
    # Survives across turns of one chat session, e.g. the A2A contextId.
    # Each protocol stores what it needs; cleared by reset_session.
    session_state: dict


class AgentProtocol:
    name = ""
    accept = "application/json, text/event-stream"

    def build_payload(self, ctx: InvokeContext) -> bytes:
        """The request body sent to InvokeAgentRuntime."""
        raise NotImplementedError

    def handle(self, response: AgentResponse, emitter: Emitter, ctx: InvokeContext) -> dict:
        """Turn response events into chunk/status events; return extra metadata for done."""
        raise NotImplementedError
