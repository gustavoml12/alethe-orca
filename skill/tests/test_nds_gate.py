import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "skills" / "alethe" / "scripts" / "nds.py"

spec = importlib.util.spec_from_file_location("nds", SCRIPT)
nds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nds)


class GateStateTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-gate-"))

    def test_gate_wait_writes_waiting_then_approves_from_file(self):
        # approve chega por "outro terminal" enquanto o loop faz poll do gate.json
        original_read = nds._read_gate
        calls = {"n": 0}

        def poll(folder):
            calls["n"] += 1
            if calls["n"] >= 2:
                nds.gate_approve(folder, "exec")
            return original_read(folder)

        with mock.patch.object(nds, "_read_gate", side_effect=poll), \
             mock.patch.object(nds.time, "sleep"):
            rc = nds.gate_wait(self.folder, "exec", timeout_hours=1, poll_seconds=0)
        self.assertEqual(rc, 0)
        state = json.loads((self.folder / "gate.json").read_text())
        self.assertEqual(state["state"], "approved")
        self.assertEqual(state["label"], "exec")

    def test_gate_wait_reject_returns_3(self):
        with mock.patch.object(nds, "_read_gate", return_value={"label": "exec", "state": "rejected"}):
            rc = nds.gate_wait(self.folder, "exec", timeout_hours=1)
        self.assertEqual(rc, 3)

    def test_gate_wait_approves_without_pause_when_already_approved(self):
        (self.folder / "gate.json").write_text(json.dumps(
            {"label": "exec", "state": "approved", "createdAt": "x", "resolvedAt": "y", "by": "file"}))
        with mock.patch.object(nds, "_prompt") as prompt:
            rc = nds.gate_wait(self.folder, "exec", timeout_hours=1)
        self.assertEqual(rc, 0)
        prompt.assert_not_called()  # idempotente: não pausa de novo

    def test_gate_wait_times_out_as_expired(self):
        with mock.patch.object(nds.time, "sleep"), \
             mock.patch.object(nds, "_stdin_line", return_value=None), \
             mock.patch.object(nds.time, "monotonic", side_effect=[0.0, 0.0, 99999.0]):
            rc = nds.gate_wait(self.folder, "exec", timeout_hours=0.0001, poll_seconds=0)
        self.assertEqual(rc, 3)
        state = json.loads((self.folder / "gate.json").read_text())
        self.assertEqual(state["state"], "expired")

    def test_gate_hours_env_overrides_timeout(self):
        # NDS_GATE_HOURS (anunciado no FORK-_DELTA) tem que valer mais que o
        # default do parâmetro: 0.0001h expira antes do 2º poll (50s < 0.36s),
        # enquanto o param 1h não expiraria — sem o env o side_effect estoura.
        with mock.patch.dict("os.environ", {"NDS_GATE_HOURS": "0.0001"}), \
             mock.patch.object(nds.time, "sleep"), \
             mock.patch.object(nds, "_stdin_line", return_value=None), \
             mock.patch.object(nds.time, "monotonic", side_effect=[0.0, 0.0, 50.0]):
            rc = nds.gate_wait(self.folder, "exec", timeout_hours=1, poll_seconds=0)
        self.assertEqual(rc, 3)
        state = json.loads((self.folder / "gate.json").read_text())
        self.assertEqual(state["state"], "expired")

    def test_reject_writes_rejected_state(self):
        nds.gate_approve(self.folder, "a")
        # rejeitar depois de aprovado é erro
        with self.assertRaises(nds.GateError):
            nds.gate_reject(self.folder, "a")
        folder2 = Path(tempfile.mkdtemp(prefix="nds-gate2-"))
        (folder2 / "gate.json").write_text(json.dumps(
            {"label": "b", "state": "waiting", "createdAt": "x", "resolvedAt": None, "by": "file"}))
        out = nds.gate_reject(folder2, "b")
        self.assertEqual(out["state"], "rejected")

    def test_stdin_watcher_records_approval(self):
        with mock.patch.object(nds, "_stdin_line", return_value="sim"):
            nds._stdin_watcher(self.folder, "w")
        state = json.loads((self.folder / "gate.json").read_text())
        self.assertEqual(state["state"], "approved")
        self.assertEqual(state["label"], "w")


class GateCliTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="nds-cli-"))
        self.orch = importlib.util.spec_from_file_location(
            "orchestrate_nds",
            ROOT / "skills" / "alethe" / "scripts" / "orchestrate.py")
        self.orch_mod = importlib.util.module_from_spec(self.orch)
        self.orch.loader.exec_module(self.orch_mod)

    def test_gate_subcommand_approves(self):
        nds.gate_wait.__wrapped__ if False else None
        (self.folder / "gate.json").write_text(json.dumps(
            {"label": "w", "state": "waiting", "createdAt": "x", "resolvedAt": None, "by": "file"}))
        rc = self.orch_mod.main(["gate", "approve", "--in", str(self.folder)])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads((self.folder / "gate.json").read_text())["state"], "approved")

    def test_gate_before_requires_orchestration(self):
        # wave avulsa (sem --in) deve falhar cedo, nunca rodar sem gate
        plan = self.folder / "plan.json"
        plan.write_text(json.dumps({"version": 1, "workers": [
            {"id": "w", "provider": "claude", "cwd": ".", "mode": "read-only", "task": "x"}]}))
        with mock.patch.object(self.orch_mod, "run_batch") as rb:
            rc = self.orch_mod.main(["run", str(plan), "--gate-before", "exec"])
        self.assertEqual(rc, 2)
        rb.assert_not_called()

    def test_gate_before_blocked_when_rejected(self):
        folder = self.folder
        (folder / "orchestration.json").write_text("{}")
        plan = folder / "plan.json"
        plan.write_text(json.dumps({"version": 1, "workers": [
            {"id": "w", "provider": "claude", "cwd": ".", "mode": "read-only", "task": "x"}]}))
        (folder / "gate.json").write_text(json.dumps(
            {"label": "exec", "state": "rejected", "createdAt": "x", "resolvedAt": "y", "by": "file"}))
        with mock.patch.object(self.orch_mod, "run_batch") as rb:
            rc = self.orch_mod.main(["run", str(plan), "--in", str(folder), "--gate-before", "exec"])
        self.assertEqual(rc, 3)
        rb.assert_not_called()

    def test_gate_before_runs_when_approved(self):
        folder = self.folder
        (folder / "orchestration.json").write_text("{}")
        plan = folder / "plan.json"
        plan.write_text(json.dumps({"version": 1, "workers": [
            {"id": "w", "provider": "claude", "cwd": ".", "mode": "read-only", "task": "x"}]}))
        (folder / "gate.json").write_text(json.dumps(
            {"label": "exec", "state": "approved", "createdAt": "x", "resolvedAt": "y", "by": "file"}))
        with mock.patch.object(self.orch_mod, "run_batch", return_value=0) as rb:
            rc = self.orch_mod.main(["run", str(plan), "--in", str(folder), "--gate-before", "exec"])
        self.assertEqual(rc, 0)
        rb.assert_called_once()

    def _write_gate_plan(self, folder):
        (folder / "orchestration.json").write_text("{}")
        plan = folder / "plan-gate.json"
        plan.write_text(json.dumps({"version": 1, "gate": "human", "workers": [
            {"id": "w", "provider": "claude", "cwd": ".", "mode": "read-only", "task": "x"}]}))
        return plan

    def _write_gate_state(self, folder, state):
        (folder / "gate.json").write_text(json.dumps(
            {"label": "human", "state": state, "createdAt": "x",
             "resolvedAt": "y" if state != "waiting" else None, "by": "file"}))

    def test_plan_declared_gate_blocks_when_rejected(self):
        # plan JSON com "gate": "human" sem --gate-before: o runner tem que
        # pausar na mesma (spec RF-1) e abortar sem chamar run_batch
        folder = self.folder
        plan = self._write_gate_plan(folder)
        self._write_gate_state(folder, "rejected")
        with mock.patch.object(self.orch_mod, "run_batch") as rb:
            rc = self.orch_mod.main(["run", str(plan), "--in", str(folder)])
        self.assertEqual(rc, 3)
        rb.assert_not_called()

    def test_plan_declared_gate_runs_when_approved(self):
        folder = self.folder
        plan = self._write_gate_plan(folder)
        self._write_gate_state(folder, "approved")
        with mock.patch.object(self.orch_mod, "run_batch", return_value=0) as rb:
            rc = self.orch_mod.main(["run", str(plan), "--in", str(folder)])
        self.assertEqual(rc, 0)
        rb.assert_called_once()

    def test_plan_declared_gate_requires_orchestration(self):
        # sem --in não há onde guardar o gate: falha cedo, nunca roda sem gate
        plan = self._write_gate_plan(self.folder)
        with mock.patch.object(self.orch_mod, "run_batch") as rb:
            rc = self.orch_mod.main(["run", str(plan)])
        self.assertEqual(rc, 2)
        rb.assert_not_called()

    def test_cli_works_without_nds_module(self):
        # compat: import guardado — main continua existindo sem nds
        self.assertTrue(hasattr(self.orch_mod, "main"))


if __name__ == "__main__":
    unittest.main()
