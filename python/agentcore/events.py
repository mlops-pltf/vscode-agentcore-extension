"""Everything the bridge writes to stdout goes through here.

The extension reads stdout line by line, so each message must be exactly one
JSON object on one line. Invocations run on worker threads, hence the lock.
"""
import json
import sys
import threading
from typing import Optional

_stdout_lock = threading.Lock()
_out = sys.stdout


def claim_stdout() -> None:
    """Keep the real stdout for protocol messages only.

    Anything else that prints (a library, a stray debug print) goes to stderr,
    which the extension logs, instead of corrupting the JSON stream.
    """
    global _out
    _out = sys.stdout
    sys.stdout = sys.stderr


def send(msg: dict) -> None:
    line = json.dumps(msg)
    with _stdout_lock:
        _out.write(line + "\n")
        _out.flush()


def log(message: str, level: str = "info") -> None:
    """A line for the extension's Output channel (never shown in the panel).
    level: info, warn or error."""
    send({"type": "log", "level": level, "message": message})


class Emitter:
    """Sends events tagged with a single request's id."""

    def __init__(self, request_id: Optional[str], debug_raw: bool = False):
        self.request_id = request_id
        self.debug_raw = debug_raw

    def _send(self, msg_type: str, **fields) -> None:
        msg = {"type": msg_type, **fields}
        if self.request_id is not None:
            msg["requestId"] = self.request_id
        send(msg)

    def chunk(self, text: str) -> None:
        if text:
            self._send("chunk", text=text)

    def status(self, text: str) -> None:
        self._send("status", text=text)

    def tool(self, step: dict) -> None:
        # A tool call step shown inside the reply (tool_steps.py)
        self._send("tool", **step)

    def done(self, **meta) -> None:
        self._send("done", meta=meta)

    def error(self, message: str, **extra) -> None:
        # extra: traceId/cloudwatchUrl when the agent was reached (tracing.reply_fields)
        self._send("error", message=message, **extra)

    def sso_expired(self, profile: str) -> None:
        self._send("sso_expired", profile=profile)

    def raw(self, line: str) -> None:
        # Raw response lines, only for capturing real payloads as test fixtures
        if self.debug_raw:
            self._send("raw", line=line)
