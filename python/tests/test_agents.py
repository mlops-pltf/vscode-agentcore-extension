import unittest
from unittest import mock

import boto3
from botocore.exceptions import NoRegionError, UnauthorizedSSOTokenError
from botocore.stub import Stubber

from agentcore import aws
from agentcore.errors import AgentCoreError, SsoExpired

ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/"


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
        aws._clients[("p", "bedrock-agentcore-control")] = self.client
        self.addCleanup(aws._clients.pop, ("p", "bedrock-agentcore-control"), None)
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
