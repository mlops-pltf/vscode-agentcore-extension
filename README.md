# AgentCore Chat

Chat with your **Amazon Bedrock AgentCore** agents from inside VS Code, using your own AWS SSO profile. Works with agents that speak plain **HTTP** and with **A2A** (Agent-to-Agent, JSON-RPC) agents.

## Features

- **Your agents, listed for you.** Pick an AWS profile and the chat lists the AgentCore runtimes that are ready in that account, with their protocol detected (MCP and AG-UI runtimes are hidden: they aren't chat agents). With many agents, **search** the list by name or description.
- **HTTP and A2A.** A toggle under the message box switches protocol per agent; it starts on the detected one (marked with a dot) and remembers your choice.
- **Streaming replies with Markdown**: headings, lists, tables, quotes, links and code blocks with a language label.
- **Code blocks you can use**: Copy, Insert at Cursor, Open in New File, and for shell commands Insert into Terminal (it never runs the command for you).
- **A2A Agent Cards**: an A2A agent's welcome screen shows its version, skills and example prompts; streaming is switched on automatically when the agent supports it.
- **Conversations that continue**: each chat is one AgentCore session; A2A agents keep their context and can ask you follow-up questions. **New chat** ends the session on AgentCore, freeing its resources.
- **Built for real work**: Stop (or Esc) at any time, Retry on failed replies, a "Thinking · 4s" timer, ↑ to recall your last prompt, and scrolling that stays put while you read.
- **Traceable**: every reply has a trace ID you can copy, and a link to CloudWatch GenAI Observability.
- **Mock mode**: try everything without an AWS account.

## Requirements

- VS Code **1.109** or later.
- **Python 3.9+** on your PATH. On first start the extension creates its own virtual environment and installs `boto3` into it (a few seconds, once).
- An **AWS profile** in `~/.aws/config`, normally AWS IAM Identity Center (SSO), with the permissions below.

## Getting started

1. Download `agentcore-chat-X.Y.Z.vsix` from the repository's **Releases** page and install it (`Extensions` view → `...` → **Install from VSIX...**).
2. Open the chat: click **AgentCore Chat** in the Secondary Side Bar on the right, or run **AgentCore: Open Chat** from the Command Palette.
3. Pick your **AWS profile** at the top. If your SSO session has expired, click **Run aws sso login** in the banner.
4. Pick an **agent**: click the agent name under the message box and type part of its name or description to search (↑/↓ and Enter work too). Type your question and press **Enter** (**Shift+Enter** for a new line).

### Where the chat lives

The chat opens as a tab in the **Secondary Side Bar** (on the right, next to GitHub Copilot Chat if you have it).

- To move it to the left: right-click the **AgentCore Chat** tab → **Move View**, or drag the tab into the Activity Bar.
- To put it back: right-click it → **Reset Location**, or run **View: Reset View Locations**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `agentcore.region` | `eu-central-1` | AWS region for AgentCore. Clear it to use the region from your AWS profile. |
| `agentcore.a2aStreaming` | `auto` | How to call A2A agents. `auto`: stream (`message/stream`) when the agent's Agent Card says it can, otherwise one answer (`message/send`). `on` / `off` force one or the other. |
| `agentcore.jsonReplies` | `full` | How to show JSON replies. `full`: the main text, then every other field as readable Markdown (lists, tables). `text`: only the main text. `raw`: the whole reply as a JSON block. |
| `agentcore.jsonHiddenFields` | `[]` | Field names to leave out of JSON replies, besides the built-in ones (`role`, `usage`, `metrics`, token counts, trace/request/session ids, stop reason, latency). |
| `agentcore.mock` | `false` | Use the built-in mock AgentCore instead of AWS (demos and development). |
| `agentcore.pythonPath` | `python3` | Python to run the backend with. Leave as is to let the extension manage its own environment; set a path to use your own (it needs `boto3`). |
| `agentcore.debugRawResponses` | `false` | Write every raw agent response line to the Output channel, e.g. to capture real responses as test fixtures. May log sensitive content. |

## Commands

| Command | What it does |
|---|---|
| **AgentCore: Open Chat** | Opens the chat and focuses it. |
| **AgentCore: Show Logs** | Opens the **AgentCore Chat** Output channel: backend messages, warnings, identity, stopped sessions. |
| **AgentCore: Restart Backend** | Restarts the Python backend (it also restarts on its own after a crash). |

## AWS permissions

Your role needs these `bedrock-agentcore` actions:

| Action | Needed for | Required |
|---|---|---|
| `ListAgentRuntimes` | listing agents | yes |
| `GetAgentRuntime` | detecting each agent's protocol (without it, choose HTTP/A2A yourself) | yes |
| `InvokeAgentRuntime` | chatting | yes |
| `InvokeAgentRuntimeForUser` | sending your SSO identity as the runtime user (`runtimeUserId`) | yes |
| `GetAgentCard` | skills and automatic streaming for A2A agents | optional |
| `StopRuntimeSession` | freeing the agent's session when you start a new chat | optional |

Without an optional permission the feature is skipped and the reason is written to the Output channel; chatting is never blocked. `sts:GetCallerIdentity` (who you are) needs no permission.

Example policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListAgents",
      "Effect": "Allow",
      "Action": ["bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:GetAgentRuntime"],
      "Resource": "*"
    },
    {
      "Sid": "ChatWithAgents",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
        "bedrock-agentcore:GetAgentCard",
        "bedrock-agentcore:StopRuntimeSession"
      ],
      "Resource": "arn:aws:bedrock-agentcore:*:<account-id>:runtime/*"
    }
  ]
}
```

## How replies are read

AgentCore passes agent responses through as the agent wrote them, so the extension accepts the common shapes. **Building an agent?** See [docs/AGENT_REPLY_FORMAT.md](docs/AGENT_REPLY_FORMAT.md) for the exact format, and [samples/http-agent](samples/http-agent/) for a ready-made agent built with `BedrockAgentCoreApp`. In short:

- **HTTP agents** get `{"prompt": "..."}`. Replies can be Server-Sent Events (e.g. Strands streaming events) or a single JSON or text body.
- **A2A agents** get a JSON-RPC 2.0 `message/send` or `message/stream` call. Replies can be a Message, a Task (with artifacts), and status or artifact updates. The conversation's `contextId` is sent back on every turn; if the agent asks for input, your next message answers that task.

**JSON replies are shown whole**: the main text first, then the other fields (status, sources, scores...) as readable Markdown, with an **Open raw JSON** button on the reply. Nothing an agent sends is lost; `agentcore.jsonReplies` switches this to text-only or raw JSON.

## Mock mode

Set `agentcore.mock` to `true`. The chat shows a **MOCK** badge and lists three demo agents (an HTTP one, an A2A one with an Agent Card, and one whose protocol is unknown). Words in your prompt pick a scenario:

| Word | What happens |
|---|---|
| `markdown` | a Markdown sample: headings, lists, a table, code blocks, links |
| `structured` | a JSON reply with a message and other fields (see `agentcore.jsonReplies`) |
| `slow` | one second between streamed lines, or 3 seconds before a one-piece answer (try Stop and the timer) |
| `json` | HTTP agent answers with one JSON body instead of a stream |
| `tool` | the agent reports a tool call first |
| `input` | A2A: the agent asks a follow-up question; your next message answers it |
| `fail` | A2A: the task fails |
| `rpcerror` | A2A: the agent returns a JSON-RPC error |
| `error` | the agent call itself fails |

Starting a new chat after using **demo-unknown** logs a permission warning on purpose (its mock "role" can't stop sessions).

## Troubleshooting

- **"SSO token expired"**: click **Run aws sso login** in the banner, then the refresh button next to the profile.
- **No agents**: check the region (`agentcore.region`) and that your agents' status is READY. **AgentCore: Show Logs** shows the error from AWS.
- **"Reconnecting to backend..."**: the Python backend stopped and is restarting. If it keeps failing, the banner offers **Restart** and **Show Logs**.
- **First start fails**: Python 3.9+ must be on your PATH, or set `agentcore.pythonPath` to a Python that has `boto3`.
- **A reply looks wrong**: turn on `agentcore.debugRawResponses`, send the message again, and look at the raw lines in the Output channel.

## Development

```
npm install                 # dev tools (jsdom for the panel tests, ESLint)
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
```

Press **F5** to start an Extension Development Host. The extension uses the repository's `.venv` when it exists.

| Command | Runs |
|---|---|
| `npm run test:py` | Python tests (protocol parsing, AWS calls with botocore's Stubber, the bridge end to end) |
| `npm run test:js` | JavaScript tests (Markdown parser, the real panel in jsdom wired to the real Python backend, the extension host) |
| `npm run test:sample` | The sample agent through the real `BedrockAgentCoreApp`, read by the extension's parser (needs the sample's own venv: see [samples/http-agent](samples/http-agent/)) |
| `npm run lint` | ESLint |

See [python/tests/README.md](python/tests/README.md) for details, and `python/tools/chat_cli.py` to chat with the backend from a terminal.

**Layout**: `extension.js` wires things up; `src/` is the extension host side (Python process, chat view, editor actions, settings); `media/webview/` is the chat panel; `python/` is the backend that does all AWS and protocol work (`bridge.py` reads JSON commands on stdin and writes JSON events on stdout). Design notes and assumptions about response shapes are in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

### Capturing a real response as a test fixture

1. Turn on `agentcore.debugRawResponses` and send a message to the real agent.
2. In **AgentCore: Show Logs**, copy the `[raw ...]` lines of that reply into a new file in `python/tests/fixtures/http/` or `.../a2a/` (`.sse` for streams, `.json` for single bodies).
3. Add a test that runs it through the protocol (see `test_protocol_http.py` / `test_protocol_a2a.py`).

### Packaging and releases

```
npx @vscode/vsce@3 package
```

Tests, fixtures, tools, samples and the docs folder are left out of the `.vsix` (see `.vscodeignore`). Releases are built by GitHub Actions from a version tag: see [RELEASING.md](RELEASING.md). Every pull request runs the CI workflow (lint, all tests, packaging check).

## License

[MIT](LICENSE)
