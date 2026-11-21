"""Phase 10: JSON replies shown whole, as Markdown."""
import json
import unittest

from agentcore import json_markdown as jm
from agentcore import mock_runtime
from agentcore.protocols.http import HttpProtocol
from tests.helpers import RecordingEmitter, context, fake_response, fixture_response, handle

HIDDEN = jm.hidden_fields({})


class RulesTest(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(jm.label("source_documents"), "Source documents")
        self.assertEqual(jm.label("sourceDocuments"), "Source documents")
        self.assertEqual(jm.label("next-steps"), "Next steps")
        self.assertEqual(jm.label("URL"), "Url")

    def test_main_text_first_then_the_rest(self):
        self.assertEqual(jm.reply({"answer": "Yes.", "score": 3, "ok": True, "note": None}, HIDDEN),
                         "Yes.\n\n**Score:** 3\n**Ok:** yes\n**Note:** -")

    def test_strands_message_result_is_only_its_text(self):
        value = {"result": {"role": "assistant", "content": [{"text": "Hi"}]}}
        self.assertEqual(jm.reply(value, HIDDEN), "Hi")

    def test_lists(self):
        self.assertEqual(jm.render({"tags": ["a", "b|c"]}, HIDDEN), "**Tags**\n\n- a\n- b\\|c")
        table = jm.render({"rows": [{"id": 1, "name": "x"}, {"id": 2, "extra": "y\nz"}]}, HIDDEN)
        self.assertEqual(table, "**Rows**\n\n| Id | Name | Extra |\n|---|---|---|\n| 1 | x |  |\n| 2 |  | y z |")
        mixed = jm.render([{"a": {"deep": 1}}, "plain"], HIDDEN)
        self.assertEqual(mixed, "**1.**\n\n**A**\n\n**Deep:** 1\n\n**2.**\n\nplain")

    def test_multiline_text_gets_its_own_block(self):
        self.assertEqual(jm.render({"summary": "Line 1\n\n- point"}, HIDDEN), "**Summary**\n\nLine 1\n\n- point")

    def test_hidden_fields_at_any_level_and_from_settings(self):
        value = {"answer": "ok", "usage": {"inputTokens": 1}, "Role": "assistant",
                 "details": {"traceId": "1-a-b", "owner": "team-a", "internal": "x"}}
        self.assertEqual(jm.reply(value, HIDDEN), "ok\n\n**Details**\n\n**Owner:** team-a\n**Internal:** x")
        mine = jm.hidden_fields({"jsonHiddenFields": ["Internal", 3, " "]})
        self.assertEqual(jm.reply(value, mine), "ok\n\n**Details**\n\n**Owner:** team-a")

    def test_too_deep_becomes_a_json_block(self):
        deep = {"a": {"b": {"c": {"d": {"e": 1}}}}}
        self.assertIn("```json\n{\n  \"e\": 1\n}\n```", jm.render(deep, HIDDEN))

    def test_nothing_visible_falls_back_to_a_json_block(self):
        self.assertEqual(jm.reply({"usage": {"x": 1}}, HIDDEN), jm.json_block({"usage": {"x": 1}}))

    def test_settings(self):
        self.assertEqual(jm.mode({}), "full")
        self.assertEqual(jm.mode({"jsonReplies": "raw"}), "raw")
        self.assertEqual(jm.mode({"jsonReplies": "bogus"}), "full")

    def test_raw_json_is_capped(self):
        self.assertEqual(json.loads(jm.raw_json([{"a": 1}])), {"a": 1})
        self.assertEqual(json.loads(jm.raw_json([1, 2])), [1, 2])
        self.assertIsNone(jm.raw_json(["x" * (jm.MAX_RAW_CHARS + 1)]))


def run_http(response, **settings):
    emitter = RecordingEmitter()
    meta = handle(HttpProtocol(), response, emitter, ctx=context(**settings))
    return emitter, meta


class HttpJsonRepliesTest(unittest.TestCase):
    def body(self):
        return fake_response(json.dumps(mock_runtime.STRUCTURED_REPLY).encode(), "application/json")

    def test_full_text_and_raw(self):
        emitter, meta = run_http(self.body())
        self.assertTrue(emitter.text.startswith("Deployed **billing-service** to `dev`.\n\n**Status:** success"))
        self.assertIn("| Deployment runbook | https://example.com/runbook |", emitter.text)
        self.assertNotIn("inputTokens", emitter.text)
        self.assertEqual(json.loads(meta["rawJson"]), mock_runtime.STRUCTURED_REPLY)

        emitter, meta = run_http(self.body(), jsonReplies="text")
        self.assertEqual(emitter.text, "Deployed **billing-service** to `dev`.")
        self.assertNotIn("rawJson", meta)

        emitter, _ = run_http(self.body(), jsonReplies="raw")
        self.assertEqual(emitter.text, jm.json_block(mock_runtime.STRUCTURED_REPLY))

    def test_stream_final_event_fields_follow_the_streamed_text(self):
        emitter, meta = run_http(fixture_response("http/stream_final_with_fields.sse"))
        self.assertEqual(emitter.text, "Found 2 matching runbooks.\n\n**Sources**\n\n| Title | Url |\n|---|---|\n"
                                       "| Deploy | https://example.com/deploy |\n| Rollback | https://example.com/rollback |")
        self.assertIn("sources", json.loads(meta["rawJson"]))

        emitter, meta = run_http(fixture_response("http/stream_final_with_fields.sse"), jsonReplies="text")
        self.assertEqual(emitter.text, "Found 2 matching runbooks.")

    def test_per_token_fields_are_never_expanded(self):
        # Strands "data" events carry other fields; they must not appear
        emitter, meta = run_http(fixture_response("http/strands_stream.sse"))
        self.assertNotIn("**", emitter.text)
        self.assertNotIn("rawJson", meta)
        # Also when no final event follows
        body = (b'data: {"data": "Hi ", "event_loop_cycle_id": "c1", "step": 1}\n\n'
                b'data: {"data": "there", "event_loop_cycle_id": "c1", "step": 2}\n\n')
        emitter, meta = run_http(fake_response(body, "text/event-stream"))
        self.assertEqual(emitter.text, "Hi there")
        self.assertNotIn("rawJson", meta)
