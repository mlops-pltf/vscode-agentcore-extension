"""HTTP-protocol agents: request payload and reply interpretation.

Request:  {"prompt": "<text>"}  (confirmed, Q2)
Reply:    SSE events or one JSON body (assumption A2), read by response.py.
          Each event is matched against the shapes in text_extract.py (A3).
          JSON is shown whole, as Markdown, per agentcore.jsonReplies (json_markdown.py).
"""
import json
from typing import List, Optional

from agentcore.errors import AgentCoreError
from agentcore import json_markdown
from agentcore.events import Emitter
from agentcore.protocols.base import AgentProtocol, InvokeContext
from agentcore.response import AgentResponse
from agentcore.text_extract import DATA, ERROR, FINAL, RAW_EVENT, TOOL, extract_text

HTTP_PROMPT_KEY = "prompt"


class HttpProtocol(AgentProtocol):
    name = "HTTP"

    def build_payload(self, ctx: InvokeContext) -> bytes:
        return json.dumps({HTTP_PROMPT_KEY: ctx.prompt}).encode("utf-8")

    def handle(self, response: AgentResponse, emitter: Emitter, ctx: InvokeContext) -> dict:
        json_mode = json_markdown.mode(ctx.settings)
        hidden = json_markdown.hidden_fields(ctx.settings)
        streamed = False
        raw_event_texts: List[str] = []
        final_text: Optional[str] = None
        final_event = None  # the stream's last final event, for its other fields
        shown_json = []     # JSON shown as Markdown, for "Open raw JSON"
        tools_seen = set()

        for event in response.events():
            text, kind = extract_text(event.value)

            if kind == ERROR:
                # Text already shown stays; the reply ends with this error (and Retry)
                raise AgentCoreError(f"Agent error: {text}")
            if event.whole_body:
                if isinstance(event.value, (dict, list)) and json_mode == "full":
                    emitter.chunk(json_markdown.reply(event.value, hidden))
                    shown_json.append(event.value)
                elif isinstance(event.value, (dict, list)) and (json_mode == "raw" or not text):
                    # raw mode, or an unknown shape in text mode: show it rather than nothing
                    emitter.chunk(json_markdown.json_block(event.value))
                elif text:
                    emitter.chunk(text)
                streamed = True
                continue

            if not text:
                continue
            if kind == DATA:
                emitter.chunk(text)
                streamed = True
            elif kind == RAW_EVENT:
                raw_event_texts.append(text)
            elif kind == FINAL:
                final_text = text
                final_event = event.value
            elif kind == TOOL and text not in tools_seen:
                tools_seen.add(text)
                emitter.status(f"Using tool: {text}")

        # Nothing streamed as "data": fall back to whatever else we saw (A4)
        if not streamed and not response.cancelled:
            if raw_event_texts:
                emitter.chunk("".join(raw_event_texts))
            elif final_text:
                emitter.chunk(final_text)

        # The final event's other fields (sources, status...), after the text.
        # Per-token events are never expanded: they'd flood the reply.
        if json_mode == "full" and final_event is not None and not response.cancelled:
            more = json_markdown.extras(final_event, hidden)
            if more:
                emitter.chunk("\n\n" + more)
                shown_json.append(final_event)

        meta = {"contentType": response.content_type}
        raw = json_markdown.raw_json(shown_json) if shown_json else None
        if raw:
            meta["rawJson"] = raw
        return meta
