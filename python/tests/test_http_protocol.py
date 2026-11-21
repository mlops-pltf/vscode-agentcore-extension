import json
import threading
import unittest

from agentcore import http_protocol, mock_runtime
from agentcore.aws import AgentCoreError
from agentcore.cancel import CancelToken
from tests.helpers import RecordingEmitter, fake_response, fixture_response


def run(response):
    emitter = RecordingEmitter()
    meta = http_protocol.handle_response(response, emitter, CancelToken())
    return emitter, meta


class BuildPayloadTest(unittest.TestCase):
    def test_prompt_body(self):
        self.assertEqual(json.loads(http_protocol.build_payload("hi")), {"prompt": "hi"})


class StreamFixturesTest(unittest.TestCase):
    def test_strands_stream_has_no_duplicate_text(self):
        emitter, meta = run(fixture_response("http/strands_stream.sse"))
        self.assertEqual(emitter.text, "Hello world!")
        self.assertEqual([e["text"] for e in emitter.of("status")], ["Using tool: web_search"])
        self.assertEqual(meta, {"contentType": "text/event-stream"})

    def test_raw_bedrock_only_stream_falls_back_to_raw_events(self):
        self.assertEqual(run(fixture_response("http/bedrock_raw_only.sse"))[0].text, "Hello world!")

    def test_plain_text_data(self):
        self.assertEqual(run(fixture_response("http/plain_text.sse"))[0].text, "Hello world!")

    def test_json_string_data(self):
        self.assertEqual(run(fixture_response("http/json_strings.sse"))[0].text, "Hello world!")

    def test_multiline_event(self):
        self.assertEqual(run(fixture_response("http/multiline.sse"))[0].text, "line one\nline two")

    def test_python_repr_events(self):
        self.assertEqual(run(fixture_response("http/python_repr.sse"))[0].text, "Hello world!")

    def test_done_marker_is_ignored(self):
        self.assertEqual(run(fixture_response("http/openai_style_done.sse"))[0].text, "Hello world!")

    def test_final_result_only(self):
        self.assertEqual(run(fixture_response("http/final_only.sse"))[0].text, "Hello world!")

    def test_raw_lines_are_logged(self):
        emitter, _ = run(fixture_response("http/plain_text.sse"))
        self.assertIn("data: Hello ", [e["line"] for e in emitter.of("raw")])


class JsonFixturesTest(unittest.TestCase):
    def test_strands_result_message(self):
        self.assertEqual(run(fixture_response("http/strands_result_message.json"))[0].text, "Hello world!")

    def test_generic_response_key(self):
        self.assertEqual(run(fixture_response("http/generic_response.json"))[0].text, "Hello world!")

    def test_unknown_shape_is_shown_as_json_block(self):
        text = run(fixture_response("http/unknown_shape.json"))[0].text
        self.assertTrue(text.startswith("```json\n") and text.endswith("\n```"), text)
        self.assertIn('"status": "ok"', text)

    def test_charset_in_content_type(self):
        emitter, meta = run(fixture_response("http/generic_response.json", "application/json; charset=utf-8"))
        self.assertEqual(emitter.text, "Hello world!")
        self.assertEqual(meta["contentType"], "application/json")


class EdgeCasesTest(unittest.TestCase):
    def test_error_status_raises_with_body(self):
        response = fake_response(b'{"message": "boom"}', "application/json", status=500)
        with self.assertRaises(AgentCoreError) as ctx:
            run(response)
        self.assertIn("HTTP 500", str(ctx.exception))
        self.assertIn("boom", str(ctx.exception))

    def test_plain_text_body(self):
        self.assertEqual(run(fake_response(b"just text", "text/plain"))[0].text, "just text")

    def test_missing_content_type_sniffs_sse(self):
        self.assertEqual(run(fake_response(b"data: a\n\ndata: b\n\n", ""))[0].text, "ab")

    def test_missing_content_type_sniffs_json(self):
        self.assertEqual(run(fake_response(b'{"text": "hi"}', ""))[0].text, "hi")

    def test_sse_without_data_lines_shows_plain_text(self):
        self.assertEqual(run(fake_response(b"line one\nline two\n", "text/event-stream"))[0].text,
                         "line one\nline two")

    def test_cancel_mid_stream_stops_output(self):
        body = b"".join(b'data: {"data": "w%d "}\n\n' % i for i in range(50))
        response = fake_response(body, "text/event-stream", delay=0.01)
        emitter, token = RecordingEmitter(), CancelToken()
        threading.Timer(0.1, token.cancel).start()
        http_protocol.handle_response(response, emitter, token)
        self.assertTrue(token.cancelled)
        self.assertLess(len(emitter.of("chunk")), 25)


class MockRuntimeTest(unittest.TestCase):
    """The mock's HTTP replies must come out as clean text, exactly once."""

    def setUp(self):
        self._delay = mock_runtime.FAST_DELAY
        mock_runtime.FAST_DELAY = 0

    def tearDown(self):
        mock_runtime.FAST_DELAY = self._delay

    def invoke(self, prompt):
        response = mock_runtime.invoke("p", "arn:x:runtime/demo", "s" * 36,
                                       http_protocol.build_payload(prompt), http_protocol.ACCEPT)
        return run(response)[0]

    def test_stream(self):
        expected = "You said: 'hi'. This is a mock reply from demo, streamed word by word."
        self.assertEqual(self.invoke("hi").text, expected)

    def test_tool(self):
        self.assertEqual([e["text"] for e in self.invoke("tool please").of("status")],
                         ["Using tool: web_search"])

    def test_json(self):
        self.assertTrue(self.invoke("json please").text.startswith("You said: 'json please'"))


if __name__ == "__main__":
    unittest.main()
