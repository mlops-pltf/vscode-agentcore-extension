"""Running agent invocations: one worker thread per request, cancellable.

Flow for one request:
  pick backend (AWS or mock) -> pick protocol -> build payload -> invoke
  (with a new trace id) -> protocol turns response events into chunk/status
  -> done (or error), both carrying the trace id once the agent was reached
"""
import threading
import time
import uuid
from typing import Dict, Tuple

from agentcore import protocols, sessions, tracing
from agentcore.backends import backend_for, is_mock
from agentcore.cancel import CancelToken
from agentcore.errors import AgentCoreError, SsoExpired
from agentcore.events import Emitter
from agentcore.protocols import InvokeContext
from agentcore.response import AgentResponse

# In-flight invocations by requestId
_active: Dict[str, Tuple[threading.Thread, CancelToken]] = {}
_active_lock = threading.Lock()


def start(cmd: dict) -> None:
    # Run on a worker thread so the stdin loop stays free for cancel/other requests
    request_id = cmd.get("requestId") or str(uuid.uuid4())
    token = CancelToken()
    thread = threading.Thread(target=_run, args=(cmd, request_id, token), daemon=True)
    with _active_lock:
        _active[request_id] = (thread, token)
    thread.start()


def cancel(request_id: str) -> None:
    with _active_lock:
        entry = _active.get(request_id)
    if entry:
        entry[1].cancel()


def wait_all() -> None:
    """Let in-flight replies finish (used when stdin closes)."""
    with _active_lock:
        threads = [thread for thread, _ in _active.values()]
    for thread in threads:
        thread.join()


def _run(cmd: dict, request_id: str, token: CancelToken) -> None:
    settings = cmd.get("settings") or {}
    emitter = Emitter(request_id, debug_raw=settings.get("debugRaw", False))
    backend = backend_for(settings)
    started = time.monotonic()
    trace = {}  # traceId/cloudwatchUrl once the agent has answered
    try:
        protocol = protocols.get(cmd.get("protocol") or "HTTP")
        if protocol is None:
            emitter.error(f"Protocol {cmd.get('protocol')} is not supported yet")
            return

        profile = cmd["profile"]
        session_id = cmd.get("sessionId") or str(uuid.uuid4())
        ctx = InvokeContext(request_id=request_id, prompt=cmd["prompt"], session_id=session_id,
                            settings=settings, session_state=sessions.get(session_id, cmd["agentArn"]),
                            profile=profile, agent_arn=cmd["agentArn"])

        region = settings.get("region") or None
        user_id = backend.get_runtime_user_id(profile)
        raw = backend.invoke(profile, cmd["agentArn"], session_id,
                             protocol.build_payload(ctx), protocol.accept, user_id,
                             region=region, trace_id=tracing.new_trace_id())
        # The runtime session now exists; ending the chat stops it (T6.27)
        sessions.record_use(session_id, sessions.RuntimeUse(is_mock(settings), profile, region, cmd["agentArn"]))
        trace = tracing.reply_fields(raw.get("traceId"), backend.region_for(profile, region))
        meta = protocol.handle(AgentResponse(raw, emitter, token), emitter, ctx)
        # These keys belong to the request as a whole; a protocol's meta can't override them
        emitter.done(**{**meta, **trace,
                        "state": "cancelled" if token.cancelled else "completed",
                        "protocol": protocol.name,
                        "mock": is_mock(settings),
                        "ms": int((time.monotonic() - started) * 1000)})
    except SsoExpired as e:
        emitter.sso_expired(e.profile)
    except AgentCoreError as e:
        emitter.error(str(e), **trace)
    except Exception as e:
        if token.cancelled:
            emitter.done(state="cancelled", **trace)
        else:
            emitter.error(f"{type(e).__name__}: {e}", **trace)
    finally:
        with _active_lock:
            _active.pop(request_id, None)
