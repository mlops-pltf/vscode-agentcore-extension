"""HTTP-protocol agents: request payload and reply interpretation.

Request:  {"prompt": "<text>"}  (confirmed, Q2)
Reply:    SSE events or one JSON body (assumption A2), read by response.py.
          Each event is matched against the shapes in text_extract.py (A3).
"""
import json
from typing import List, Optional

from agentcore.errors import AgentCoreError
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
        streamed = False
        raw_event_texts: List[str] = []
        final_text: Optional[str] = None
        tools_seen = set()

        for event in response.events():
            text, kind = extract_text(event.value)

            if kind == ERROR:
                # Text already shown stays; the reply ends with this error (and Retry)
                raise AgentCoreError(f"Agent error: {text}")
            if event.whole_body:
                if text:
                    emitter.chunk(text)
                elif not isinstance(event.value, str):
                    # Unknown shape: show it rather than nothing
                    emitter.chunk("```json\n" + json.dumps(event.value, indent=2) + "\n```")
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
            elif kind == TOOL and text not in tools_seen:
                tools_seen.add(text)
                emitter.status(f"Using tool: {text}")

        # Nothing streamed as "data": fall back to whatever else we saw (A4)
        if not streamed and not response.cancelled:
            if raw_event_texts:
                emitter.chunk("".join(raw_event_texts))
            elif final_text:
                emitter.chunk(final_text)

        return {"contentType": response.content_type}
