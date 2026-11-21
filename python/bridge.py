"""stdin/stdout bridge between the VS Code extension and AWS.

Reads one JSON command per line from stdin, dispatches it by "action",
and replies with JSON events on stdout (see agentcore/events.py).
Agent invocations run in agentcore/invocations.py.
"""
import json
import sys
import threading

from agentcore import agents, cards, invocations, sessions
from agentcore.backends import backend_for
from agentcore.errors import AgentCoreError, SsoExpired
from agentcore.events import claim_stdout, send


def list_profiles(cmd: dict):
    send({"type": "profiles", "data": backend_for(cmd.get("settings") or {}).list_profiles()})


# Background work started by handlers (other than invocations), joined on exit
_background = []


def _in_background(target, cmd: dict) -> None:
    # AWS calls run off the stdin loop, so cancel and other requests aren't held up
    thread = threading.Thread(target=target, args=(cmd,), daemon=True)
    _background[:] = [t for t in _background if t.is_alive()]
    _background.append(thread)
    thread.start()


def list_agents(cmd: dict):
    # Listing makes one API call per agent
    _in_background(_list_agents, cmd)


def _list_agents(cmd: dict):
    profile = cmd["profile"]
    try:
        if cmd.get("refresh"):
            cards.clear()
        result = agents.list_for(profile, cmd.get("settings") or {}, refresh=bool(cmd.get("refresh")))
        send({"type": "agents", "profile": profile, **result})
    except SsoExpired:
        send({"type": "sso_expired", "profile": profile})
    except AgentCoreError as e:
        send({"type": "error", "message": str(e)})
    except Exception as e:
        send({"type": "error", "message": f"Could not list agents: {type(e).__name__}: {e}"})


def get_agent_card(cmd: dict):
    _in_background(_get_agent_card, cmd)


def _get_agent_card(cmd: dict):
    profile, agent_arn = cmd["profile"], cmd["agentArn"]
    try:
        result = cards.get_for(profile, agent_arn, cmd.get("settings") or {})
    except Exception as e:
        result = {"card": None, "note": f"Could not read the Agent Card: {type(e).__name__}: {e}"}
    send({"type": "agent_card", "profile": profile, "agentArn": agent_arn, **result})


def invoke_agent(cmd: dict):
    invocations.start(cmd)


def cancel(cmd: dict):
    invocations.cancel(cmd.get("requestId"))


def reset_session(cmd: dict):
    sessions.reset(cmd.get("sessionId"))


HANDLERS = {
    "list_profiles": list_profiles,
    "list_agents": list_agents,
    "get_agent_card": get_agent_card,
    "invoke_agent": invoke_agent,
    "cancel": cancel,
    "reset_session": reset_session,
}


def main():
    claim_stdout()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            handler = HANDLERS.get(cmd.get("action"))
            if handler is None:
                send({"type": "error", "message": f"Bridge error: unknown action {cmd.get('action')!r}"})
                continue
            handler(cmd)
        except Exception as e:
            send({"type": "error", "message": f"Bridge error: {e}"})

    # stdin closed: let in-flight replies finish before exiting
    invocations.wait_all()
    for thread in _background:
        thread.join()


if __name__ == "__main__":
    main()
