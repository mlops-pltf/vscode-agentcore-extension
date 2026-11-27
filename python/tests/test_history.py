"""Phase 14: chat history saved per session id."""
import json
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from agentcore import events, history, sessions


class HistoryTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="agentcore-history-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        for patcher in (mock.patch.dict(os.environ, {"AGENTCORE_HISTORY_DIR": self.dir}),
                        mock.patch.object(events, "send"),   # what the panel would receive
                        mock.patch.object(history, "log")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def turn(self, session="s1", prompt="hi", arn="arn:x/agent_a", protocol="HTTP", display=None, request="r1"):
        cmd = {"sessionId": session, "agentArn": arn, "protocol": protocol, "prompt": prompt, "profile": "dev"}
        if display:
            cmd["display"] = display
        return history.TurnRecorder(request, cmd, {"mock": True})


class RecordAndSaveTest(HistoryTestCase):
    def test_a_turn_is_saved_as_shown(self):
        rec = self.turn(prompt="what time is it?", display={"prompt": "@agent_a what time is it?", "agentName": "Agent A", "mentionLength": 8})
        rec.chunk("Let me check. ")
        rec.tool({"id": "t1", "name": "clock", "status": "running"})
        rec.tool({"id": "t1", "name": "clock", "status": "success", "result": "10:42"})
        rec.chunk("It's ")
        rec.chunk("10:42.")
        rec.done(state="completed", protocol="HTTP", ms=812, traceId="1-a-b")
        chat = history.load("s1")
        self.assertEqual(chat["title"], "@agent_a what time is it?")
        self.assertTrue(chat["mock"])
        self.assertEqual(chat["profile"], "dev")
        (turn,) = chat["turns"]
        self.assertEqual((turn["agentName"], turn["prompt"], turn["mentionLength"]), ("Agent A", "@agent_a what time is it?", 8))
        self.assertEqual(turn["reply"]["segments"], [
            {"kind": "text", "text": "Let me check. "},
            {"kind": "tool", "id": "t1", "name": "clock", "status": "success", "result": "10:42"},
            {"kind": "text", "text": "It's 10:42."},
        ])
        self.assertEqual(turn["reply"]["state"], "completed")
        self.assertEqual(turn["reply"]["meta"]["traceId"], "1-a-b")
        self.assertEqual(events.send.call_count, 6, "the panel still gets every event")

    def test_turns_append_and_errors_are_kept(self):
        first = self.turn()
        first.chunk("Hello")
        first.done(state="completed")
        second = self.turn(prompt="break it", request="r2")
        second.error("Agent error: boom", traceId="1-c-d")
        third = self.turn(prompt="again", request="r3")
        third.sso_expired("dev")
        turns = history.load("s1")["turns"]
        self.assertEqual([t["reply"]["state"] for t in turns], ["completed", "error", "error"])
        self.assertEqual(turns[1]["reply"]["error"], "Agent error: boom")
        self.assertEqual(turns[1]["reply"]["meta"], {"traceId": "1-c-d"})
        self.assertEqual(turns[2]["reply"]["error"], "SSO session expired.")
        self.assertEqual(history.load("s1")["title"], "hi", "the title is the first prompt")

    def test_a_turn_is_saved_once(self):
        rec = self.turn()
        rec.done(state="cancelled")
        rec.error("late")
        self.assertEqual(len(history.load("s1")["turns"]), 1)


class ListDeleteTest(HistoryTestCase):
    def save(self, session, prompt):
        rec = self.turn(session=session, prompt=prompt)
        rec.chunk("ok")
        rec.done(state="completed")

    def test_list_is_newest_first_and_skips_bad_files(self):
        self.save("old", "first chat")
        time.sleep(0.01)
        self.save("new", "x" * 200)
        with open(os.path.join(self.dir, "broken.json"), "w") as f:
            f.write("{not json")
        items = history.list_chats()
        self.assertEqual([i["sessionId"] for i in items], ["new", "old"])
        self.assertEqual(len(items[0]["title"]), history.TITLE_CHARS)
        self.assertEqual(items[1], {"sessionId": "old", "title": "first chat", "created": items[1]["created"],
                                    "updated": items[1]["updated"], "agentName": "agent_a", "turns": 1, "mock": True})
        history.log.assert_called()

    def test_delete_one_and_all(self):
        self.save("a", "one")
        self.save("b", "two")
        history.delete("a")
        self.assertEqual([i["sessionId"] for i in history.list_chats()], ["b"])
        history.delete("never-existed")
        history.delete_all()
        self.assertEqual(history.list_chats(), [])

    def test_session_ids_cannot_name_other_files(self):
        for bad in ("../secret", "a/b", "", ".hidden", None):
            with self.assertRaises(ValueError):
                history.delete(bad)
        self.assertIsNone(history.load("../secret"))

    def test_only_the_newest_chats_are_kept(self):
        with mock.patch.object(history, "MAX_CHATS", 2):
            for i, session in enumerate(("c1", "c2", "c3")):
                self.save(session, f"chat {i}")
                os.utime(os.path.join(self.dir, f"{session}.json"), (1000 + i, 1000 + i))
            self.save("c4", "chat 4")
        self.assertEqual(sorted(i["sessionId"] for i in history.list_chats()), ["c3", "c4"])

    def test_off_without_a_folder_or_by_setting(self):
        self.assertTrue(history.enabled({}))
        self.assertFalse(history.enabled({"history": False}))
        with mock.patch.dict(os.environ, {"AGENTCORE_HISTORY_DIR": ""}):
            self.assertFalse(history.enabled({}))
            self.assertEqual(history.list_chats(), [])


class RestoreTest(HistoryTestCase):
    def test_a2a_agents_get_their_context_back(self):
        a = self.turn(session="r", arn="arn:x/a", protocol="A2A")
        a.done(state="completed", contextId="ctx-a", taskId="task-1", taskState="completed")
        b = self.turn(session="r", arn="arn:x/b", protocol="A2A", request="r2")
        b.done(state="completed", contextId="ctx-b", taskId="task-9", taskState="input-required")
        h = self.turn(session="r", arn="arn:x/h", protocol="HTTP", request="r3")
        h.done(state="completed")
        sessions.reset("r")
        self.addCleanup(sessions.reset, "r")

        history.restore("r")
        self.assertEqual(sessions.get("r", "arn:x/a"), {"contextId": "ctx-a"})
        self.assertEqual(sessions.get("r", "arn:x/b"), {"contextId": "ctx-b", "pendingTaskId": "task-9"})
        self.assertEqual(sessions.get("r", "arn:x/h"), {})
        history.restore("not-saved")  # nothing to restore, no error


if __name__ == "__main__":
    unittest.main()
