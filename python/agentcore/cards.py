"""Agent Cards of A2A agents (GetAgentCard, assumption A14).

The card gives the welcome screen the agent's skills and example prompts, and
tells whether the agent streams, for agentcore.a2aStreaming = "auto".
Cards are cached per agent like the agent list. A missing card or a missing
permission is cached too (asked once), logged, and never blocks chatting.
"""
import threading
import time
from typing import Dict, Optional, Tuple

from agentcore.backends import backend_for, is_mock
from agentcore.errors import AgentCoreError, SsoExpired
from agentcore.events import log

CACHE_SECONDS = 5 * 60
MAX_SKILLS = 8
MAX_EXAMPLES = 3

_cache: Dict[Tuple[bool, str, Optional[str], str], Tuple[float, dict]] = {}
_lock = threading.Lock()


def get_for(profile: str, agent_arn: str, settings: dict, refresh: bool = False) -> dict:
    """Return {"card": summary or None, "note": why there is no card, or None}."""
    region = settings.get("region") or None
    key = (is_mock(settings), profile, region, agent_arn)
    with _lock:
        cached = _cache.get(key)
    if cached and not refresh and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]

    try:
        raw = backend_for(settings).get_agent_card(profile, agent_arn, region=region)
        result = {"card": summarize(raw), "note": None}
    except SsoExpired:
        # Not cached: works again after "aws sso login"
        return {"card": None, "note": "SSO session expired"}
    except AgentCoreError as e:
        if "AccessDenied" in str(e):
            note = "No permission to read the Agent Card (bedrock-agentcore:GetAgentCard)"
        else:
            note = f"No Agent Card: {e}"
        log(f"{note} [{agent_arn}]", "warn")
        result = {"card": None, "note": note}

    with _lock:
        _cache[key] = (time.monotonic(), result)
    return result


def clear() -> None:
    """Forget all cards (the agent list was refreshed)."""
    with _lock:
        _cache.clear()


def streaming_mode(settings: dict) -> str:
    """agentcore.a2aStreaming as "auto", "on" or "off" (older versions used true/false)."""
    value = settings.get("a2aStreaming", "auto")
    if value is True:
        return "on"
    if value is False:
        return "off"
    return value if value in ("on", "off") else "auto"


def use_streaming(profile: str, agent_arn: str, settings: dict) -> bool:
    """Whether to call message/stream (True) or message/send (False)."""
    mode = streaming_mode(settings)
    if mode != "auto":
        return mode == "on"
    card = get_for(profile, agent_arn, settings)["card"]
    return bool(card and card["streaming"])


def summarize(card) -> Optional[dict]:
    """The parts of an A2A Agent Card the extension uses; tolerant of missing
    or odd fields, since every field is optional for us."""
    if not isinstance(card, dict):
        return None
    skills = []
    for skill in card.get("skills") or []:
        if not isinstance(skill, dict):
            continue
        name = str(skill.get("name") or skill.get("id") or "").strip()
        if not name:
            continue
        examples = [e.strip() for e in skill.get("examples") or [] if isinstance(e, str) and e.strip()]
        skills.append({"name": name,
                       "description": str(skill.get("description") or "").strip(),
                       "examples": examples[:MAX_EXAMPLES]})
    capabilities = card.get("capabilities")
    streaming = isinstance(capabilities, dict) and capabilities.get("streaming") is True
    return {"name": str(card.get("name") or "").strip(),
            "description": str(card.get("description") or "").strip(),
            "version": str(card.get("version") or "").strip(),
            "streaming": streaming,
            "skills": skills[:MAX_SKILLS]}
