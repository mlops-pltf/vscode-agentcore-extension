"""Round 6e.2: trace ids (T6.28), stopping sessions (T6.27), identity (T6.29)."""
import io
import re
import unittest
from unittest import mock

import boto3
from botocore.response import StreamingBody
from botocore.stub import ANY, Stubber

from agentcore import aws, sessions, tracing
from agentcore.errors import AgentCoreError

ARN = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/agent-1"
SID = "s" * 36


class TracingTest(unittest.TestCase):
    def test_new_trace_id_is_xray_format(self):
        trace_id = tracing.new_trace_id()
        self.assertRegex(trace_id, r"^1-[0-9a-f]{8}-[0-9a-f]{24}$")
        self.assertNotEqual(trace_id, tracing.new_trace_id())
        self.assertEqual(tracing.header("1-abc-def"), "Root=1-abc-def")

    def test_root_of(self):
        self.assertEqual(tracing.root_of("Root=1-a-b;Parent=c;Sampled=1"), "1-a-b")
        self.assertEqual(tracing.root_of("Root=1-a-b"), "1-a-b")
        self.assertEqual(tracing.root_of("0af7651916cd43dd8448eb211c80319c"), "0af7651916cd43dd8448eb211c80319c")
        self.assertIsNone(tracing.root_of(""))
        self.assertIsNone(tracing.root_of(None))

    def test_reply_fields(self):
        self.assertEqual(tracing.reply_fields("1-a-b", "eu-west-1"), {
            "traceId": "1-a-b",
            "cloudwatchUrl": "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#gen-ai-observability",
        })
        self.assertEqual(tracing.reply_fields("1-a-b", None), {"traceId": "1-a-b"})
        self.assertEqual(tracing.reply_fields(None, "eu-west-1"), {})


class SessionUseTest(unittest.TestCase):
    def test_records_each_runtime_once_and_reset_returns_them(self):
        one = sessions.RuntimeUse(False, "dev", "eu-central-1", ARN)
        two = sessions.RuntimeUse(False, "dev", "eu-central-1", ARN + "-2")
        sessions.get("t1")["contextId"] = "ctx"
        for use in (one, one, two):
            sessions.record_use("t1", use)
        self.assertEqual(sessions.reset("t1"), [one, two])
        self.assertEqual(sessions.get("t1"), {})
        self.assertEqual(sessions.reset("t1"), [], "nothing left to stop")
        sessions.reset("never-used")

    def test_state_is_per_agent_within_a_chat(self):
        sessions.get("t2", "arn:a")["contextId"] = "ctx-a"
        self.assertEqual(sessions.get("t2", "arn:b"), {}, "agent b doesn't get agent a's context")
        sessions.get("t2", "arn:b")["contextId"] = "ctx-b"
        sessions.get("t3", "arn:a")["contextId"] = "other chat"
        sessions.reset("t2")
        self.assertEqual(sessions.get("t2", "arn:a"), {})
        self.assertEqual(sessions.get("t2", "arn:b"), {})
        self.assertEqual(sessions.get("t3", "arn:a"), {"contextId": "other chat"}, "other chats untouched")
        sessions.reset("t3")


def stub_client(test, service):
    client = boto3.client(service, region_name="eu-central-1", aws_access_key_id="x", aws_secret_access_key="y")
    aws._clients[("p", service, None)] = client
    test.addCleanup(aws._clients.pop, ("p", service, None), None)
    return Stubber(client)


class AwsInvokeTraceTest(unittest.TestCase):
    def setUp(self):
        self.stub = stub_client(self, "bedrock-agentcore")
        patcher = mock.patch.object(aws, "log")
        self.log = patcher.start()
        self.addCleanup(patcher.stop)

    def params(self, **extra):
        return {"agentRuntimeArn": ARN, "runtimeSessionId": SID, "payload": ANY,
                "contentType": "application/json", "accept": "application/json", **extra}

    def response(self, **extra):
        return {"response": StreamingBody(io.BytesIO(b"{}"), 2), "contentType": "application/json",
                "statusCode": 200, "runtimeSessionId": SID, **extra}

    def invoke(self):
        return aws.invoke("p", ARN, SID, b"{}", "application/json", trace_id="1-aaaaaaaa-" + "b" * 24)

    def test_sends_the_trace_id_and_prefers_the_returned_one(self):
        self.stub.add_response("invoke_agent_runtime", self.response(traceId="Root=1-cccccccc-" + "d" * 24 + ";Sampled=0"),
                               self.params(traceId="Root=1-aaaaaaaa-" + "b" * 24))
        with self.stub:
            self.assertEqual(self.invoke()["traceId"], "1-cccccccc-" + "d" * 24)

    def test_keeps_ours_when_none_is_returned(self):
        self.stub.add_response("invoke_agent_runtime", self.response(), self.params(traceId=ANY))
        with self.stub:
            self.assertEqual(self.invoke()["traceId"], "1-aaaaaaaa-" + "b" * 24)

    def test_validation_error_retries_once_without_trace_id(self):
        self.stub.add_client_error("invoke_agent_runtime", "ValidationException", "bad X-Amzn-Trace-Id",
                                   expected_params=self.params(traceId=ANY))
        self.stub.add_response("invoke_agent_runtime", self.response(), self.params())
        with self.stub:
            self.assertIsNone(self.invoke()["traceId"])
        self.assertEqual(self.log.call_args.args[1], "warn")
        self.assertIn("retrying without it", self.log.call_args.args[0])

    def test_other_errors_are_not_retried(self):
        self.stub.add_client_error("invoke_agent_runtime", "AccessDeniedException", "no",
                                   expected_params=self.params(traceId=ANY))
        with self.stub, self.assertRaises(AgentCoreError):
            self.invoke()
        self.stub.assert_no_pending_responses()

    def test_a_second_validation_error_is_reported(self):
        self.stub.add_client_error("invoke_agent_runtime", "ValidationException", "bad trace",
                                   expected_params=self.params(traceId=ANY))
        self.stub.add_client_error("invoke_agent_runtime", "ValidationException", "bad payload",
                                   expected_params=self.params())
        with self.stub, self.assertRaises(AgentCoreError) as raised:
            self.invoke()
        self.assertEqual(str(raised.exception), "ValidationException: bad payload")


class AwsStopAndIdentityTest(unittest.TestCase):
    def setUp(self):
        aws._identities.pop("p", None)
        self.addCleanup(aws._identities.pop, "p", None)

    def test_stop_runtime_session(self):
        stub = stub_client(self, "bedrock-agentcore")
        stub.add_response("stop_runtime_session", {"runtimeSessionId": SID, "statusCode": 200},
                          {"agentRuntimeArn": ARN, "runtimeSessionId": SID})
        stub.add_client_error("stop_runtime_session", "AccessDeniedException", "not allowed")
        with stub:
            aws.stop_runtime_session("p", ARN, SID)
            with self.assertRaises(AgentCoreError) as raised:
                aws.stop_runtime_session("p", ARN, SID)
        self.assertEqual(str(raised.exception), "AccessDeniedException: not allowed")

    def test_whoami_and_runtime_user_share_one_cached_identity_call(self):
        stub = stub_client(self, "sts")
        stub.add_response("get_caller_identity", {
            "UserId": "AROAEXAMPLE:jane@example.com", "Account": "123456789012",
            "Arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Dev_abc/jane@example.com"}, {})
        with stub, mock.patch.object(aws.boto3, "Session") as session:
            session.return_value.region_name = "us-west-2"
            self.assertEqual(aws.whoami("p"), {
                "account": "123456789012", "user": "jane@example.com", "region": "us-west-2",
                "arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Dev_abc/jane@example.com"})
            self.assertEqual(aws.whoami("p", region="eu-central-1")["region"], "eu-central-1", "setting wins")
            self.assertEqual(aws.get_runtime_user_id("p"), "jane@example.com")

    def test_iam_user_identity_uses_user_id(self):
        stub = stub_client(self, "sts")
        stub.add_response("get_caller_identity", {"UserId": "AIDAEXAMPLE", "Account": "1",
                                                  "Arn": "arn:aws:iam::1:user/bob"}, {})
        with stub:
            self.assertEqual(aws.get_runtime_user_id("p"), "AIDAEXAMPLE")


if __name__ == "__main__":
    unittest.main()
