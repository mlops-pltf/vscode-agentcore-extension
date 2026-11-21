"""The agent list shown in the picker: chat-capable agents, cached per profile.

Listing calls get_agent_runtime once per agent, so results are cached for a
few minutes; the refresh button bypasses the cache.
"""
import threading
import time
from typing import Dict, List, Tuple

from agentcore.backends import backend_for, is_mock

CHAT_PROTOCOLS = ("HTTP", "A2A")
CACHE_SECONDS = 5 * 60

_cache: Dict[Tuple[bool, str], Tuple[float, dict]] = {}
_lock = threading.Lock()


def list_for(profile: str, settings: dict, refresh: bool = False) -> dict:
    """Return {"data": [agents], "note": str or None} for the agents event."""
    key = (is_mock(settings), profile)
    with _lock:
        cached = _cache.get(key)
    if cached and not refresh and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]

    result = _chat_agents(backend_for(settings).list_agents(profile))
    with _lock:
        _cache[key] = (time.monotonic(), result)
    return result


def _chat_agents(agents: List[dict]) -> dict:
    # MCP/AGUI runtimes are tool servers or UI streams, not chat agents.
    # Unknown protocol (None) stays: the user picks it with the toggle.
    shown = [a for a in agents if a.get("protocol") in CHAT_PROTOCOLS + (None,)]
    hidden = len(agents) - len(shown)
    shown.sort(key=lambda a: a["name"].lower())
    note = f"{hidden} non-chat agent{'s' if hidden != 1 else ''} (MCP/AGUI) hidden" if hidden else None
    return {"data": shown, "note": note}
