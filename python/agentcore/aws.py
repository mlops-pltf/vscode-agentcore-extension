"""Thin boto3 wrapper: clients, caller identity and invoke. No protocol logic.

mock_runtime.py exposes the same functions, so the bridge can swap one module
for the other based on the `mock` setting.
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

import boto3
from botocore.exceptions import (
    ClientError,
    NoRegionError,
    SSOError,
    SSOTokenLoadError,
    TokenRetrievalError,
    UnauthorizedSSOTokenError,
)

from agentcore.errors import AgentCoreError, SsoExpired

_SSO_ERRORS = (SSOError, SSOTokenLoadError, TokenRetrievalError, UnauthorizedSSOTokenError)


# boto3 clients are thread-safe, but creating them is not, so cache under a lock
_clients: Dict[Tuple[str, str, Optional[str]], object] = {}
_clients_lock = threading.Lock()
_user_ids: Dict[str, str] = {}


def _client(profile: str, service: str, region: Optional[str] = None):
    """region overrides the profile's region (agentcore.region setting)."""
    key = (profile, service, region or None)
    with _clients_lock:
        if key not in _clients:
            _clients[key] = boto3.Session(profile_name=profile, region_name=region or None).client(service)
        return _clients[key]


def list_profiles():
    return boto3.Session().available_profiles


def list_agents(profile: str, region: Optional[str] = None) -> List[dict]:
    """READY agent runtimes in the profile's account/region, with their protocol.

    list_agent_runtimes has no protocol, so each runtime is looked up with
    get_agent_runtime (in parallel). If that lookup fails, protocol is None
    and the user picks it with the toggle.
    """
    try:
        control = _client(profile, "bedrock-agentcore-control", region)
        runtimes = [r for page in control.get_paginator("list_agent_runtimes").paginate()
                    for r in page.get("agentRuntimes", []) if r.get("status") == "READY"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            protocols = list(pool.map(lambda r: _protocol_of(control, r["agentRuntimeId"]), runtimes))
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except NoRegionError:
        raise AgentCoreError(f"Profile {profile} has no region. Add 'region = ...' to it in ~/.aws/config "
                             "or set agentcore.region.")
    except ClientError as e:
        err = e.response.get("Error", {})
        raise AgentCoreError(f"Could not list agents: {err.get('Code', '')}: {err.get('Message', str(e))}")

    return [{"name": r.get("agentRuntimeName") or r["agentRuntimeId"],
             "arn": r["agentRuntimeArn"],
             "description": r.get("description", ""),
             "protocol": protocol}
            for r, protocol in zip(runtimes, protocols)]


def _protocol_of(control, runtime_id: str) -> Optional[str]:
    try:
        runtime = control.get_agent_runtime(agentRuntimeId=runtime_id)
    except ClientError:
        return None
    return (runtime.get("protocolConfiguration") or {}).get("serverProtocol")


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
           accept: str, user_id: Optional[str] = None, region: Optional[str] = None) -> dict:
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
        return _client(profile, "bedrock-agentcore", region).invoke_agent_runtime(**kwargs)
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except NoRegionError:
        raise AgentCoreError(f"Profile {profile} has no region. Add 'region = ...' to it in ~/.aws/config "
                             "or set agentcore.region.")
    except ClientError as e:
        err = e.response.get("Error", {})
        code, message = err.get("Code", ""), err.get("Message", str(e))
        if code == "AccessDeniedException" and "InvokeAgentRuntimeForUser" in message:
            raise AgentCoreError(
                "Your role lacks bedrock-agentcore:InvokeAgentRuntimeForUser, "
                "which is required to send runtimeUserId."
            )
        raise AgentCoreError(f"{code}: {message}")
