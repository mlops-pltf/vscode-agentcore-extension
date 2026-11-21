"""Thin boto3 wrapper: clients, caller identity and invoke. No protocol logic.

mock_runtime.py exposes the same functions, so the bridge can swap one module
for the other based on the `mock` setting.
"""
import threading
from typing import Dict, Optional, Tuple

import boto3
from botocore.exceptions import (
    ClientError,
    SSOError,
    SSOTokenLoadError,
    TokenRetrievalError,
    UnauthorizedSSOTokenError,
)

from agentcore.errors import AgentCoreError, SsoExpired

_SSO_ERRORS = (SSOError, SSOTokenLoadError, TokenRetrievalError, UnauthorizedSSOTokenError)


# boto3 clients are thread-safe, but creating them is not, so cache under a lock
_clients: Dict[Tuple[str, str], object] = {}
_clients_lock = threading.Lock()
_user_ids: Dict[str, str] = {}


def _client(profile: str, service: str):
    key = (profile, service)
    with _clients_lock:
        if key not in _clients:
            _clients[key] = boto3.Session(profile_name=profile).client(service)
        return _clients[key]


def list_profiles():
    return boto3.Session().available_profiles


def get_runtime_user_id(profile: str) -> str:
    """Identify the user from their SSO identity, sent as runtimeUserId (T1.5b)."""
    if profile not in _user_ids:
        try:
            identity = _client(profile, "sts").get_caller_identity()
        except _SSO_ERRORS:
            raise SsoExpired(profile)
        arn = identity.get("Arn", "")
        # arn:aws:sts::<acct>:assumed-role/<role>/<session>  -> <session> (usually the SSO email)
        if ":assumed-role/" in arn:
            _user_ids[profile] = arn.rsplit("/", 1)[-1]
        else:
            _user_ids[profile] = identity["UserId"]
    return _user_ids[profile]


def invoke(profile: str, agent_arn: str, session_id: str, payload: bytes,
           accept: str, user_id: Optional[str] = None) -> dict:
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
    if user_id:
        kwargs["runtimeUserId"] = user_id
    try:
        return _client(profile, "bedrock-agentcore").invoke_agent_runtime(**kwargs)
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except ClientError as e:
        err = e.response.get("Error", {})
        code, message = err.get("Code", ""), err.get("Message", str(e))
        if code == "AccessDeniedException" and "InvokeAgentRuntimeForUser" in message:
            raise AgentCoreError(
                "Your role lacks bedrock-agentcore:InvokeAgentRuntimeForUser, "
                "which is required to send runtimeUserId."
            )
        raise AgentCoreError(f"{code}: {message}")
