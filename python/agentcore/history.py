"""Chat history (Phase 14): one JSON file per chat session id.

The extension passes the folder in AGENTCORE_HISTORY_DIR (VS Code's global
storage). Each turn is recorded while its events are sent to the panel
(TurnRecorder), so the saved chat is what the user saw, and the file is
written when the turn ends. Saving is off when the folder is missing or the
agentcore.history setting is false.

    <folder>/<sessionId>.json
    {"sessionId", "title", "created", "updated", "mock", "profile",
     "turns": [{"requestId", "time", "agentArn", "agentName", "protocol",
                "prompt", "mentionLength",
                "reply": {"segments": [{"kind": "text", "text"} | {"kind": "tool", ...}],
                          "state": "completed" | "cancelled" | "error",
                          "error", "meta"}}]}
"""
import json
import os
import re
import threading
from datetime import datetime, timezone
from typing import List, Optional

from agentcore import sessions
from agentcore.events import Emitter, log

MAX_CHATS = 200
TITLE_CHARS = 80
WAITING_STATES = ("input-required", "auth-required")

_lock = threading.Lock()
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,256}$")


def folder() -> Optional[str]:
    return os.environ.get("AGENTCORE_HISTORY_DIR") or None


def enabled(settings: dict) -> bool:
    return folder() is not None and settings.get("history", True) is not False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _path(session_id: str) -> str:
    # Session ids come from the panel: never let one name a file outside the folder
    if not isinstance(session_id, str) or not _SAFE_ID.match(session_id) or session_id.startswith("."):
        raise ValueError(f"invalid session id: {session_id!r}")
    if folder() is None:
        raise ValueError("chat history is not available (no folder)")
    return os.path.join(folder(), session_id + ".json")


def load(session_id: str) -> Optional[dict]:
    if folder() is None:
        return None
    try:
        with open(_path(session_id), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _save(chat: dict) -> None:
    os.makedirs(folder(), exist_ok=True)
    path = _path(chat["sessionId"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(chat, f, ensure_ascii=False)
    os.replace(tmp, path)  # atomic: a crash never leaves half a file
    _prune()


def _chat_files() -> List[str]:
    if folder() is None:
        return []
    try:
        names = os.listdir(folder())
    except OSError:
        return []
    return [os.path.join(folder(), n) for n in names if n.endswith(".json")]


def _prune() -> None:
    files = sorted(_chat_files(), key=os.path.getmtime, reverse=True)
    for path in files[MAX_CHATS:]:
        try:
            os.remove(path)
        except OSError:
            pass


def list_chats() -> List[dict]:
    """Summaries for the History list, newest first."""
    items = []
    for path in _chat_files():
        try:
            with open(path, encoding="utf-8") as f:
                chat = json.load(f)
            turns = chat.get("turns") or []
            items.append({"sessionId": chat["sessionId"], "title": chat.get("title") or "(untitled)",
                          "created": chat.get("created"), "updated": chat.get("updated"),
                          "agentName": turns[-1].get("agentName") if turns else None,
                          "turns": len(turns), "mock": bool(chat.get("mock"))})
        except (OSError, ValueError, KeyError, AttributeError) as e:
            log(f"Skipped an unreadable chat history file {os.path.basename(path)}: {e}", "warn")
    return sorted(items, key=lambda item: item.get("updated") or "", reverse=True)


def delete(session_id: str) -> None:
    with _lock:
        try:
            os.remove(_path(session_id))
        except OSError:
            pass


def delete_all() -> None:
    with _lock:
        for path in _chat_files():
            try:
                os.remove(path)
            except OSError:
                pass


def restore(session_id: str) -> None:
    """Continuing a saved chat: give each A2A agent its conversation back."""
    chat = load(session_id) or {}
    for turn in chat.get("turns") or []:
        meta = (turn.get("reply") or {}).get("meta") or {}
        if turn.get("protocol") != "A2A" or not meta.get("contextId"):
            continue
        state = sessions.get(session_id, turn.get("agentArn", ""))
        state["contextId"] = meta["contextId"]
        if meta.get("taskState") in WAITING_STATES and meta.get("taskId"):
            state["pendingTaskId"] = meta["taskId"]
        else:
            state.pop("pendingTaskId", None)


class TurnRecorder(Emitter):
    """An Emitter that also records the turn, and saves it when the turn ends."""

    def __init__(self, request_id: str, cmd: dict, settings: dict, debug_raw: bool = False):
        super().__init__(request_id, debug_raw=debug_raw)
        display = cmd.get("display") if isinstance(cmd.get("display"), dict) else {}
        agent_arn = cmd.get("agentArn") or ""
        self._session_id = cmd.get("sessionId")
        self._profile = cmd.get("profile")
        self._mock = settings.get("mock", True) is not False
        self._segments: List[dict] = []
        self._steps = {}
        self._saved = False
        self.turn = {
            "requestId": request_id,
            "time": _now(),
            "agentArn": agent_arn,
            "agentName": display.get("agentName") or agent_arn.rsplit("/", 1)[-1],
            "protocol": cmd.get("protocol") or "HTTP",
            "prompt": display.get("prompt") or cmd.get("prompt", ""),
            "mentionLength": display.get("mentionLength") if isinstance(display.get("mentionLength"), int) else 0,
            "reply": {"segments": self._segments, "state": None},
        }

    def chunk(self, text: str) -> None:
        super().chunk(text)
        if not text:
            return
        if self._segments and self._segments[-1]["kind"] == "text":
            self._segments[-1]["text"] += text
        else:
            self._segments.append({"kind": "text", "text": text})

    def tool(self, step: dict) -> None:
        super().tool(step)
        known = self._steps.get(step["id"])
        if known:
            known.update(step)
        else:
            known = {"kind": "tool", **step}
            self._steps[step["id"]] = known
            self._segments.append(known)

    def done(self, **meta) -> None:
        super().done(**meta)
        self._finish(meta.get("state") or "completed", meta=meta)

    def error(self, message: str, **extra) -> None:
        super().error(message, **extra)
        self._finish("error", error=message, meta=extra)

    def sso_expired(self, profile: str) -> None:
        super().sso_expired(profile)
        self._finish("error", error="SSO session expired.")

    def _finish(self, state: str, error: Optional[str] = None, meta: Optional[dict] = None) -> None:
        if self._saved or not self._session_id:
            return
        self._saved = True
        reply = self.turn["reply"]
        reply["state"] = state
        if error:
            reply["error"] = error
        reply["meta"] = meta or {}
        try:
            with _lock:
                chat = load(self._session_id) or {
                    "sessionId": self._session_id, "title": "", "created": self.turn["time"],
                    "mock": self._mock, "profile": self._profile, "turns": []}
                chat["turns"].append(self.turn)
                chat["updated"] = _now()
                if not chat.get("title"):
                    chat["title"] = " ".join(self.turn["prompt"].split())[:TITLE_CHARS]
                _save(chat)
        except (OSError, ValueError) as e:
            log(f"Could not save the chat history: {e}", "warn")
