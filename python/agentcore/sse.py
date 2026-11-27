"""Server-Sent Events framing.

An SSE stream is a series of events separated by blank lines. Each event has
one or more "data:" lines (joined with newlines); other fields such as
"event:", "id:" and ":comments" are not needed here and are skipped.
"""
from typing import Iterable, Iterator, Union


def iter_sse_events(lines: Iterable[Union[bytes, str]]) -> Iterator[str]:
    """Yield the data of each SSE event from an iterable of lines."""
    data_lines = []
    for raw in lines:
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r")

        if line == "":
            if data_lines:
                yield "\n".join(data_lines)
                data_lines = []
            continue
        if line.startswith(":"):
            continue

        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            data_lines.append(value)

    # Stream ended without a final blank line
    if data_lines:
        yield "\n".join(data_lines)
