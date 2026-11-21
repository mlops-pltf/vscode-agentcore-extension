import unittest

from agentcore.sse import iter_sse_events


class SseFramingTest(unittest.TestCase):
    def events(self, text):
        return list(iter_sse_events(text.split("\n")))

    def test_one_event_per_blank_line(self):
        self.assertEqual(self.events("data: a\n\ndata: b\n\n"), ["a", "b"])

    def test_multiple_data_lines_join_with_newline(self):
        self.assertEqual(self.events("data: one\ndata: two\n\n"), ["one\ntwo"])

    def test_comments_and_other_fields_are_skipped(self):
        self.assertEqual(self.events(": ping\nevent: msg\nid: 7\nretry: 10\ndata: x\n\n"), ["x"])

    def test_only_one_leading_space_is_removed(self):
        self.assertEqual(self.events("data:no-space\n\ndata:  two-spaces\n\n"), ["no-space", " two-spaces"])

    def test_last_event_without_blank_line_is_kept(self):
        self.assertEqual(self.events("data: a\n\ndata: tail"), ["a", "tail"])

    def test_crlf_and_bytes(self):
        lines = [b"data: caf\xc3\xa9\r", b"\r", b"data: b", b""]
        self.assertEqual(list(iter_sse_events(lines)), ["café", "b"])

    def test_blank_lines_alone_yield_nothing(self):
        self.assertEqual(self.events("\n\n\n"), [])


if __name__ == "__main__":
    unittest.main()
