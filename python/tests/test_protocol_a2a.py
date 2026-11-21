import json
import unittest

from agentcore import mock_runtime
from agentcore.errors import AgentCoreError
from agentcore.protocols.a2a import A2aProtocol, parts_to_text
from tests.helpers import RecordingEmitter, context, fixture_response, handle

A2A = A2aProtocol()


def run(response, session_state=None, **settings):
    emitter = RecordingEmitter()
    state = {} if session_state is None else session_state
    meta = handle(A2A, response, emitter, ctx=context(session_state=state, **settings))
    return emitter, meta, state


class BuildPayloadTest(unittest.TestCase):
    def payload(self, session_state=None, **settings):
        return json.loads(A2A.build_payload(context("hi", session_state=session_state or {}, **settings)))

    def test_first_turn_is_message_send(self):
        request = self.payload()
        self.assertEqual(request["jsonrpc"], "2.0")
        self.assertEqual(request["id"], "test")
        self.assertEqual(request["method"], "message/send")
        message = request["params"]["message"]
        self.assertEqual(message["role"], "user")
        self.assertEqual(message["parts"], [{"kind": "text", "text": "hi"}])
        self.assertTrue(message["messageId"])
        self.assertNotIn("contextId", message)
        self.assertNotIn("taskId", message)

    def test_streaming_setting_switches_method(self):
        self.assertEqual(self.payload(a2aStreaming=True)["method"], "message/stream")

    def test_later_turns_carry_context_and_pending_task(self):
        message = self.payload({"contextId": "ctx-1", "pendingTaskId": "task-3"})["params"]["message"]
        self.assertEqual(message["contextId"], "ctx-1")
        self.assertEqual(message["taskId"], "task-3")


class SendFixturesTest(unittest.TestCase):
    def test_message_result(self):
        emitter, meta, state = run(fixture_response("a2a/send_message.json"))
        self.assertEqual(emitter.text, "Hello from A2A.")
        self.assertEqual(meta["contextId"], "ctx-1")
        self.assertEqual(state, {"contextId": "ctx-1"})

    def test_completed_task_shows_all_artifacts(self):
        emitter, meta, state = run(fixture_response("a2a/send_task_completed.json"))
        self.assertEqual(emitter.text, "Part one.\n\nPart two.")
        self.assertEqual((meta["taskState"], meta["taskId"]), ("completed", "task-1"))
        self.assertNotIn("pendingTaskId", state)

    def test_failed_task_raises_with_agent_message(self):
        with self.assertRaises(AgentCoreError) as ctx:
            run(fixture_response("a2a/send_task_failed.json"))
        self.assertEqual(str(ctx.exception), "Agent task failed: Upstream API timed out.")

    def test_failed_task_still_keeps_context(self):
        state = {}
        with self.assertRaises(AgentCoreError):
            run(fixture_response("a2a/send_task_failed.json"), session_state=state)
        self.assertEqual(state, {"contextId": "ctx-1"})

    def test_input_required_shows_question_and_remembers_task(self):
        emitter, meta, state = run(fixture_response("a2a/send_task_input_required.json"))
        self.assertEqual(emitter.text, "Which region?")
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Agent is waiting for your input"])
        self.assertEqual(state, {"contextId": "ctx-1", "pendingTaskId": "task-3"})

    def test_jsonrpc_error(self):
        with self.assertRaises(AgentCoreError) as ctx:
            run(fixture_response("a2a/rpc_error.json"))
        self.assertEqual(str(ctx.exception), "A2A error -32602: Invalid params")

    def test_legacy_type_parts_and_missing_kind(self):
        emitter, meta, _ = run(fixture_response("a2a/legacy_type_parts.json"))
        self.assertEqual(emitter.text, "Legacy hello.")
        self.assertEqual(meta["contextId"], "ctx-old")

    def test_data_and_file_parts(self):
        text = run(fixture_response("a2a/data_and_file_parts.json"))[0].text
        self.assertTrue(text.startswith("Report:\n```json\n"), text)
        self.assertIn('"rows": 2', text)
        self.assertIn("📎 report.csv (s3://bucket/report.csv)", text)


class StreamFixturesTest(unittest.TestCase):
    def test_stream_with_final_snapshot_has_no_duplicate_text(self):
        emitter, meta, state = run(fixture_response("a2a/stream_task.sse"))
        self.assertEqual(emitter.text, "Hello world!")
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Thinking..."])
        self.assertEqual((meta["taskState"], meta["taskId"], meta["contextId"]), ("completed", "task-9", "ctx-9"))
        self.assertEqual(state, {"contextId": "ctx-9"})


class PartsToTextTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(parts_to_text(None), "")
        self.assertEqual(parts_to_text([]), "")

    def test_embedded_file_without_uri(self):
        self.assertIn("📎 a.bin (embedded)", parts_to_text([{"kind": "file", "file": {"name": "a.bin", "bytes": "AAA="}}]))

    def test_unknown_part_kinds_are_skipped(self):
        self.assertEqual(parts_to_text([{"kind": "video"}, {"kind": "text", "text": "x"}]), "x")


class MockConversationTest(unittest.TestCase):
    """Multi-turn conversations against the mock, through build_payload and handle."""

    def setUp(self):
        self._delay = mock_runtime.FAST_DELAY
        mock_runtime.FAST_DELAY = 0

    def tearDown(self):
        mock_runtime.FAST_DELAY = self._delay

    def turn(self, prompt, state, **settings):
        ctx = context(prompt, session_state=state, **settings)
        raw = mock_runtime.invoke("p", "arn:x:runtime/demo-a2a", "s" * 36, A2A.build_payload(ctx), A2A.accept)
        emitter = RecordingEmitter()
        meta = handle(A2A, raw, emitter, ctx=ctx)
        return emitter, meta

    def test_context_carries_across_turns(self):
        state = {}
        _, first = self.turn("hi", state)
        _, second = self.turn("again", state)
        self.assertEqual(first["contextId"], second["contextId"])

    def test_input_required_then_continue_same_task(self):
        state = {}
        asked, first = self.turn("need input", state)
        self.assertEqual(asked.text, "Which environment should I use: dev or prod?")
        answered, second = self.turn("dev", state)
        self.assertTrue(answered.text.startswith(f"Thanks, continuing task {first['taskId']}."), answered.text)
        self.assertEqual(second["taskState"], "completed")
        self.assertNotIn("pendingTaskId", state)

    def test_streaming_mock(self):
        emitter, meta = self.turn("tool hi", {}, a2aStreaming=True)
        self.assertEqual(emitter.text, "You said: 'tool hi'. This is a mock reply from demo-a2a, streamed word by word.")
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Thinking...", "Calling tool: web_search"])
        self.assertEqual(meta["taskState"], "completed")

    def test_streaming_failure(self):
        with self.assertRaises(AgentCoreError):
            self.turn("please fail", {}, a2aStreaming=True)

    def test_rpc_error(self):
        with self.assertRaises(AgentCoreError):
            self.turn("rpcerror", {})


if __name__ == "__main__":
    unittest.main()
