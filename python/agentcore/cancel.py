"""Cancellation for in-flight invocations.

Setting a flag is not enough: the worker thread may be blocked inside
body.iter_lines() waiting for the next chunk. Closing the body makes that
read return (or raise), so the thread can notice the flag and stop.
"""
import threading


class CancelToken:
    def __init__(self):
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._body = None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def attach(self, body) -> None:
        """Remember the streaming body so cancel() can close it."""
        with self._lock:
            self._body = body
        if self.cancelled:
            self._close(body)

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            body = self._body
        if body is not None:
            self._close(body)

    @staticmethod
    def _close(body) -> None:
        try:
            body.close()
        except Exception:
            pass
