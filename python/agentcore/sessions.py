"""Per-chat-session state kept between turns.

Protocols store what they need in the dict (e.g. A2A keeps its contextId).
The webview starts a new session id on "New chat" and sends reset_session.
"""
import threading
from typing import Dict

_states: Dict[str, dict] = {}
_lock = threading.Lock()


def get(session_id: str) -> dict:
    with _lock:
        return _states.setdefault(session_id, {})


def reset(session_id: str) -> None:
    with _lock:
        _states.pop(session_id, None)
