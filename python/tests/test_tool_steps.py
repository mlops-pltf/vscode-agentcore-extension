"""Phase 13: tool calls as steps in the reply."""
import unittest

from agentcore import tool_steps as ts


class StepsInTest(unittest.TestCase):
    def test_current_tool_use(self):
        self.assertEqual(ts.steps_in({"current_tool_use": {"toolUseId": "a", "name": "t", "input": '{"q": "x'}}),
                         [{"id": "a", "name": "t", "status": "running"}], "unfinished input ignored")
        self.assertEqual(ts.steps_in({"current_tool_use": {"toolUseId": "a", "name": "t", "input": {"q": "x"}}}),
                         [{"id": "a", "name": "t", "status": "running", "input": '{"q": "x"}'}])
        self.assertEqual(ts.steps_in({"current_tool_use": {"name": "t"}}), [{"id": "t", "name": "t", "status": "running"}],
                         "no id: the name stands in")
        self.assertEqual(ts.steps_in({"current_tool_use": {"toolUseId": "a"}}), [], "no name: nothing to show")

    def test_tool_result(self):
        self.assertEqual(ts.steps_in({"tool_result": {"toolUseId": "a", "status": "success", "content": "10:42"}}),
                         [{"id": "a", "status": "success", "result": "10:42"}])
        self.assertEqual(ts.steps_in({"tool_result": {"toolUseId": "a", "status": "error",
                                                      "content": [{"text": "timed"}, {"text": "out"}]}}),
                         [{"id": "a", "status": "error", "result": "timed out"}])
        self.assertEqual(ts.steps_in({"tool_result": {"toolUseId": "a", "content": [{"json": {"n": 1}}]}}),
                         [{"id": "a", "status": "success", "result": '{"n": 1}'}])

    def test_strands_messages(self):
        assistant = {"message": {"role": "assistant", "content": [
            {"text": "Let me check."}, {"toolUse": {"toolUseId": "a", "name": "t", "input": {}}},
            {"toolUse": {"toolUseId": "b", "name": "u", "input": {"x": 1}}}]}}
        self.assertEqual(ts.steps_in(assistant), [{"id": "a", "name": "t", "status": "running"},
                                                  {"id": "b", "name": "u", "status": "running", "input": '{"x": 1}'}])
        user = {"message": {"role": "user", "content": [{"toolResult": {"toolUseId": "a", "status": "success", "content": []}}]}}
        self.assertEqual(ts.steps_in(user), [{"id": "a", "status": "success"}])
        self.assertEqual(ts.steps_in({"message": {"role": "user", "content": [{"text": "hi"}]}}), [])

    def test_other_events_and_shortening(self):
        for event in ({"data": "x"}, "text", None, {"message": "plain"}):
            self.assertEqual(ts.steps_in(event), [])
        long = ts.steps_in({"tool_result": {"toolUseId": "a", "content": "y" * 5000}})[0]["result"]
        self.assertEqual(len(long), ts.MAX_RESULT)
        self.assertTrue(long.endswith("…"))


class TrackerTest(unittest.TestCase):
    def test_sends_only_changes_and_never_goes_back_to_running(self):
        tracker = ts.StepTracker()
        self.assertEqual(tracker.update({"id": "a", "name": "t", "status": "running"}),
                         {"id": "a", "name": "t", "status": "running"})
        self.assertIsNone(tracker.update({"id": "a", "name": "t", "status": "running"}), "repeat: nothing new")
        self.assertEqual(tracker.update({"id": "a", "status": "success", "result": "ok"}),
                         {"id": "a", "name": "t", "status": "success", "result": "ok"})
        self.assertEqual(tracker.update({"id": "a", "name": "t", "status": "running", "input": "{}"}),
                         {"id": "a", "name": "t", "status": "success", "result": "ok", "input": "{}"},
                         "a late input keeps the finished status")
        self.assertEqual(tracker.update({"id": "z", "status": "error"}), {"id": "z", "status": "error", "name": "tool"})
