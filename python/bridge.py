"""stdin/stdout bridge between the VS Code extension and AWS.

Reads one JSON command per line from stdin, dispatches it by "action",
and replies with JSON events on stdout (see agentcore/events.py).
"""
import json
import sys
import threading
import uuid
from typing import Dict, Optional

import boto3
from botocore.exceptions import UnauthorizedSSOTokenError, TokenRetrievalError

from agentcore.events import Emitter, send


def list_profiles(cmd: dict):
    send({"type": "profiles", "data": boto3.Session().available_profiles})


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


# In-flight invocations by requestId
_active: Dict[str, threading.Thread] = {}
_active_lock = threading.Lock()


def invoke_agent(cmd: dict):
    # Run on a worker thread so the stdin loop stays free for cancel/other requests
    request_id = cmd.get("requestId") or str(uuid.uuid4())
    thread = threading.Thread(target=_run_invoke, args=(cmd, request_id), daemon=True)
    with _active_lock:
        _active[request_id] = thread
    thread.start()


def _run_invoke(cmd: dict, request_id: str):
    emitter = Emitter(request_id)
    try:
        emitter.chunk('Fisrt chunk...\n')
        emitter.chunk('Second chunk...\n')
        emitter.chunk('Last chunk...\n')
        emitter.done()
    except Exception as e:
        emitter.error(f"{type(e).__name__}: {e}")
    finally:
        with _active_lock:
            _active.pop(request_id, None)


HANDLERS = {
    "list_profiles": list_profiles,
    "list_agents": list_agents,
    "invoke_agent": invoke_agent,
}


def main():
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
    with _active_lock:
        threads = list(_active.values())
    for thread in threads:
        thread.join()


if __name__ == "__main__":
    main()
