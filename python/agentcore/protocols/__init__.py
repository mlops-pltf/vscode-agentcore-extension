"""Agent protocols by name. Adding one = a new AgentProtocol subclass listed here."""
from typing import Optional

from agentcore.protocols.a2a import A2aProtocol
from agentcore.protocols.base import AgentProtocol, InvokeContext
from agentcore.protocols.http import HttpProtocol

_PROTOCOLS = {p.name: p for p in (HttpProtocol(), A2aProtocol())}


def get(name: str) -> Optional[AgentProtocol]:
    return _PROTOCOLS.get((name or "").upper())


__all__ = ["AgentProtocol", "InvokeContext", "get"]
