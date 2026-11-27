# Sample HTTP agent

A small agent for **Amazon Bedrock AgentCore Runtime**, built with `BedrockAgentCoreApp` (the `bedrock-agentcore` SDK) and a [Strands](https://strandsagents.com) agent. Use it as a starting point, or to check the AgentCore Chat extension end to end.

It streams its reply in the format the extension reads best ([docs/AGENT_REPLY_FORMAT.md](../../docs/AGENT_REPLY_FORMAT.md)): text as it arrives, and each **tool call as a step in between**, where it happened:

```
data: {"data": "Let me check the time."}
data: {"current_tool_use": {"toolUseId": "t1", "name": "current_time"}}
data: {"current_tool_use": {"toolUseId": "t1", "name": "current_time", "input": {}}}
data: {"tool_result": {"toolUseId": "t1", "status": "success", "content": "2026-11-25T10:42:07+00:00"}}
data: {"data": " It is 10:42 UTC."}
```

In the chat, that's the first sentence, then a "Used `current_time`" step (a spinner while it runs, then ✓; click it for the input and result), then the rest of the answer. The mapping from Strands' events is one function, `to_chat_events()` in `agent.py`: copy it into your own agent.

- **Request**: `{"prompt": "..."}`, which is what the extension sends.
- **Conversation**: one Strands agent per AgentCore session, so a chat remembers what was said until the user clicks **New chat** (which also stops the session).
- **Tools**: `current_time` and `word_count`, to show tool steps in the chat. Ask "What time is it, and how many words are in 'hello agent world'?" to see two.
- **Answers in Markdown**: the system prompt asks for lists, tables and fenced code blocks, which the chat renders.
- **Errors**: an exception becomes an `{"error": ..., "error_type": ...}` event (done by `BedrockAgentCoreApp`), shown in the chat as an error with Retry.

## Run it locally

Needs Python 3.10+ and AWS credentials that can call Bedrock (`bedrock:InvokeModelWithResponseStream`).

```
cd samples/http-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python agent.py
```

In another terminal:

```
curl -N http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: local-session-0000000000000000000000' \
  -d '{"prompt": "What time is it? Answer with a small table."}'
```

No Bedrock model access? Start it with `ECHO_MODE=1 .venv/bin/python agent.py`: it streams a canned Markdown reply (with a table and a code block) without calling a model.

## Deploy to AgentCore Runtime

With the [AgentCore starter toolkit](https://github.com/aws/bedrock-agentcore-starter-toolkit) (checked with version 0.3.14):

```
pip install bedrock-agentcore-starter-toolkit
cd samples/http-agent
agentcore configure -e agent.py -n sample_http_agent -p HTTP -r eu-central-1 -rf requirements.txt
agentcore deploy
agentcore invoke '{"prompt": "Hello"}'
```

The runtime's execution role needs Bedrock model access (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`). Set `MODEL_ID` in the runtime's environment to choose a model or inference profile; otherwise Strands uses its default Claude model. To check the extension without model access, set `ECHO_MODE=1` instead.

Then, in VS Code, refresh the agent list: **sample_http_agent** appears as an HTTP agent. Try "What time is it?" (tool status, then the answer) or "Compare Python and Go in a table".

To remove it: `agentcore destroy`.

## Tests

From the repository root, after creating the venv above:

```
npm run test:sample
```

The tests run the real `BedrockAgentCoreApp` (no network, Strands replaced by a fake) and feed the exact bytes it streams through the extension's own HTTP parser, so the sample and the extension are proven to agree.
