"""NDS fork helpers: human gate and GitLab write-back for alethe-orchestrate.

Stdlib only. The gate is a small JSON state machine in the orchestration folder;
approval comes from this terminal's stdin or from `orchestrate.py gate approve`
in another terminal. Never raises into the runner: write-back is best effort.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

GATE_FILE = "gate.json"
PENDING_FILE = "writeback-pending.md"
CONFIG_FILE = "nds.json"
ATTEMPTS_FILE = "spec_attempts.json"
GATE_ENV_HOURS = "NDS_GATE_HOURS"
ISSUE_ENV = "NDS_ISSUE"
APPROVE_WORDS = {"sim", "s", "yes", "y", "approve", "aprovado", "aprovada", "ok"}
REJECT_WORDS = {"nao", "não", "no", "n", "reject", "reprovado", "reprovada"}


class GateError(Exception):
    """Invalid gate transition (e.g. reject after approve)."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _gate_path(folder: Path) -> Path:
    return folder / GATE_FILE


def _read_gate(folder: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(_gate_path(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _load_gate(folder: Path) -> Optional[Dict[str, Any]]:
    """Direct read of gate.json, bypassing _read_gate.

    Writers (gate_approve/gate_reject) must not go through _read_gate: that name
    is the polling indirection gate_wait's poll loop mocks, and re-entering it
    from a writer recurses. Read the file directly instead.
    """
    try:
        return json.loads(_gate_path(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_gate(folder: Path, state: str, label: str, by: str) -> Dict[str, Any]:
    entry = {"label": label, "state": state, "createdAt": _now(),
             "resolvedAt": _now() if state in ("approved", "rejected", "expired") else None,
             "by": by}
    _gate_path(folder).write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


def gate_status(folder: Path, label: Optional[str] = None) -> Dict[str, Any]:
    state = _read_gate(folder) or {"state": "none"}
    if label and state.get("label") not in (None, label):
        return {"state": "none", "label": label}
    return state


def gate_approve(folder: Path, label: Optional[str] = None) -> Dict[str, Any]:
    state = _load_gate(folder)
    if state is None:
        # aprovação prévia: grava approved direto (usado em retry idempotente)
        return _write_gate(folder, "approved", label or "unlabeled", "file")
    if state.get("state") == "approved":
        return state
    if state.get("state") not in ("waiting", None):
        raise GateError(f"gate is {state.get('state')}; only waiting gates can be approved")
    state.update({"state": "approved", "resolvedAt": _now(), "by": "file"})
    _gate_path(folder).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return state


def gate_reject(folder: Path, label: Optional[str] = None) -> Dict[str, Any]:
    state = _load_gate(folder)
    if state is None:
        raise GateError("no gate to reject")
    if state.get("state") == "rejected":
        return state
    if state.get("state") != "waiting":
        raise GateError(f"gate is {state.get('state')}; only waiting gates can be rejected")
    state.update({"state": "rejected", "resolvedAt": _now(), "by": "file"})
    _gate_path(folder).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return state


def _stdin_line() -> Optional[str]:
    """One non-blocking-ish read of a line from stdin when it is a TTY; else None."""
    if not sys.stdin or not sys.stdin.isatty():
        return None
    try:
        return sys.stdin.readline().strip()
    except OSError:
        return None


def _prompt(label: str, folder: Path) -> None:
    print(f"\n=== NDS GATE: aprovação humana necessária ({label}) ===", flush=True)
    print(f"Pasta: {folder}", flush=True)
    print('Digite "sim" para liberar a execução, "nao" para abortar,', flush=True)
    print(f'ou rode em outro terminal:  orchestrate.py gate approve --in "{folder}"', flush=True)


def gate_wait(folder: Path, label: str, timeout_hours: float = 24.0,
              poll_seconds: float = 2.0) -> int:
    """Block until the gate for `label` is approved (0) or rejected/expired (3)."""
    existing = _read_gate(folder)
    if existing and existing.get("label") == label and existing.get("state") == "approved":
        return 0  # idempotente: retry não pausa de novo
    if existing and existing.get("label") == label and existing.get("state") == "rejected":
        return 3
    _write_gate(folder, "waiting", label, "terminal")
    _prompt(label, folder)
    deadline = time.monotonic() + (timeout_hours * 3600)
    while True:
        line = _stdin_line()
        if line:
            word = line.strip().lower()
            if word in APPROVE_WORDS:
                gate_approve(folder, label)
                return 0
            if word in REJECT_WORDS:
                gate_reject(folder, label)
                return 3
            print("Resposta não reconhecida; use sim/nao.", flush=True)
        state = _read_gate(folder) or {}
        if state.get("state") == "approved":
            return 0
        if state.get("state") == "rejected":
            return 3
        if time.monotonic() > deadline:
            _write_gate(folder, "expired", label, "timeout")
            print("NDS GATE: expirou sem resposta; abortando a wave.", flush=True)
            return 3
        if poll_seconds > 0:
            time.sleep(poll_seconds)
