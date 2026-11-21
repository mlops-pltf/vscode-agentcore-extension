"""Per-chat-session state kept between turns.

Protocols store what they need in the dict (e.g. A2A keeps its contextId).
The webview starts a new session id on "New chat" and sends reset_session.

Each session also remembers which runtimes it used (T6.27), so ending the
session can stop them on AgentCore and free their resources.
"""
import threading
from typing import Dict, List, NamedTuple, Optional


class RuntimeUse(NamedTuple):
    """One agent runtime a session talked to, with what is needed to stop it."""
    mock: bool
    profile: str
    region: Optional[str]
    agent_arn: str


_states: Dict[str, dict] = {}
_used: Dict[str, List[RuntimeUse]] = {}
_lock = threading.Lock()


def get(session_id: str) -> dict:
    with _lock:
        return _states.setdefault(session_id, {})


def record_use(session_id: str, use: RuntimeUse) -> None:
    with _lock:
        uses = _used.setdefault(session_id, [])
        if use not in uses:
            uses.append(use)


def reset(session_id: str) -> List[RuntimeUse]:
    """Forget the session; returns the runtimes it used (to stop them)."""
    with _lock:
        _states.pop(session_id, None)
        return _used.pop(session_id, [])
