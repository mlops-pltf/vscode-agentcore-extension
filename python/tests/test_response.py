import io
import json
import sys
import unittest

from agentcore import events, sessions
from agentcore.backends import is_mock
from agentcore.cancel import CancelToken
from agentcore.errors import AgentCoreError
from agentcore.response import AgentResponse, Event
from tests.helpers import RecordingEmitter, fake_response


def events_of(raw):
    return list(AgentResponse(raw, RecordingEmitter(), CancelToken()).events())


class AgentResponseTest(unittest.TestCase):
    def test_sse_events_are_parsed_and_streamed(self):
        raw = fake_response(b'data: {"a": 1}\n\ndata: plain\n\ndata: [DONE]\n\n', "text/event-stream")
        self.assertEqual(events_of(raw), [Event({"a": 1}, False), Event("plain", False)])

    def test_json_body_is_one_whole_event(self):
        self.assertEqual(events_of(fake_response(b'{"a": 1}', "application/json")),
                         [Event({"a": 1}, True)])

    def test_content_type_is_normalised(self):
        response = AgentResponse(fake_response(b"{}", "Application/JSON; charset=utf-8"),
                                 RecordingEmitter(), CancelToken())
        self.assertEqual(response.content_type, "application/json")

    def test_error_status_raises(self):
        with self.assertRaises(AgentCoreError):
            events_of(fake_response(b"nope", "text/plain", status=502))

    def test_body_is_logged_raw(self):
        emitter = RecordingEmitter()
        list(AgentResponse(fake_response(b'{"a": 1}', "application/json"), emitter, CancelToken()).events())
        self.assertEqual([e["line"] for e in emitter.of("raw")], ['{"a": 1}'])

    def test_cancel_before_reading_yields_nothing(self):
        token = CancelToken()
        token.cancel()
        raw = fake_response(b"data: a\n\n", "text/event-stream")
        self.assertEqual(list(AgentResponse(raw, RecordingEmitter(), token).events()), [])


class SessionsTest(unittest.TestCase):
    def test_state_persists_until_reset(self):
        sessions.get("s1")["contextId"] = "ctx"
        self.assertEqual(sessions.get("s1"), {"contextId": "ctx"})
        sessions.reset("s1")
        self.assertEqual(sessions.get("s1"), {})
        sessions.reset("unknown")  # no error


class BackendsTest(unittest.TestCase):
    def test_mock_unless_explicitly_off(self):
        self.assertTrue(is_mock({}))
        self.assertTrue(is_mock({"mock": True}))
        self.assertTrue(is_mock({"mock": None}))
        self.assertFalse(is_mock({"mock": False}))


class ClaimStdoutTest(unittest.TestCase):
    def test_stray_prints_go_to_stderr(self):
        saved_out, saved_err, saved_events_out = sys.stdout, sys.stderr, events._out
        real_out, fake_err = io.StringIO(), io.StringIO()
        try:
            sys.stdout, sys.stderr = real_out, fake_err
            events.claim_stdout()
            print("library chatter")
            events.send({"type": "ping"})
        finally:
            sys.stdout, sys.stderr, events._out = saved_out, saved_err, saved_events_out
        self.assertEqual([json.loads(l) for l in real_out.getvalue().splitlines()], [{"type": "ping"}])
        self.assertIn("library chatter", fake_err.getvalue())


if __name__ == "__main__":
    unittest.main()
