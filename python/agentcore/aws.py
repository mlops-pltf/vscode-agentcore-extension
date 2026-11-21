"""Thin boto3 wrapper: clients, caller identity and invoke. No protocol logic.

mock_runtime.py exposes the same functions, so the bridge can swap one module
for the other based on the `mock` setting.
"""
import threading
from typing import Dict, Tuple

import boto3
from botocore.exceptions import (
    ClientError,
    SSOError,
    SSOTokenLoadError,
    TokenRetrievalError,
    UnauthorizedSSOTokenError,
)

_SSO_ERRORS = (SSOError, SSOTokenLoadError, TokenRetrievalError, UnauthorizedSSOTokenError)


class SsoExpired(Exception):
    def __init__(self, profile: str):
        super().__init__(f"SSO session expired for profile {profile}")
        self.profile = profile


class AgentCoreError(Exception):
    """An error whose message is safe and useful to show the user as-is."""


# boto3 clients are thread-safe, but creating them is not, so cache under a lock
_clients: Dict[Tuple[str, str], object] = {}
_clients_lock = threading.Lock()


def _client(profile: str, service: str):
    key = (profile, service)
    with _clients_lock:
        if key not in _clients:
            _clients[key] = boto3.Session(profile_name=profile).client(service)
        return _clients[key]


def list_profiles():
    return boto3.Session().available_profiles


def invoke(profile: str, agent_arn: str, session_id: str, payload: bytes,
           accept: str) -> dict:
    """Call InvokeAgentRuntime and return the raw boto3 response.

    The caller reads response["response"] (a streaming body) itself.
    """
    kwargs = {
        "agentRuntimeArn": agent_arn,
        "runtimeSessionId": session_id,
        "payload": payload,
        "contentType": "application/json",
        "accept": accept,
    }
    try:
        return _client(profile, "bedrock-agentcore").invoke_agent_runtime(**kwargs)
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except ClientError as e:
        err = e.response.get("Error", {})
        code, message = err.get("Code", ""), err.get("Message", str(e))
        raise AgentCoreError(f"{code}: {message}")
