import unittest

from agentcore.text_extract import DATA, ERROR, FINAL, RAW_EVENT, TOOL, extract_text


class ExtractTextTest(unittest.TestCase):
    def check(self, obj, text, kind):
        self.assertEqual(extract_text(obj), (text, kind), obj)

    def test_plain_string(self):
        self.check("hi", "hi", DATA)

    def test_strands_data_event(self):
        self.check({"data": "hi", "delta": {"text": "hi"}}, "hi", DATA)

    def test_raw_bedrock_delta(self):
        self.check({"event": {"contentBlockDelta": {"delta": {"text": "hi"}}}}, "hi", RAW_EVENT)

    def test_raw_bedrock_non_text_event(self):
        self.check({"event": {"messageStop": {"stopReason": "end_turn"}}}, None, None)

    def test_tool_use(self):
        self.check({"current_tool_use": {"toolUseId": "t", "name": "search"}}, "search", TOOL)

    def test_final_result_string(self):
        self.check({"result": "all of it"}, "all of it", FINAL)

    def test_final_result_message(self):
        self.check({"result": {"role": "assistant", "content": [{"text": "a"}, {"text": "b"}]}}, "ab", FINAL)

    def test_assistant_message_is_final(self):
        self.check({"message": {"role": "assistant", "content": [{"text": "a"}]}}, "a", FINAL)

    def test_tool_result_message_is_ignored(self):
        self.check({"message": {"role": "user", "content": [{"toolResult": {}}]}}, None, None)

    def test_message_string(self):
        self.check({"message": "hi"}, "hi", DATA)

    def test_delta_shapes(self):
        self.check({"delta": {"text": "hi"}}, "hi", DATA)
        self.check({"delta": "hi"}, "hi", DATA)

    def test_generic_keys(self):
        for key in ("text", "content", "output", "response", "answer", "completion"):
            self.check({key: "hi"}, "hi", DATA)

    def test_content_blocks(self):
        self.check({"content": [{"text": "a"}, {"image": {}}, {"text": "b"}]}, "ab", DATA)

    def test_nested_output(self):
        self.check({"output": {"message": {"role": "assistant", "content": [{"text": "x"}]}}}, "x", FINAL)

    def test_lifecycle_events_are_ignored(self):
        for obj in ({"init_event_loop": True}, {"start": True}, {"status": "ok"}, 42, None, ["a"]):
            self.check(obj, None, None)


if __name__ == "__main__":
    unittest.main()


class ErrorEventTest(unittest.TestCase):
    def test_bedrock_agentcore_app_stream_error(self):
        event = {"error": "model throttled", "error_type": "ThrottlingException",
                 "message": "An error occurred during streaming"}
        self.assertEqual(extract_text(event), ("ThrottlingException: model throttled", ERROR))

    def test_other_error_shapes(self):
        self.assertEqual(extract_text({"error": "bad input"}), ("bad input", ERROR))
        self.assertEqual(extract_text({"error": {"message": "nope", "code": 7}}), ("nope", ERROR))
        self.assertEqual(extract_text({"error": None, "text": "fine"}), ("fine", DATA), "an empty error is not an error")
