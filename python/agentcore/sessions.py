"""Per-chat-session state kept between turns.

Protocols store what they need in the dict (e.g. A2A keeps its contextId).
The state is per agent within a chat: with "@agent" (Phase 12) one chat can
talk to several agents, and one agent's context must not reach another.
The webview starts a new session id on "New chat" and sends reset_session.

Each session also remembers which runtimes it used (T6.27), so ending the
session can stop them on AgentCore and free their resources.
"""
import threading
from typing import Dict, List, NamedTuple, Optional, Tuple


class RuntimeUse(NamedTuple):
    """One agent runtime a session talked to, with what is needed to stop it."""
    mock: bool
    profile: str
    region: Optional[str]
    agent_arn: str


_states: Dict[Tuple[str, str], dict] = {}  # (session id, agent ARN) -> state
_used: Dict[str, List[RuntimeUse]] = {}
_lock = threading.Lock()


def get(session_id: str, agent_arn: str = "") -> dict:
    with _lock:
        return _states.setdefault((session_id, agent_arn), {})


def record_use(session_id: str, use: RuntimeUse) -> None:
    with _lock:
        uses = _used.setdefault(session_id, [])
        if use not in uses:
            uses.append(use)


def reset(session_id: str) -> List[RuntimeUse]:
    """Forget the session (every agent's state); returns the runtimes it used (to stop them)."""
    with _lock:
        for key in [key for key in _states if key[0] == session_id]:
            del _states[key]
        return _used.pop(session_id, [])
