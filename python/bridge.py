import sys
import json
import uuid
import boto3
from botocore.exceptions import UnauthorizedSSOTokenError, TokenRetrievalError
from typing import Optional


def send(msg: dict):
    print(json.dumps(msg), flush=True)

def list_profiles():
    profiles = boto3.Session().available_profiles
    send({"type": "profiles", "data": profiles})

def list_agents(profile: str, registry_id: Optional[str] = None):
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

def invoke_agent(profile: str, agent_arn: str, prompt: str, session_id: str):
    try:
        # session = boto3.Session(profile_name=profile)
        # client = session.client("bedrock-agentcore")

        # response = client.invoke_agent_runtime(
        #     agentRuntimeArn=agent_arn,
        #     runtimeSessionId=session_id or str(uuid.uuid4()),
        #     payload=json.dumps({"prompt": prompt}).encode("utf-8"),
        # )

        # body = response.get("response")
        # if hasattr(body, "iter_lines"):
        #     for line in body.iter_lines():
        #         if line:
        #             text = line.decode("utf-8")
        #             if text.startswith("data: "):
        #                 text = text[6:]
        #             send({"type": "chunk", "text": text})
        # elif hasattr(body, "read"):
        #     send({"type": "chunk", "text": body.read().decode("utf-8")})
        # else:
        #     send({"type": "chunk", "text": str(body)})
        send({"type": "chunk", "text": 'Fisrt chunk...\n'})
        send({"type": "chunk", "text": 'Second chunk...\n'})
        send({"type": "chunk", "text": 'Last chunk...\n'})
        send({"type": "done"})

    except (UnauthorizedSSOTokenError, TokenRetrievalError):
        send({"type": "sso_expired", "profile": profile})
    except Exception as e:
        send({"type": "error", "message": str(e)})

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            action = cmd.get("action")
            if action == "list_profiles":
                list_profiles()
            elif action == "list_agents":
                list_agents(cmd["profile"], cmd.get("registryId"))
            elif action == "invoke_agent":
                invoke_agent(
                    cmd["profile"],
                    cmd["agentArn"],
                    cmd["prompt"],
                    cmd.get("sessionId", "")
                )
        except Exception as e:
            send({"type": "error", "message": f"Bridge error: {e}"})

if __name__ == "__main__":
    main()
