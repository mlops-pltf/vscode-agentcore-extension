"""Trace ids for replies, so a reply can be found in CloudWatch (T6.28).

InvokeAgentRuntime sends traceId as the X-Amzn-Trace-Id header, which uses the
X-Ray format "Root=1-<8 hex: epoch seconds>-<24 hex: random>" (A12).
"""
import re
import secrets
import time
from typing import Optional

# GenAI Observability in the CloudWatch console (A13: no deep link per trace found)
CLOUDWATCH_URL = "https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#gen-ai-observability"

_ROOT = re.compile(r"Root=([^;\s]+)")


def new_trace_id() -> str:
    """An X-Ray trace id, e.g. 1-6740a1b2-0123456789abcdef01234567."""
    return f"1-{int(time.time()):08x}-{secrets.token_hex(12)}"


def header(trace_id: str) -> str:
    """The value sent as traceId (X-Amzn-Trace-Id)."""
    return f"Root={trace_id}"


def root_of(value: Optional[str]) -> Optional[str]:
    """The trace id inside an X-Amzn-Trace-Id value ("Root=...;Parent=..."), or the value itself."""
    if not value:
        return None
    match = _ROOT.search(value)
    return match.group(1) if match else value.strip() or None


def reply_fields(trace_id: Optional[str], region: Optional[str]) -> dict:
    """traceId and cloudwatchUrl for a done or error event; empty without a trace id."""
    if not trace_id:
        return {}
    fields = {"traceId": trace_id}
    if region:
        fields["cloudwatchUrl"] = CLOUDWATCH_URL.format(region=region)
    return fields
