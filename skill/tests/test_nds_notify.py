import contextlib
import importlib.util
import io
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

    def test_notify_without_glab_keeps_full_body_and_warns(self):
        # glab ausente: o corpo COMPLETO (tabela de tokens/modelos) vai para o
        # pending, e pending_warning aponta o arquivo para o runner avisar.
        with mock.patch.dict("os.environ", {"PATH": "/nonexistent-dir"}):
            rc = nds.notify(self.folder, "wave-done", REPORT, text="fim da wave")
        self.assertEqual(rc, 0)
        pending = self.folder / "writeback-pending.md"
        self.assertTrue(pending.is_file())
        body = pending.read_text()
        self.assertIn("| Etapa | Modelo | Status | Tokens | Custo |", body)
        warning = nds.pending_warning(self.folder)
        self.assertIsNotNone(warning)
        self.assertIn("writeback-pending.md", warning)

    def test_pending_warning_none_without_pending_file(self):
        self.assertIsNone(nds.pending_warning(self.folder))


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

    def test_gate_wait_sends_report_from_factory_to_notify(self):
        # marco do gate carrega a tabela de tokens/modelos (spec RF-1)
        with mock.patch.object(nds, "notify", return_value=0) as notify:
            with mock.patch.object(nds, "_read_gate", side_effect=[
                None,
                {"label": "e", "state": "approved"},
            ]):
                rc = nds.gate_wait(self.folder, "e", timeout_hours=1, poll_seconds=0,
                                   report_factory=lambda: REPORT)
        self.assertEqual(rc, 0)
        waiting = [c for c in notify.call_args_list if c[0][1] == "gate-waiting"]
        self.assertTrue(waiting)
        self.assertEqual(waiting[0][0][2], REPORT)  # 3º argumento posicional


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

    def test_nds_event_warns_about_pending_writeback(self):
        # aviso no stderr quando há comentários acumulados localmente
        (self.folder / "writeback-pending.md").write_text(
            "\n## wave-done — agora\n\n### Wave concluída\n")
        err = io.StringIO()
        with mock.patch.object(self.orch.nds, "notify", return_value=0), \
             contextlib.redirect_stderr(err):
            rc = self.orch.main(["nds-event", "final", "--in", str(self.folder)])
        self.assertEqual(rc, 0)
        self.assertIn("writeback-pending.md", err.getvalue())

    def test_spec_dispatch_passes_report_factory(self):
        with mock.patch.object(self.orch.nds, "spec_rejected", return_value=0) as sr:
            rc = self.orch.main(["spec", "rejected", "--in", str(self.folder),
                                 "--text", "falhas"])
        self.assertEqual(rc, 0)
        factory = sr.call_args.kwargs.get("report_factory")
        self.assertTrue(callable(factory))


class SpecAttemptsTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-spec-"))

    def test_third_rejection_aborts_once(self):
        with mock.patch.object(nds, "notify", return_value=0) as notify:
            self.assertEqual(nds.spec_rejected(self.folder), 0)   # 1ª
            self.assertEqual(nds.spec_rejected(self.folder), 0)   # 2ª
            self.assertEqual(nds.spec_rejected(self.folder), 2)   # 3ª -> aborta
            self.assertEqual(nds.spec_rejected(self.folder), 2)   # repetida: não duplica
        events = [c[0][1] for c in notify.call_args_list]
        self.assertEqual(events.count("abort"), 1)
        self.assertEqual(events.count("spec-rejected"), 3)
        attempts = json.loads((self.folder / "spec_attempts.json").read_text())
        self.assertEqual(attempts["attempts"], 3)

    def test_spec_approved_resets_counter(self):
        with mock.patch.object(nds, "notify", return_value=0):
            nds.spec_rejected(self.folder)
            nds.spec_approved(self.folder)
            self.assertEqual(nds.spec_rejected(self.folder), 0)   # volta a contar de 1

    def test_spec_rejected_sends_report_from_factory_to_notify(self):
        with mock.patch.object(nds, "notify", return_value=0) as notify:
            rc = nds.spec_rejected(self.folder, text="falhas",
                                   report_factory=lambda: REPORT)
        self.assertEqual(rc, 0)
        call = notify.call_args_list[0]
        self.assertEqual(call[0][1], "spec-rejected")
        self.assertEqual(call[0][2], REPORT)  # 3º argumento posicional

    def test_spec_rejected_raising_factory_degrades_to_no_report(self):
        def boom():
            raise RuntimeError("report indisponível")

        with mock.patch.object(nds, "notify", return_value=0) as notify:
            rc = nds.spec_rejected(self.folder, report_factory=boom)
        self.assertEqual(rc, 0)
        self.assertIsNone(notify.call_args_list[0][0][2])


if __name__ == "__main__":
    unittest.main()
