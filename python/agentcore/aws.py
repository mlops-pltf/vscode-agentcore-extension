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

from agentcore import tracing
from agentcore.errors import AgentCoreError, SsoExpired
from agentcore.events import log

_SSO_ERRORS = (SSOError, SSOTokenLoadError, TokenRetrievalError, UnauthorizedSSOTokenError)


# boto3 clients are thread-safe, but creating them is not, so cache under a lock
_clients: Dict[Tuple[str, str, Optional[str]], object] = {}
_clients_lock = threading.Lock()
_identities: Dict[str, dict] = {}


def _client(profile: str, service: str, region: Optional[str] = None):
    """region overrides the profile's region (agentcore.region setting)."""
    key = (profile, service, region or None)
    with _clients_lock:
        if key not in _clients:
            _clients[key] = boto3.Session(profile_name=profile, region_name=region or None).client(service)
        return _clients[key]


def _no_region(profile: str) -> AgentCoreError:
    return AgentCoreError(f"Profile {profile} has no region. Add 'region = ...' to it in ~/.aws/config "
                          "or set agentcore.region.")


def _error_text(e: ClientError) -> str:
    err = e.response.get("Error", {})
    return f"{err.get('Code', '')}: {err.get('Message', str(e))}"


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
        raise _no_region(profile)
    except ClientError as e:
        raise AgentCoreError(f"Could not list agents: {_error_text(e)}")

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


def get_agent_card(profile: str, agent_arn: str, region: Optional[str] = None) -> dict:
    """The A2A agent's Agent Card (GetAgentCard), as the JSON the agent publishes."""
    try:
        response = _client(profile, "bedrock-agentcore", region).get_agent_card(agentRuntimeArn=agent_arn)
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except NoRegionError:
        raise _no_region(profile)
    except ClientError as e:
        raise AgentCoreError(_error_text(e))
    return response.get("agentCard") or {}


def _identity(profile: str) -> dict:
    """sts:GetCallerIdentity, cached per profile: {account, arn, user}."""
    if profile not in _identities:
        try:
            identity = _client(profile, "sts").get_caller_identity()
        except _SSO_ERRORS:
            raise SsoExpired(profile)
        except NoRegionError:
            raise _no_region(profile)
        except ClientError as e:
            raise AgentCoreError(_error_text(e))
        arn = identity.get("Arn", "")
        # arn:aws:sts::<acct>:assumed-role/<role>/<session>  -> <session> (usually the SSO email)
        user = arn.rsplit("/", 1)[-1] if ":assumed-role/" in arn else identity["UserId"]
        _identities[profile] = {"account": identity.get("Account", ""), "arn": arn, "user": user}
    return _identities[profile]


def get_runtime_user_id(profile: str) -> str:
    """Identify the user from their SSO identity, sent as runtimeUserId (T1.5b)."""
    return _identity(profile)["user"]


def region_for(profile: str, region: Optional[str] = None) -> Optional[str]:
    """The region AgentCore calls go to: the agentcore.region setting or the profile's."""
    return region or boto3.Session(profile_name=profile).region_name


def whoami(profile: str, region: Optional[str] = None) -> dict:
    """Who the profile signs in as, for the profile tooltip (T6.29)."""
    return {**_identity(profile), "region": region_for(profile, region)}


def stop_runtime_session(profile: str, agent_arn: str, session_id: str, region: Optional[str] = None) -> None:
    """End a runtime session on AgentCore, freeing its resources (T6.27)."""
    try:
        _client(profile, "bedrock-agentcore", region).stop_runtime_session(
            agentRuntimeArn=agent_arn, runtimeSessionId=session_id)
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except NoRegionError:
        raise _no_region(profile)
    except ClientError as e:
        raise AgentCoreError(_error_text(e))


def invoke(profile: str, agent_arn: str, session_id: str, payload: bytes,
           accept: str, user_id: Optional[str] = None, region: Optional[str] = None,
           trace_id: Optional[str] = None) -> dict:
    """Call InvokeAgentRuntime and return the raw boto3 response.

    The caller reads response["response"] (a streaming body) itself.
    response["traceId"] is the reply's trace id: the one AgentCore returns, or
    else the one we sent; missing if AgentCore refused ours (A12).
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
    if trace_id:
        kwargs["traceId"] = tracing.header(trace_id)
    try:
        response = _client(profile, "bedrock-agentcore", region).invoke_agent_runtime(**kwargs)
        response["traceId"] = tracing.root_of(response.get("traceId")) or trace_id
        return response
    except _SSO_ERRORS:
        raise SsoExpired(profile)
    except NoRegionError:
        raise _no_region(profile)
    except ClientError as e:
        err = e.response.get("Error", {})
        code, message = err.get("Code", ""), err.get("Message", str(e))
        if code == "ValidationException" and trace_id:
            # Our trace id format may not be accepted (A12): once more without it
            log(f"AgentCore refused traceId {trace_id} ({message}); retrying without it", "warn")
            return invoke(profile, agent_arn, session_id, payload, accept, user_id, region)
        if code == "AccessDeniedException" and "InvokeAgentRuntimeForUser" in message:
            raise AgentCoreError(
                "Your role lacks bedrock-agentcore:InvokeAgentRuntimeForUser, "
                "which is required to send runtimeUserId."
            )
        raise AgentCoreError(f"{code}: {message}")
