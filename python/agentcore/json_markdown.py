"""Show a whole JSON reply as readable Markdown (Phase 10).

Agents often answer with JSON that has a message plus other useful fields
(status, sources, scores...). Instead of showing only the message, the chat
shows the message first and the rest as Markdown:

    {"message": "Deployed.", "status": "ok", "sources": [{"title": "Runbook", "url": "..."}]}

    Deployed.

    **Status:** ok

    **Sources**

    | Title | Url |
    |---|---|
    | Runbook | ... |

Settings (sent with every request):
  jsonReplies       "full" (default), "text" (message only), "raw" (JSON block)
  jsonHiddenFields  extra field names to leave out, besides HIDDEN_FIELDS

These rules were written before seeing real replies; each one is a small
function below, so they are easy to tune once real examples are captured.
"""
import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from agentcore.text_extract import DATA, FINAL, extract_text

MODES = ("full", "text", "raw")
MAX_DEPTH = 3
MAX_TABLE_COLUMNS = 8
MAX_RAW_CHARS = 200_000

# Plumbing that isn't useful to a reader; matched case-insensitively at any level
HIDDEN_FIELDS = (
    "role", "usage", "metrics", "stop_reason", "stopReason",
    "inputTokens", "outputTokens", "totalTokens", "input_tokens", "output_tokens", "total_tokens",
    "traceId", "trace_id", "requestId", "request_id", "sessionId", "session_id", "runtimeSessionId",
    "latencyMs", "latency_ms",
)

# Where the main text may be, in the order text_extract looks
_MAIN_KEYS = ("data", "result", "message", "delta",
              "text", "content", "output", "response", "answer", "completion")


def mode(settings: dict) -> str:
    value = settings.get("jsonReplies")
    return value if value in MODES else "full"


def hidden_fields(settings: dict) -> frozenset:
    extra = settings.get("jsonHiddenFields")
    names = list(HIDDEN_FIELDS) + [n for n in (extra if isinstance(extra, list) else []) if isinstance(n, str)]
    return frozenset(n.strip().lower() for n in names if n.strip())


def json_block(value: Any) -> str:
    return "```json\n" + json.dumps(value, indent=2, ensure_ascii=False) + "\n```"


def raw_json(values: List[Any]) -> Optional[str]:
    """The original JSON for "Open raw JSON"; None if too big to send."""
    text = json.dumps(values[0] if len(values) == 1 else values, indent=2, ensure_ascii=False)
    return text if len(text) <= MAX_RAW_CHARS else None


def split_main(obj: Any) -> Tuple[Optional[str], Any]:
    """(main text, the other fields) of a JSON reply."""
    if not isinstance(obj, dict):
        return None, obj
    for key in _MAIN_KEYS:
        if key in obj:
            text, kind = extract_text({key: obj[key]})
            if text and kind in (DATA, FINAL):
                return text, {k: v for k, v in obj.items() if k != key}
    return None, obj


def reply(value: Any, hidden: Iterable[str]) -> str:
    """A whole JSON reply: main text first, then everything else."""
    hidden = frozenset(hidden)
    main, rest = split_main(value)
    rest_md = render(rest, hidden)
    return "\n\n".join(part for part in (main, rest_md) if part) or json_block(value)


def extras(value: Any, hidden: Iterable[str]) -> str:
    """Markdown for the fields of a final stream event other than its text ("" if none)."""
    _, rest = split_main(value)
    return render(rest, frozenset(hidden)) if isinstance(rest, dict) else ""


def render(value: Any, hidden: frozenset, depth: int = 0) -> str:
    """Markdown for any JSON value."""
    return "\n\n".join(_blocks(value, hidden, depth)).strip()


# ---------- rules ----------

def _visible(obj: dict, hidden: frozenset) -> Dict[str, Any]:
    return {k: v for k, v in obj.items() if str(k).lower() not in hidden}


def _is_scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def label(key: str) -> str:
    """source_documents / sourceDocuments / source-documents -> "Source documents"."""
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(key)).replace("_", " ").replace("-", " ").split()
    text = " ".join(words).lower()
    return text[:1].upper() + text[1:] if text else str(key)


def _inline(value: Any) -> str:
    """A single value on one line (table cells, "Key: value")."""
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return " ".join(value.split()).replace("|", "\\|") or "-"
    return "`" + json.dumps(value, ensure_ascii=False).replace("`", "'") + "`"


def _blocks(value: Any, hidden: frozenset, depth: int) -> List[str]:
    if depth > MAX_DEPTH:
        return [json_block(value)]
    if isinstance(value, dict):
        return _dict_blocks(_visible(value, hidden), hidden, depth)
    if isinstance(value, list):
        return _list_blocks(value, hidden, depth)
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [_inline(value)]


def _dict_blocks(obj: Dict[str, Any], hidden: frozenset, depth: int) -> List[str]:
    blocks = []
    # Single values first, one "**Key:** value" per line
    lines = [f"**{label(k)}:** {_inline(v)}" for k, v in obj.items()
             if _is_scalar(v) and not (isinstance(v, str) and "\n" in v)]
    if lines:
        blocks.append("\n".join(lines))
    # Then multi-line text and nested values, each under its label
    for key, value in obj.items():
        if isinstance(value, str) and "\n" in value:
            blocks.append(f"**{label(key)}**\n\n{value.strip()}")
        elif not _is_scalar(value):
            inner = _blocks(_visible(value, hidden) if isinstance(value, dict) else value, hidden, depth + 1)
            if inner:
                blocks.append(f"**{label(key)}**")
                blocks.extend(inner)
    return blocks


def _list_blocks(items: list, hidden: frozenset, depth: int) -> List[str]:
    if not items:
        return []
    if all(_is_scalar(item) for item in items):
        return ["\n".join(f"- {_inline(item)}" for item in items)]
    table = _table(items, hidden)
    if table:
        return [table]
    blocks = []
    for i, item in enumerate(items, 1):
        blocks.append(f"**{i}.**")
        blocks.extend(_blocks(item, hidden, depth + 1))
    return blocks


def _table(items: list, hidden: frozenset) -> Optional[str]:
    """A table for a list of objects whose visible values are all single values."""
    if not all(isinstance(item, dict) for item in items):
        return None
    rows = [_visible(item, hidden) for item in items]
    columns: List[str] = []
    for row in rows:
        for key, value in row.items():
            if not _is_scalar(value):
                return None
            if key not in columns:
                columns.append(key)
    if not columns or len(columns) > MAX_TABLE_COLUMNS:
        return None
    lines = ["| " + " | ".join(label(c) for c in columns) + " |",
             "|" + "---|" * len(columns)]
    for row in rows:
        lines.append("| " + " | ".join(_inline(row.get(c)) if c in row else "" for c in columns) + " |")
    return "\n".join(lines)
