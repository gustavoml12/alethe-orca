import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "skills" / "alethe" / "scripts" / "nds.py"

spec = importlib.util.spec_from_file_location("nds_notify", SCRIPT)
nds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nds)

REPORT = {
    "workers": [
        {"label": "opencode-run", "model": "free", "status": "succeeded", "tokens": 128400, "costUsd": None},
        {"label": "claude-opus-4.5", "model": "opus", "status": "succeeded", "tokens": 42100, "costUsd": 0.63},
        {"label": "agy-gemini-3.7-pro", "model": "gemini-3.7-pro", "status": "succeeded", "tokens": 310500, "costUsd": None},
    ],
    "totals": {"tokens": 481000, "costUsd": 0.63},
}


class FormatCommentTest(unittest.TestCase):
    def test_table_has_models_and_tokens(self):
        body = nds.format_comment("wave-done", REPORT, text="Executor concluído")
        self.assertIn("| Etapa | Modelo | Status | Tokens | Custo |", body)
        self.assertIn("gemini-3.7-pro", body)
        self.assertIn("481000", body)  # total
        self.assertIn("0.63", body)
        self.assertIn("310500", body)

    def test_missing_report_still_formats(self):
        body = nds.format_comment("gate-waiting", None, text="Aguardando aprovação")
        self.assertIn("Aguardando aprovação", body)
        self.assertNotIn("| Etapa |", body)


class NotifyTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-notify-"))
        self.bin = Path(tempfile.mkdtemp(prefix="nds-bin-"))
        (self.folder / "nds.json").write_text(json.dumps({"issue": "42"}))

    def _fake_glab(self, exit_code=0, fail=False):
        fake = self.bin / "glab"
        fake.write_text("#!/bin/sh\n"
                        'echo "$@" >> "%s/calls.log"\n'
                        "exit %d\n" % (self.bin, 1 if fail else exit_code))
        fake.chmod(0o755)
        return str(self.bin) + ":/usr/bin:/bin"

    def test_notify_uses_glab_with_issue_iid(self):
        env = self._fake_glab()
        with mock.patch.dict("os.environ", {"PATH": env}):
            rc = nds.notify(self.folder, "wave-done", REPORT, text="ok")
        self.assertEqual(rc, 0)
        calls = (self.bin / "calls.log").read_text()
        self.assertIn("issue", calls)
        self.assertIn("42", calls)

    def test_notify_without_glab_writes_pending(self):
        with mock.patch.dict("os.environ", {"PATH": "/nonexistent-dir"}):
            rc = nds.notify(self.folder, "gate-waiting", None, text="gate")
        self.assertEqual(rc, 0)  # nunca derruba o pipeline
        pending = self.folder / "writeback-pending.md"
        self.assertTrue(pending.is_file())
        self.assertIn("gate-waiting", pending.read_text())

    def test_notify_without_issue_config_writes_pending(self):
        (self.folder / "nds.json").unlink()
        with mock.patch.dict("os.environ", {"PATH": "/nonexistent-dir", "NDS_ISSUE": ""}):
            rc = nds.notify(self.folder, "final", REPORT)
        self.assertEqual(rc, 0)
        self.assertTrue((self.folder / "writeback-pending.md").is_file())

    def test_notify_glab_failure_writes_pending(self):
        env = self._fake_glab(fail=True)
        with mock.patch.dict("os.environ", {"PATH": env}):
            rc = nds.notify(self.folder, "wave-done", REPORT, text="falhou")
        self.assertEqual(rc, 0)
        pending = self.folder / "writeback-pending.md"
        self.assertTrue(pending.is_file())
        self.assertIn("wave-done", pending.read_text())


class GateNotifyTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-gaten-"))

    def test_gate_wait_publishes_waiting_then_approved(self):
        with mock.patch.object(nds, "notify", return_value=0) as notify:
            with mock.patch.object(nds, "_read_gate", side_effect=[
                None,  # inicial
                {"label": "e", "state": "approved"},  # poll 1 -> resolve
            ]):
                rc = nds.gate_wait(self.folder, "e", timeout_hours=1, poll_seconds=0)
        self.assertEqual(rc, 0)
        events = [c[0][1] for c in notify.call_args_list]
        self.assertIn("gate-waiting", events)
        self.assertIn("gate-approved", events)

    def test_gate_rejected_publishes_rejected(self):
        with mock.patch.object(nds, "notify", return_value=0) as notify:
            with mock.patch.object(nds, "_read_gate", side_effect=[
                None,
                {"label": "e", "state": "rejected"},
            ]):
                rc = nds.gate_wait(self.folder, "e", timeout_hours=1, poll_seconds=0)
        self.assertEqual(rc, 3)
        events = [c[0][1] for c in notify.call_args_list]
        self.assertIn("gate-rejected", events)


class WaveDoneNotifyTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-wavedone-"))
        (self.folder / "orchestration.json").write_text("{}")
        self.plan = self.folder / "plan.json"
        self.plan.write_text(json.dumps({"version": 1, "workers": [
            {"id": "w", "provider": "claude", "cwd": ".", "mode": "read-only", "task": "x"}]}))
        orch_spec = importlib.util.spec_from_file_location(
            "orchestrate_wavedone",
            ROOT / "skills" / "alethe" / "scripts" / "orchestrate.py")
        self.orch = importlib.util.module_from_spec(orch_spec)
        orch_spec.loader.exec_module(self.orch)

    def test_run_publishes_wave_done_with_exit_code(self):
        with mock.patch.object(self.orch, "run_batch", return_value=7), \
             mock.patch.object(self.orch.nds, "notify", return_value=0) as notify:
            rc = self.orch.main(["run", str(self.plan), "--in", str(self.folder)])
        self.assertEqual(rc, 7)  # exit original preservado
        notify.assert_called_once()
        call = notify.call_args
        self.assertEqual(call.args[1], "wave-done")
        self.assertIn("exit 7", call.kwargs.get("text", ""))


class NdsEventCliTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-event-"))
        (self.folder / "orchestration.json").write_text("{}")
        self.orch_spec = importlib.util.spec_from_file_location(
            "orchestrate_evt",
            ROOT / "skills" / "alethe" / "scripts" / "orchestrate.py")
        self.orch = importlib.util.module_from_spec(self.orch_spec)
        self.orch_spec.loader.exec_module(self.orch)

    def test_nds_event_posts_comment(self):
        with mock.patch.object(self.orch.nds, "notify", return_value=0) as notify:
            rc = self.orch.main(["nds-event", "wave-done", "--in", str(self.folder),
                                 "--text", "fim da wave"])
        self.assertEqual(rc, 0)
        notify.assert_called_once()
        call = notify.call_args
        self.assertEqual(call.args[1], "wave-done")
        self.assertEqual(call.kwargs.get("text"), "fim da wave")


if __name__ == "__main__":
    unittest.main()
