"""Runs bridge.py as a subprocess, like the extension does, against the mock runtime."""
import json
import os
import subprocess
import sys
import time
import unittest

BRIDGE = os.path.join(os.path.dirname(__file__), "..", "bridge.py")
ARN = "arn:x:runtime/demo"


def invoke(request_id, prompt):
    return {"action": "invoke_agent", "requestId": request_id, "profile": "dev",
            "agentArn": ARN, "prompt": prompt, "sessionId": "s" * 36}


class BridgeSmokeTest(unittest.TestCase):
    def run_bridge(self, *batches, pause=0.0):
        """Send each batch of commands, pausing between batches; return parsed events."""
        proc = subprocess.Popen([sys.executable, "-W", "ignore", BRIDGE],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        for i, batch in enumerate(batches):
            if i:
                time.sleep(pause)
            for cmd in batch:
                proc.stdin.write(json.dumps(cmd) + "\n")
            proc.stdin.flush()
        out, _ = proc.communicate(timeout=30)
        return [json.loads(line) for line in out.splitlines()]

    @staticmethod
    def for_request(events, request_id):
        return [e for e in events if e.get("requestId") == request_id]

    def test_concurrent_requests_stream_clean_text(self):
        events = self.run_bridge([invoke("A", "hi"), invoke("B", "json please"), invoke("C", "error")])

        a = self.for_request(events, "A")
        self.assertEqual("".join(e["text"] for e in a if e["type"] == "chunk"),
                         "You said: 'hi'. This is a mock reply from demo, streamed word by word.")
        self.assertEqual(a[-1]["type"], "done")
        self.assertEqual(a[-1]["meta"]["protocol"], "HTTP")
        self.assertEqual(a[-1]["meta"]["state"], "completed")
        self.assertIs(a[-1]["meta"]["mock"], True)

        b = self.for_request(events, "B")
        self.assertEqual(b[-1]["meta"]["contentType"], "application/json")

        c = self.for_request(events, "C")
        self.assertEqual([e["type"] for e in c], ["error"])

    def test_markdown_reply_keeps_newlines_and_indentation(self):
        from agentcore.mock_runtime import MARKDOWN_SAMPLE
        a2a = dict(invoke("M2", "markdown please"), protocol="A2A")
        a2a_stream = dict(a2a, requestId="M3", settings={"a2aStreaming": True})
        events = self.run_bridge([invoke("M1", "markdown please"), a2a, a2a_stream])
        for request_id in ("M1", "M2", "M3"):
            chunks = [e["text"] for e in self.for_request(events, request_id) if e["type"] == "chunk"]
            self.assertEqual("".join(chunks), MARKDOWN_SAMPLE, request_id)

    def test_slow_one_piece_answer_waits_and_can_be_cancelled(self):
        slow = dict(invoke("W", "slow"), protocol="A2A")
        stopped = dict(invoke("X", "slow json"), requestId="X")
        events = self.run_bridge([slow, stopped], [{"action": "cancel", "requestId": "X"}], pause=0.5)
        w = self.for_request(events, "W")
        self.assertEqual(w[-1]["type"], "done")
        self.assertEqual(w[-1]["meta"]["state"], "completed")
        self.assertGreaterEqual(w[-1]["meta"]["ms"], 3000)
        self.assertTrue(any(e["type"] == "chunk" for e in w))
        x = self.for_request(events, "X")
        self.assertEqual([e["type"] for e in x], ["done"])
        self.assertEqual(x[-1]["meta"]["state"], "cancelled")

    def test_agent_card_action(self):
        a2a = {"action": "get_agent_card", "profile": "dev", "agentArn": "arn:x:runtime/demo_a2a-1"}
        other = dict(a2a, agentArn="arn:x:runtime/demo_http-1")
        events = self.run_bridge([a2a, other])
        found = {e["agentArn"]: e for e in events if e["type"] == "agent_card"}
        self.assertEqual(found[a2a["agentArn"]]["profile"], "dev")
        self.assertEqual(found[a2a["agentArn"]]["card"]["skills"][0]["name"], "Deploy services")
        self.assertIsNone(found[other["agentArn"]]["card"])
        self.assertTrue(found[other["agentArn"]]["note"].startswith("No Agent Card"))
        self.assertTrue(any(e["type"] == "log" and e["level"] == "warn" for e in events), "logged")

    def test_replies_carry_trace_ids(self):
        ok = dict(invoke("T1", "hi"), settings={"region": "eu-west-1"})
        failed = dict(invoke("T2", "fail"), protocol="A2A")
        events = self.run_bridge([ok, failed, invoke("T3", "error")])
        done = self.for_request(events, "T1")[-1]["meta"]
        self.assertRegex(done["traceId"], r"^1-[0-9a-f]{8}-[0-9a-f]{24}$")
        self.assertEqual(done["cloudwatchUrl"],
                         "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#gen-ai-observability")
        agent_failed = self.for_request(events, "T2")[-1]
        self.assertEqual(agent_failed["type"], "error")
        self.assertIn("traceId", agent_failed, "the agent was reached: its trace helps")
        self.assertIn("region=eu-central-1", agent_failed["cloudwatchUrl"], "profile/mock region when not set")
        not_reached = self.for_request(events, "T3")[-1]
        self.assertNotIn("traceId", not_reached, "the call itself failed: no trace")

    def test_new_chat_stops_the_runtime_sessions_it_used(self):
        sid = "n" * 36
        first = dict(invoke("N1", "hi"), sessionId=sid, agentArn="arn:x:runtime/demo_http-1")
        second = dict(invoke("N2", "hi"), sessionId=sid, agentArn="arn:x:runtime/demo_unknown-1")
        events = self.run_bridge([first, second], [{"action": "reset_session", "sessionId": sid},
                                                   {"action": "reset_session", "sessionId": "unused" * 6}], pause=1.0)
        logs = [(e["level"], e["message"]) for e in events if e["type"] == "log"]
        self.assertIn(("info", "Stopped runtime session nnnnnnnn... on demo_http-1"), logs)
        self.assertIn(("warn", "Could not stop runtime session nnnnnnnn... on demo_unknown-1: AccessDeniedException: "
                               "mock role lacks bedrock-agentcore:StopRuntimeSession "
                               "(needs bedrock-agentcore:StopRuntimeSession)"), logs)
        self.assertEqual(len(logs), 2, "an unused session stops nothing")

    def test_whoami(self):
        events = self.run_bridge([{"action": "whoami", "profile": "dev", "settings": {"region": "eu-west-1"}}])
        identity = [e for e in events if e["type"] == "identity"][0]
        self.assertEqual(identity["profile"], "dev")
        self.assertEqual(identity["account"], "123456789012")
        self.assertEqual(identity["user"], "mock-user@example.com")
        self.assertEqual(identity["region"], "eu-west-1")
        self.assertTrue(any(e["type"] == "log" and e["message"].startswith("Profile dev: mock-user") for e in events))

    def test_two_agents_in_one_chat_keep_their_own_a2a_context(self):
        sid = "m" * 36
        first = dict(invoke("A1", "hi"), protocol="A2A", sessionId=sid, agentArn="arn:x:runtime/agent_a")
        other = dict(invoke("B1", "hi"), protocol="A2A", sessionId=sid, agentArn="arn:x:runtime/agent_b")
        again = dict(invoke("A2", "again"), protocol="A2A", sessionId=sid, agentArn="arn:x:runtime/agent_a")
        events = self.run_bridge([first], [other], [again], pause=1.0)
        context = {rid: self.for_request(events, rid)[-1]["meta"]["contextId"] for rid in ("A1", "B1", "A2")}
        self.assertNotEqual(context["A1"], context["B1"], "agent b starts its own conversation")
        self.assertEqual(context["A1"], context["A2"], "agent a continues where it was")

    def test_cancel(self):
        events = self.run_bridge([invoke("S", "slow")], [{"action": "cancel", "requestId": "S"}], pause=1.5)
        s = self.for_request(events, "S")
        self.assertEqual(s[-1]["type"], "done")
        self.assertEqual(s[-1]["meta"]["state"], "cancelled")

    def test_a2a_conversation_keeps_context_until_reset(self):
        sid = "a" * 36
        proc = subprocess.Popen([sys.executable, "-W", "ignore", BRIDGE],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)

        def turn(request_id, prompt):
            """Send one A2A turn and wait for its reply, like the panel does."""
            proc.stdin.write(json.dumps(dict(invoke(request_id, prompt), protocol="A2A", sessionId=sid)) + "\n")
            proc.stdin.flush()
            events = []
            for line in proc.stdout:
                event = json.loads(line)
                if event.get("requestId") == request_id:
                    events.append(event)
                    if event["type"] in ("done", "error"):
                        return events

        first, second = turn("T1", "hi"), turn("T2", "again")
        proc.stdin.write(json.dumps({"action": "reset_session", "sessionId": sid}) + "\n")
        third = turn("T3", "fresh")

        done = {"T1": first[-1], "T2": second[-1], "T3": third[-1]}
        self.assertTrue(all(d["type"] == "done" and d["meta"]["protocol"] == "A2A" for d in done.values()), done)
        self.assertEqual(done["T1"]["meta"]["contextId"], done["T2"]["meta"]["contextId"])
        self.assertNotEqual(done["T2"]["meta"]["contextId"], done["T3"]["meta"]["contextId"])
        text = "".join(e["text"] for e in first if e["type"] == "chunk")
        self.assertEqual(text, "You said: 'hi'. This is a mock reply from demo, streamed word by word.")

    def test_list_agents_tags_profile_and_hides_non_chat_agents(self):
        events = self.run_bridge([{"action": "list_agents", "profile": "dev"},
                                  {"action": "list_agents", "profile": "dev", "refresh": True}])
        self.assertEqual([e["type"] for e in events], ["agents", "agents"])
        first = events[0]
        self.assertEqual(first["profile"], "dev")
        self.assertEqual([(a["name"], a["protocol"]) for a in first["data"]],
                         [("demo-a2a", "A2A"), ("demo-http-strands", "HTTP"), ("demo-unknown", None)])
        self.assertEqual(first["note"], "1 non-chat agent (MCP/AGUI) hidden")

    def test_reset_session_is_accepted(self):
        events = self.run_bridge([{"action": "reset_session", "sessionId": "s" * 36}])
        self.assertEqual(events, [])

    def test_unsupported_protocol(self):
        cmd = dict(invoke("P", "hi"), protocol="MCP")
        events = self.run_bridge([cmd])
        self.assertEqual(self.for_request(events, "P"),
                         [{"type": "error", "message": "Protocol MCP is not supported yet", "requestId": "P"}])


if __name__ == "__main__":
    unittest.main()
