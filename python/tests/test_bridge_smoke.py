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

        b = self.for_request(events, "B")
        self.assertEqual(b[-1]["meta"]["contentType"], "application/json")

        c = self.for_request(events, "C")
        self.assertEqual([e["type"] for e in c], ["error"])

    def test_cancel(self):
        events = self.run_bridge([invoke("S", "slow")], [{"action": "cancel", "requestId": "S"}], pause=1.5)
        s = self.for_request(events, "S")
        self.assertEqual(s[-1]["type"], "done")
        self.assertEqual(s[-1]["meta"]["state"], "cancelled")

    def test_unsupported_protocol(self):
        cmd = dict(invoke("P", "hi"), protocol="MCP")
        events = self.run_bridge([cmd])
        self.assertEqual(self.for_request(events, "P"),
                         [{"type": "error", "message": "Protocol MCP is not supported yet", "requestId": "P"}])


if __name__ == "__main__":
    unittest.main()
