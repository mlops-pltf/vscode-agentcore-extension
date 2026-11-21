import json
import unittest
from unittest import mock

import boto3
from botocore.stub import Stubber

from agentcore import aws, cards, mock_runtime
from agentcore.errors import AgentCoreError, SsoExpired
from agentcore.protocols.a2a import A2aProtocol
from agentcore.protocols.base import InvokeContext

ARN = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/agent-1"


class SummarizeTest(unittest.TestCase):
    def test_reads_the_a2a_card_fields(self):
        summary = cards.summarize(mock_runtime.MOCK_AGENT_CARD)
        self.assertEqual(summary["name"], "demo-a2a")
        self.assertEqual(summary["version"], "1.2.0")
        self.assertIs(summary["streaming"], True)
        self.assertEqual(summary["skills"][0], {
            "name": "Deploy services",
            "description": "Plans and runs deployments to dev or prod.",
            "examples": ["Deploy the billing service (I'll ask for input)", "Show the deployment guide as markdown"],
        })

    def test_tolerates_missing_and_odd_fields(self):
        summary = cards.summarize({
            "capabilities": {"streaming": "yes"},  # not a real true
            "skills": [
                "not a dict",
                {"id": "only-id", "examples": ["  ok  ", "", 42, None]},
                {"description": "no name or id"},
            ],
        })
        self.assertEqual(summary, {"name": "", "description": "", "version": "", "streaming": False,
                                   "skills": [{"name": "only-id", "description": "", "examples": ["ok"]}]})
        self.assertEqual(cards.summarize({})["skills"], [])
        self.assertIsNone(cards.summarize(None))
        self.assertIsNone(cards.summarize(["a list"]))

    def test_limits_skills_and_examples(self):
        many = {"skills": [{"name": f"s{i}", "examples": [f"e{j}" for j in range(10)]} for i in range(20)]}
        summary = cards.summarize(many)
        self.assertEqual(len(summary["skills"]), cards.MAX_SKILLS)
        self.assertEqual(len(summary["skills"][0]["examples"]), cards.MAX_EXAMPLES)


class GetForTest(unittest.TestCase):
    def setUp(self):
        cards.clear()
        self.addCleanup(cards.clear)
        self.backend = mock.Mock()
        self.backend.get_agent_card.return_value = {"name": "a", "capabilities": {"streaming": True}}
        for target, value in (("backend_for", mock.Mock(return_value=self.backend)), ("log", mock.Mock())):
            patcher = mock.patch.object(cards, target, value)
            setattr(self, target, patcher.start())
            self.addCleanup(patcher.stop)

    def test_cached_per_agent_and_refreshable(self):
        first = cards.get_for("dev", ARN, {"region": "eu-west-1"})
        cards.get_for("dev", ARN, {"region": "eu-west-1"})
        self.assertEqual(self.backend.get_agent_card.call_count, 1)
        self.assertEqual(self.backend.get_agent_card.call_args, mock.call("dev", ARN, region="eu-west-1"))
        self.assertEqual(first["card"]["name"], "a")
        self.assertIsNone(first["note"])

        cards.get_for("dev", ARN + "-other", {"region": "eu-west-1"})
        cards.get_for("dev", ARN, {"region": "eu-west-1"}, refresh=True)
        self.assertEqual(self.backend.get_agent_card.call_count, 3)
        cards.clear()
        cards.get_for("dev", ARN, {"region": "eu-west-1"})
        self.assertEqual(self.backend.get_agent_card.call_count, 4)

    def test_no_permission_is_a_note_logged_and_cached(self):
        self.backend.get_agent_card.side_effect = AgentCoreError("AccessDeniedException: not allowed")
        result = cards.get_for("dev", ARN, {})
        self.assertEqual(result, {"card": None,
                                  "note": "No permission to read the Agent Card (bedrock-agentcore:GetAgentCard)"})
        self.assertEqual(self.log.call_args.args[1], "warn")
        cards.get_for("dev", ARN, {})
        self.assertEqual(self.backend.get_agent_card.call_count, 1, "asked once")

    def test_other_errors_and_expired_sso(self):
        self.backend.get_agent_card.side_effect = AgentCoreError("ResourceNotFoundException: none")
        self.assertEqual(cards.get_for("dev", ARN, {})["note"], "No Agent Card: ResourceNotFoundException: none")

        self.backend.get_agent_card.side_effect = SsoExpired("prod")
        self.assertEqual(cards.get_for("prod", ARN, {}), {"card": None, "note": "SSO session expired"})
        cards.get_for("prod", ARN, {})
        self.assertEqual(self.backend.get_agent_card.call_count, 3, "expired SSO is not cached")


class StreamingChoiceTest(unittest.TestCase):
    def test_mode_from_setting_including_old_booleans(self):
        self.assertEqual(cards.streaming_mode({}), "auto")
        self.assertEqual(cards.streaming_mode({"a2aStreaming": True}), "on")
        self.assertEqual(cards.streaming_mode({"a2aStreaming": False}), "off")
        self.assertEqual(cards.streaming_mode({"a2aStreaming": "off"}), "off")
        self.assertEqual(cards.streaming_mode({"a2aStreaming": "nonsense"}), "auto")

    def test_on_and_off_never_read_the_card(self):
        with mock.patch.object(cards, "get_for") as get_for:
            self.assertTrue(cards.use_streaming("dev", ARN, {"a2aStreaming": "on"}))
            self.assertFalse(cards.use_streaming("dev", ARN, {"a2aStreaming": "off"}))
        get_for.assert_not_called()

    def test_auto_follows_the_card(self):
        for card, expected in (({"streaming": True}, True), ({"streaming": False}, False), (None, False)):
            with mock.patch.object(cards, "get_for", return_value={"card": card, "note": None}):
                self.assertIs(cards.use_streaming("dev", ARN, {"a2aStreaming": "auto"}), expected)

    def test_a2a_payload_uses_the_mock_card(self):
        self.addCleanup(cards.clear)
        with mock.patch.object(cards, "log"):
            def method(arn):
                ctx = InvokeContext(request_id="r", prompt="hi", session_id="s" * 36, settings={"mock": True},
                                    session_state={}, profile="dev", agent_arn=arn)
                return json.loads(A2aProtocol().build_payload(ctx))["method"]
            self.assertEqual(method(mock_runtime._MOCK_ARN + "demo_a2a-Gh56Ij78Kl"), "message/stream")
            self.assertEqual(method(mock_runtime._MOCK_ARN + "demo_unknown-Mn90Op12Qr"), "message/send")


class AwsGetAgentCardTest(unittest.TestCase):
    def setUp(self):
        self.client = boto3.client("bedrock-agentcore", region_name="eu-central-1",
                                   aws_access_key_id="x", aws_secret_access_key="y")
        self.stub = Stubber(self.client)
        aws._clients[("p", "bedrock-agentcore", None)] = self.client
        self.addCleanup(aws._clients.pop, ("p", "bedrock-agentcore", None), None)

    def test_returns_the_card_document(self):
        self.stub.add_response("get_agent_card", {"agentCard": {"name": "x", "skills": []}, "statusCode": 200},
                               {"agentRuntimeArn": ARN})
        with self.stub:
            self.assertEqual(aws.get_agent_card("p", ARN), {"name": "x", "skills": []})

    def test_errors_become_agentcore_errors(self):
        self.stub.add_client_error("get_agent_card", "AccessDeniedException", "not authorized")
        with self.stub, self.assertRaises(AgentCoreError) as raised:
            aws.get_agent_card("p", ARN)
        self.assertEqual(str(raised.exception), "AccessDeniedException: not authorized")
