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


if __name__ == "__main__":
    unittest.main()
