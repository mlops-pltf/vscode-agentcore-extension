"""The sample agent, run through the real BedrockAgentCoreApp (Starlette test
client, no network), and its streamed bytes read by the extension's own HTTP
parser, so the sample and the extension are proven to agree.

Run from the repository root with the sample's venv:
    npm run test:sample
"""
import logging
import os
import sys
import unittest
from unittest import mock

from starlette.testclient import TestClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "python"))  # the extension's backend

import agent  # noqa: E402
from agentcore.errors import AgentCoreError  # noqa: E402
from agentcore.protocols.http import HttpProtocol  # noqa: E402
from tests.helpers import RecordingEmitter, fake_response, handle  # noqa: E402

SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
logging.getLogger("bedrock_agentcore").setLevel(logging.CRITICAL)  # the SDK logs every request
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")  # Strands' Bedrock model needs a region


class FakeStrandsAgent:
    """Yields events shaped like Strands' stream_async, including ones the sample must filter out."""

    def __init__(self, fail=False):
        self.prompts = []
        self.fail = fail

    async def stream_async(self, prompt):
        self.prompts.append(prompt)
        yield {"init_event_loop": True}
        yield {"current_tool_use": {"toolUseId": "t1", "name": "current_time", "input": {}}}
        yield {"current_tool_use": {"toolUseId": "t1", "name": "current_time", "input": {}}}
        yield {"event": {"contentBlockDelta": {"delta": {"text": "Hello "}}}}
        yield {"data": "Hello ", "agent": object()}  # Strands events carry objects that aren't JSON
        if self.fail:
            raise RuntimeError("model throttled")
        yield {"data": "**world**\n\n| a | b |\n|---|---|\n| 1 | 2 |"}
        yield {"result": object()}


def invoke_raw(client, body, session="s" * 40):
    response = client.post("/invocations", json=body, headers={SESSION_HEADER: session})
    return response.headers["content-type"].split(";")[0], response.content


def read_with_extension(content_type, body):
    emitter = RecordingEmitter()
    handle(HttpProtocol(), fake_response(body, content_type), emitter)
    return emitter


class SampleAgentTest(unittest.TestCase):
    def setUp(self):
        agent._agents.clear()
        self.fakes = []

        def create():
            self.fakes.append(FakeStrandsAgent())
            return self.fakes[-1]

        patcher = mock.patch.object(agent, "create_agent", side_effect=create)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(agent.app)

    def test_streams_what_the_extension_reads(self):
        content_type, body = invoke_raw(self.client, {"prompt": "hi"})
        self.assertEqual(content_type, "text/event-stream")
        self.assertEqual(body.decode().split("\n\n")[0], 'data: {"current_tool_use": {"name": "current_time"}}')

        emitter = read_with_extension(content_type, body)
        self.assertEqual(emitter.text, "Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |")
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Using tool: current_time"])
        self.assertEqual(self.fakes[0].prompts, ["hi"])

    def test_one_agent_per_session(self):
        invoke_raw(self.client, {"prompt": "one"}, session="a" * 40)
        invoke_raw(self.client, {"prompt": "two"}, session="a" * 40)
        invoke_raw(self.client, {"prompt": "other chat"}, session="b" * 40)
        self.assertEqual([f.prompts for f in self.fakes], [["one", "two"], ["other chat"]])

    def test_missing_prompt_gets_a_hint(self):
        emitter = read_with_extension(*invoke_raw(self.client, {"question": "hi"}))
        self.assertEqual(emitter.text, 'Send a JSON body like {"prompt": "Hello"}.')
        self.assertEqual(self.fakes, [], "no model call")

    def test_an_exception_reaches_the_extension_as_an_error(self):
        agent._agents["s" * 40] = FakeStrandsAgent(fail=True)
        content_type, body = invoke_raw(self.client, {"prompt": "hi"})
        self.assertIn(b'"error_type": "RuntimeError"', body)
        emitter = RecordingEmitter()
        with self.assertRaises(AgentCoreError) as raised:
            handle(HttpProtocol(), fake_response(body, content_type), emitter)
        self.assertEqual(str(raised.exception), "Agent error: RuntimeError: model throttled")
        self.assertEqual(emitter.text, "Hello ", "text before the error is kept")

    def test_echo_mode_needs_no_model(self):
        with mock.patch.dict(os.environ, {"ECHO_MODE": "1"}):
            emitter = read_with_extension(*invoke_raw(self.client, {"prompt": "ping"}))
        self.assertEqual(emitter.text, agent.ECHO_REPLY.format(prompt="ping"))
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Using tool: echo"])
        self.assertEqual(self.fakes, [])

    def test_health_check(self):
        self.assertEqual(self.client.get("/ping").status_code, 200)


class RealStrandsAgentTest(unittest.TestCase):
    def test_create_agent_builds_a_strands_agent_with_the_tools(self):
        with mock.patch.dict(os.environ, {"MODEL_ID": "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"}):
            built = agent.create_agent()
        self.assertEqual(sorted(built.tool_names), ["current_time", "word_count"])
        self.assertEqual(built.model.config["model_id"], "eu.anthropic.claude-sonnet-4-5-20250929-v1:0")


if __name__ == "__main__":
    unittest.main()
