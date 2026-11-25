"""Sample HTTP agent for Amazon Bedrock AgentCore Runtime.

Built with BedrockAgentCoreApp (bedrock-agentcore SDK) and a Strands agent.
It streams its reply in the shape the AgentCore Chat extension reads best
(docs/AGENT_REPLY_FORMAT.md): text as it arrives, and each tool call as a step
in between, where it happened:

    data: {"data": "Let me check the time."}                                      -> text
    data: {"current_tool_use": {"toolUseId": "t1", "name": "current_time"}}       -> step: running
    data: {"current_tool_use": {"toolUseId": "t1", "name": "current_time", "input": {}}}   -> its input
    data: {"tool_result": {"toolUseId": "t1", "status": "success", "content": "2026-..."}} -> step: done
    data: {"data": "It is 10:42 UTC."}                                            -> more text

Request: {"prompt": "<the user's message>"}. One Strands agent is kept per
AgentCore session (the chat's runtimeSessionId), so it remembers the
conversation until the user starts a new chat.

Environment variables:
    MODEL_ID     Bedrock model or inference profile id (default: Strands' default Claude)
    ECHO_MODE=1  No model: stream a canned Markdown reply. For checking the
                 extension end to end without Bedrock model access.
"""
import asyncio
import os
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool

app = BedrockAgentCoreApp()

SYSTEM_PROMPT = (
    "You are a helpful assistant used from a chat panel inside VS Code. "
    "Answer in Markdown: short paragraphs, lists, tables when comparing things, "
    "and fenced code blocks with a language for code or commands."
)


@tool
def current_time() -> str:
    """Return the current date and time in UTC (ISO 8601)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@tool
def word_count(text: str) -> int:
    """Count the words in a piece of text."""
    return len(text.split())


# Tool results can be long or sensitive; the chat only needs a glimpse
MAX_TOOL_RESULT = 1000


def _result_text(content: Any) -> str:
    """Text of a Strands tool result's content blocks ([{"text": ...}, {"json": ...}])."""
    if isinstance(content, str):
        return content
    pieces = []
    for block in content or []:
        if isinstance(block, dict) and "text" in block:
            pieces.append(str(block["text"]))
        elif isinstance(block, dict) and "json" in block:
            pieces.append(str(block["json"]))
    return "\n".join(pieces)


def to_chat_events(event: dict, started: set) -> List[dict]:
    """The chat's events for one Strands stream event (usually none).

    Strands reports a tool call three ways: `current_tool_use` many times while
    the model writes it (input still incomplete), then an assistant `message`
    with the full `toolUse`, then a user `message` with the `toolResult`.
    `started` holds the toolUseIds already announced.
    """
    if isinstance(event.get("data"), str):
        return [{"data": event["data"]}]
    out = []
    tool = event.get("current_tool_use")
    if isinstance(tool, dict) and tool.get("toolUseId") and tool.get("name") and tool["toolUseId"] not in started:
        started.add(tool["toolUseId"])
        out.append({"current_tool_use": {"toolUseId": tool["toolUseId"], "name": tool["name"]}})
    message = event.get("message")
    if isinstance(message, dict):
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if isinstance(block.get("toolUse"), dict):
                use = block["toolUse"]
                out.append({"current_tool_use": {"toolUseId": use.get("toolUseId"), "name": use.get("name"),
                                                 "input": use.get("input")}})
            elif isinstance(block.get("toolResult"), dict):
                result = block["toolResult"]
                out.append({"tool_result": {"toolUseId": result.get("toolUseId"),
                                            "status": result.get("status", "success"),
                                            "content": _result_text(result.get("content"))[:MAX_TOOL_RESULT]}})
    return out


# One agent per chat session, so each chat keeps its own conversation history.
# AgentCore runs each session in its own microVM, so this is usually one entry.
_agents: Dict[str, Agent] = {}


def create_agent() -> Agent:
    model_id = os.environ.get("MODEL_ID")
    kwargs = {"model": model_id} if model_id else {}
    # callback_handler=None: no printing to stdout; we stream events ourselves
    return Agent(system_prompt=SYSTEM_PROMPT, tools=[current_time, word_count], callback_handler=None, **kwargs)


def agent_for(session_id) -> Agent:
    key = session_id or "local"
    if key not in _agents:
        _agents[key] = create_agent()
    return _agents[key]


@app.entrypoint
async def invoke(payload: dict, context) -> AsyncIterator[dict]:
    """Stream the reply as SSE events (BedrockAgentCoreApp sends each yielded dict as `data: <json>`)."""
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    if not isinstance(prompt, str) or not prompt.strip():
        yield {"data": 'Send a JSON body like {"prompt": "Hello"}.'}
        return

    if os.environ.get("ECHO_MODE") == "1":
        async for event in echo_reply(prompt):
            yield event
        return

    started = set()
    async for event in agent_for(context.session_id).stream_async(prompt):
        # Strands emits many event types; forward only what the chat shows.
        # (Yielding raw Strands events works too, but they carry objects that
        # don't serialize to JSON cleanly.)
        for chat_event in to_chat_events(event, started):
            yield chat_event
    # An exception here is sent by BedrockAgentCoreApp as
    # {"error": ..., "error_type": ...}, which the extension shows as an error.


ECHO_REPLY = """## Echo mode

You said: **{prompt}**

| Check | Result |
|---|---|
| Streaming | works |
| Markdown | works |

```bash
echo "the agent is reachable"
```
"""


async def echo_reply(prompt: str) -> AsyncIterator[dict]:
    yield {"current_tool_use": {"toolUseId": "echo-1", "name": "echo", "input": {"prompt": prompt}}}
    await asyncio.sleep(0.3)
    yield {"tool_result": {"toolUseId": "echo-1", "status": "success", "content": prompt}}
    words = ECHO_REPLY.format(prompt=prompt).split(" ")
    for i, word in enumerate(words):
        await asyncio.sleep(0.02)
        yield {"data": word if i == len(words) - 1 else word + " "}


if __name__ == "__main__":
    app.run()  # http://localhost:8080/invocations (POST) and /ping (GET)
