# Change Log

All notable changes to the AgentCore Chat extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.9.0] - 2026-11-21

First beta, for internal testing against real AgentCore agents before 1.0.0.

### Added

- **A2A agents** next to HTTP agents: JSON-RPC `message/send` and `message/stream`, tasks and artifacts, follow-up questions (input-required), and conversations that keep their context.
- **Protocol toggle** (HTTP / A2A) under the message box: starts on the protocol detected from the agent and remembers manual choices per agent. Switching mid-chat asks first, then starts a new chat.
- **Agent list** from `ListAgentRuntimes` with each agent's protocol (`GetAgentRuntime`); MCP and AG-UI runtimes are hidden; cached for five minutes with a refresh button.
- **Searchable agent picker**: filter agents by name or description, with keyboard support, for accounts with many agents.
- **Agent Cards** for A2A agents: version, skills and example prompts on the welcome screen.
- **Setting `agentcore.a2aStreaming`**: `auto` (default) streams when the Agent Card says the agent can; `on` / `off` force it.
- **Markdown replies**, rendered while they stream in: headings, emphasis, lists, tables, quotes, links (opened in the browser after VS Code asks) and code blocks.
- **Code block actions**: Copy, Insert at Cursor, Open in New File, and Insert into Terminal for shell blocks (never runs the command).
- **Reply actions**: Copy reply (as Markdown), Copy trace ID, Open in CloudWatch, and Retry on failed replies.
- **Trace IDs**: every request is sent with an X-Ray trace id, shown on its reply.
- **New chat ends the AgentCore session** (`StopRuntimeSession`) of every agent the chat used.
- **Identity at a glance**: the profile picker's tooltip shows your user, account and region.
- **Runtime user**: your SSO identity is sent as `runtimeUserId`.
- **Composer**: Stop (or Esc), "Thinking · Ns" while waiting, ↑ recalls the last prompt, smart scrolling with "Jump to latest".
- **JSON replies shown whole** (`agentcore.jsonReplies`, default `full`): the main text, then the other fields as Markdown (lists, tables), with hidden plumbing fields (`agentcore.jsonHiddenFields`) and an **Open raw JSON** button.
- **Agent errors mid-stream** (`{"error": ..., "error_type": ...}`, as sent by `BedrockAgentCoreApp`) end the reply with an error and Retry instead of showing as text.
- **Sample agent** (`samples/http-agent`) built with `BedrockAgentCoreApp` and Strands, and an agent reply format guide (`docs/AGENT_REPLY_FORMAT.md`).
- **Mock mode** (`agentcore.mock`) with demo agents and scenarios (`markdown`, `slow`, `json`, `tool`, `input`, `fail`, `rpcerror`, `error`).
- **Setting `agentcore.region`** (default `eu-central-1`; empty uses the profile's region) and **`agentcore.debugRawResponses`** for capturing raw replies.
- **Commands**: AgentCore: Open Chat, Show Logs, Restart Backend; an **AgentCore Chat** Output channel.

### Changed

- The chat lives in the Secondary Side Bar (right), next to other chat views, with a redesigned panel that follows the VS Code theme and works in narrow side bars.
- The Python backend restarts itself after a crash (up to three times a minute), keeps working when a request fails, and reinstalls its dependencies when `requirements.txt` changes.
- Requires VS Code 1.109 or later.

### Security

- Strict Content Security Policy for the chat panel (per-load nonce, no inline code); agent output is never parsed as HTML.
- Links and editor actions from the panel are checked by the extension (web links only, limited size, known actions only).
