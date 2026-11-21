"""stdin/stdout bridge between the VS Code extension and AWS.

Reads one JSON command per line from stdin, dispatches it by "action",
and replies with JSON events on stdout (see agentcore/events.py).
Agent invocations run in agentcore/invocations.py.
"""
import json
import sys
from typing import Optional

from botocore.exceptions import UnauthorizedSSOTokenError, TokenRetrievalError

from agentcore import invocations, sessions
from agentcore.backends import backend_for
from agentcore.events import claim_stdout, send


def list_profiles(cmd: dict):
    send({"type": "profiles", "data": backend_for(cmd.get("settings") or {}).list_profiles()})


def list_agents(cmd: dict):
    profile = cmd["profile"]
    registry_id: Optional[str] = cmd.get("registryId")
    try:
        # session = boto3.Session(profile_name=profile)
        # client = session.client("bedrock-agentcore-control")

        # kwargs = {}
        # if registry_id:
        #     kwargs["registryId"] = registry_id

        # response = client.list_discoverable_registry_records(**kwargs)
        # records = response.get("registryRecords", [])

        # agents = []
        # for rec in records:
        #     arn = rec.get("recordArn") or rec.get("targetArn") or rec.get("arn", "")
        #     name = rec.get("name") or rec.get("recordName") or arn.split("/")[-1]
        #     desc = rec.get("description", "")
        #     agents.append({"name": name, "arn": arn, "description": desc})

        # send({"type": "agents", "data": agents})
        send({
            "type": "agents"
            , "data": [
                {"name": "dummy-agent-1", "arn": 'dummy-arn-1', "description": 'dummy-description-1'}
                , {"name": "dummy-agent-2", "arn": 'dummy-arn-2', "description": 'dummy-description-2'}
            ]
        })

    except (UnauthorizedSSOTokenError, TokenRetrievalError):
        send({"type": "sso_expired", "profile": profile})
    except Exception as e:
        send({"type": "error", "message": str(e)})


def invoke_agent(cmd: dict):
    invocations.start(cmd)


def cancel(cmd: dict):
    invocations.cancel(cmd.get("requestId"))


def reset_session(cmd: dict):
    sessions.reset(cmd.get("sessionId"))


HANDLERS = {
    "list_profiles": list_profiles,
    "list_agents": list_agents,
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


if __name__ == "__main__":
    main()
