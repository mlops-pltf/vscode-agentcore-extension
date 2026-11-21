"""Sample HTTP agent for Amazon Bedrock AgentCore Runtime.

Built with BedrockAgentCoreApp (bedrock-agentcore SDK) and a Strands agent.
It streams its reply in the shape the AgentCore Chat extension reads best
(docs/AGENT_REPLY_FORMAT.md):

    data: {"current_tool_use": {"name": "current_time"}}    -> "Using tool: current_time"
    data: {"data": "Here is"}                               -> reply text, shown as it arrives
    data: {"data": " the answer."}

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
from typing import AsyncIterator, Dict

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

    tools_announced = set()
    async for event in agent_for(context.session_id).stream_async(prompt):
        # Strands emits many event types; forward only what the chat shows.
        # (Yielding raw Strands events works too, but they carry objects that
        # don't serialize to JSON cleanly.)
        if isinstance(event.get("data"), str):
            yield {"data": event["data"]}
        elif isinstance(event.get("current_tool_use"), dict):
            name = event["current_tool_use"].get("name")
            if name and name not in tools_announced:
                tools_announced.add(name)
                yield {"current_tool_use": {"name": name}}
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
    yield {"current_tool_use": {"name": "echo"}}
    words = ECHO_REPLY.format(prompt=prompt).split(" ")
    for i, word in enumerate(words):
        await asyncio.sleep(0.02)
        yield {"data": word if i == len(words) - 1 else word + " "}


if __name__ == "__main__":
    app.run()  # http://localhost:8080/invocations (POST) and /ping (GET)
