import unittest
from unittest import mock

import boto3
from botocore.exceptions import NoRegionError, UnauthorizedSSOTokenError
from botocore.stub import Stubber

from agentcore import agents, aws
from agentcore.errors import AgentCoreError, SsoExpired

ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/"


def agent(name, protocol):
    return {"name": name, "arn": ARN + name, "description": "", "protocol": protocol}


class ChatAgentsTest(unittest.TestCase):
    def test_hides_non_chat_protocols_and_sorts(self):
        result = agents._chat_agents([agent("zeta", "A2A"), agent("tools", "MCP"),
                                      agent("Alpha", "HTTP"), agent("ui", "AGUI"), agent("mystery", None)])
        self.assertEqual([a["name"] for a in result["data"]], ["Alpha", "mystery", "zeta"])
        self.assertEqual(result["note"], "2 non-chat agents (MCP/AGUI) hidden")

    def test_note_singular_and_none(self):
        self.assertEqual(agents._chat_agents([agent("t", "MCP")])["note"], "1 non-chat agent (MCP/AGUI) hidden")
        self.assertIsNone(agents._chat_agents([agent("a", "HTTP")])["note"])


class CacheTest(unittest.TestCase):
    def setUp(self):
        agents._cache.clear()
        self.backend = mock.Mock()
        self.backend.list_agents.return_value = [agent("a", "HTTP")]
        patcher = mock.patch.object(agents, "backend_for", return_value=self.backend)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(agents._cache.clear)

    def test_second_call_uses_cache(self):
        agents.list_for("dev", {})
        agents.list_for("dev", {})
        self.assertEqual(self.backend.list_agents.call_count, 1)

    def test_refresh_bypasses_cache(self):
        agents.list_for("dev", {})
        agents.list_for("dev", {}, refresh=True)
        self.assertEqual(self.backend.list_agents.call_count, 2)

    def test_cache_is_per_profile_mock_mode_and_region(self):
        agents.list_for("dev", {})
        agents.list_for("prod", {})
        agents.list_for("dev", {"mock": False})
        agents.list_for("dev", {"region": "eu-west-1"})
        self.assertEqual(self.backend.list_agents.call_count, 4)
        self.assertEqual(self.backend.list_agents.call_args.kwargs, {"region": "eu-west-1"})

    def test_cache_expires(self):
        with mock.patch.object(agents.time, "monotonic", return_value=1000.0):
            agents.list_for("dev", {})
        with mock.patch.object(agents.time, "monotonic", return_value=1000.0 + agents.CACHE_SECONDS + 1):
            agents.list_for("dev", {})
        self.assertEqual(self.backend.list_agents.call_count, 2)


class RegionTest(unittest.TestCase):
    def test_region_setting_overrides_profile_and_is_cached_separately(self):
        with mock.patch.object(aws.boto3, "Session") as session:
            aws._client("rp", "sts")
            aws._client("rp", "sts", "eu-west-1")
            aws._client("rp", "sts", "eu-west-1")
        self.addCleanup(lambda: [aws._clients.pop(k) for k in list(aws._clients) if k[0] == "rp"])
        self.assertEqual([c.kwargs for c in session.call_args_list],
                         [{"profile_name": "rp", "region_name": None},
                          {"profile_name": "rp", "region_name": "eu-west-1"}])


class ClientConfigTest(unittest.TestCase):
    def test_agent_calls_wait_ten_minutes_for_a_reply(self):
        with mock.patch.object(aws.boto3, "Session") as session:
            aws._client("cfg", "bedrock-agentcore")
            aws._client("cfg", "sts")
        self.addCleanup(lambda: [aws._clients.pop(k) for k in list(aws._clients) if k[0] == "cfg"])
        agentcore_call, sts_call = session.return_value.client.call_args_list
        self.assertEqual(agentcore_call.args, ("bedrock-agentcore",))
        self.assertEqual(agentcore_call.kwargs["config"].read_timeout, 600)
        self.assertEqual(sts_call, mock.call("sts"), "other services keep boto3's defaults")

    def test_a_real_client_gets_the_timeout(self):
        client = boto3.Session(region_name="eu-central-1", aws_access_key_id="x", aws_secret_access_key="y").client(
            "bedrock-agentcore", config=aws._CLIENT_CONFIG["bedrock-agentcore"])
        self.assertEqual(client.meta.config.read_timeout, 600)
        self.assertEqual(client.meta.config.connect_timeout, 60, "connecting still gives up after a minute")
        self.assertEqual(client.meta.config.retries["total_max_attempts"], 1, "an agent is never re-run behind the user's back")

    def test_a_timed_out_invoke_is_not_sent_again(self):
        from botocore.exceptions import ReadTimeoutError
        client = boto3.Session(region_name="eu-central-1", aws_access_key_id="x", aws_secret_access_key="y").client(
            "bedrock-agentcore", config=aws._CLIENT_CONFIG["bedrock-agentcore"])
        sent = []

        def time_out(request, **kwargs):
            sent.append(request)
            raise ReadTimeoutError(endpoint_url=request.url)

        client.meta.events.register("before-send.bedrock-agentcore.InvokeAgentRuntime", time_out)
        with self.assertRaises(ReadTimeoutError):
            client.invoke_agent_runtime(agentRuntimeArn="arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/a-1",
                                        runtimeSessionId="s" * 36, payload=b"{}")
        self.assertEqual(len(sent), 1)


class SequentialExecutor:
    """Stand-in for ThreadPoolExecutor so Stubber sees calls in a fixed order."""

    def __init__(self, max_workers=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def map(self, fn, items):
        return [fn(item) for item in items]


class AwsListAgentsTest(unittest.TestCase):
    def setUp(self):
        self.client = boto3.client("bedrock-agentcore-control", region_name="us-east-1",
                                   aws_access_key_id="x", aws_secret_access_key="y")
        self.stub = Stubber(self.client)
        aws._clients[("p", "bedrock-agentcore-control", None)] = self.client
        self.addCleanup(aws._clients.pop, ("p", "bedrock-agentcore-control", None), None)
        patcher = mock.patch.object(aws, "ThreadPoolExecutor", SequentialExecutor)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def runtime(rid, status="READY"):
        return {"agentRuntimeArn": ARN + rid, "agentRuntimeId": rid, "agentRuntimeName": rid.split("-")[0],
                "agentRuntimeVersion": "1", "description": f"{rid} desc", "status": status,
                "lastUpdatedAt": "2026-11-01T00:00:00Z"}

    def get_response(self, rid, protocol):
        self.stub.add_response("get_agent_runtime",
                               {"agentRuntimeArn": ARN + rid, "agentRuntimeName": rid.split("-")[0],
                                "agentRuntimeId": rid, "agentRuntimeVersion": "1",
                                "createdAt": "2026-11-01T00:00:00Z", "lastUpdatedAt": "2026-11-01T00:00:00Z",
                                "roleArn": "arn:aws:iam::123456789012:role/r",
                                "networkConfiguration": {"networkMode": "PUBLIC"}, "status": "READY", "lifecycleConfiguration": {},
                                "protocolConfiguration": {"serverProtocol": protocol}},
                               {"agentRuntimeId": rid})

    def test_paginates_keeps_ready_and_reads_protocols(self):
        self.stub.add_response("list_agent_runtimes",
                               {"agentRuntimes": [self.runtime("alpha-1"), self.runtime("broken-2", "CREATE_FAILED")],
                                "nextToken": "page2"}, {})
        self.stub.add_response("list_agent_runtimes", {"agentRuntimes": [self.runtime("beta-3")]},
                               {"nextToken": "page2"})
        self.get_response("alpha-1", "HTTP")
        self.get_response("beta-3", "A2A")
        with self.stub:
            result = aws.list_agents("p")
        self.assertEqual(result, [
            {"name": "alpha", "arn": ARN + "alpha-1", "description": "alpha-1 desc", "protocol": "HTTP"},
            {"name": "beta", "arn": ARN + "beta-3", "description": "beta-3 desc", "protocol": "A2A"},
        ])

    def test_protocol_lookup_failure_gives_none(self):
        self.stub.add_response("list_agent_runtimes", {"agentRuntimes": [self.runtime("alpha-1")]}, {})
        self.stub.add_client_error("get_agent_runtime", "AccessDeniedException", "no GetAgentRuntime")
        with self.stub:
            self.assertIsNone(aws.list_agents("p")[0]["protocol"])

    def test_list_permission_error_is_readable(self):
        self.stub.add_client_error("list_agent_runtimes", "AccessDeniedException", "not allowed")
        with self.stub, self.assertRaises(AgentCoreError) as ctx:
            aws.list_agents("p")
        self.assertEqual(str(ctx.exception), "Could not list agents: AccessDeniedException: not allowed")

    def test_sso_and_region_errors(self):
        for error, expected in ((UnauthorizedSSOTokenError(), SsoExpired), (NoRegionError(), AgentCoreError)):
            with mock.patch.object(self.client, "get_paginator", side_effect=error), self.assertRaises(expected):
                aws.list_agents("p")


if __name__ == "__main__":
    unittest.main()
