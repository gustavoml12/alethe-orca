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
import threading
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


def _stdin_watcher(folder: Path, label: str) -> None:
    """Daemon thread: read one stdin line and record the decision in gate.json.

    Kept off the main loop so the file poll, cross-terminal approval and the
    deadline keep running while this blocks on readline (TTY only; returns
    immediately when stdin is not a TTY).
    """
    line = _stdin_line()
    if not line:
        return
    word = line.strip().lower()
    try:
        if word in APPROVE_WORDS:
            gate_approve(folder, label)
        elif word in REJECT_WORDS:
            gate_reject(folder, label)
        else:
            print("Resposta não reconhecida; use sim/nao.", flush=True)
    except GateError as error:
        print(f"gate: {error}", flush=True)


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
    notify(folder, "gate-waiting", None,
           text=f"Wave `{label}` pausada; aguardando aprovação humana "
                f"(libere com `orchestrate.py gate approve --in \"{folder}\"`).")
    threading.Thread(target=_stdin_watcher, args=(folder, label), daemon=True).start()
    deadline = time.monotonic() + (timeout_hours * 3600)
    while True:
        state = _read_gate(folder) or {}
        if state.get("state") == "approved":
            notify(folder, "gate-approved", None, text=f"Wave `{label}` liberada.")
            return 0
        if state.get("state") == "rejected":
            notify(folder, "gate-rejected", None,
                   text=f"Wave `{label}` abortada: recusada pelo usuário.")
            return 3
        if time.monotonic() > deadline:
            _write_gate(folder, "expired", label, "timeout")
            notify(folder, "gate-rejected", None,
                   text=f"Wave `{label}` abortada: gate expirou após {timeout_hours:g}h sem resposta.")
            print("NDS GATE: expirou sem resposta; abortando a wave.", flush=True)
            return 3
        if poll_seconds > 0:
            time.sleep(poll_seconds)


def load_config(folder: Path) -> Dict[str, Any]:
    config: Dict[str, Any] = {}
    try:
        loaded = json.loads((folder / CONFIG_FILE).read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            config = loaded
    except (OSError, ValueError):
        pass
    env_issue = os.environ.get(ISSUE_ENV, "").strip()
    if env_issue:
        config["issue"] = env_issue
    return config


def _row(worker: Dict[str, Any]) -> str:
    tokens = worker.get("tokens")
    cost = worker.get("costUsd")
    return (f"| {worker.get('label') or worker.get('id') or '?'} "
            f"| {worker.get('model') or '—'} | {worker.get('status') or '?'} "
            f"| {tokens if tokens is not None else '—'} "
            f"| {'$' + format(cost, '.2f') if cost is not None else '—'} |")


def format_comment(event: str, report: Optional[Dict[str, Any]], text: str = "") -> str:
    titles = {
        "spec-rejected": "Spec reprovada na validação",
        "spec-approved": "Spec aprovada nas 5 categorias",
        "wave-done": "Wave concluída",
        "gate-waiting": "⛔ Gate aguardando aprovação humana",
        "gate-approved": "Gate aprovado",
        "gate-rejected": "Gate recusado — pipeline abortado",
        "abort": "Pipeline abortado",
        "final": "Pipeline concluído",
    }
    lines = [f"### {titles.get(event, event)}", ""]
    if text:
        lines += [text, ""]
    if report and report.get("workers"):
        lines += ["| Etapa | Modelo | Status | Tokens | Custo |",
                  "|---|---|---|---|---|"]
        lines += [_row(w) for w in report["workers"]]
        totals = report.get("totals") or {}
        if totals.get("tokens") is not None:
            cost = totals.get("costUsd")
            lines += [f"| **Total** | | | **{totals['tokens']}** "
                      f"| **{'$' + format(cost, '.2f') if cost is not None else '—'}** |"]
        lines.append("")
    lines.append(f"_evento: `{event}` · {_now()}_")
    return "\n".join(lines)


def _append_pending(folder: Path, event: str, body: str) -> None:
    with (folder / PENDING_FILE).open("a", encoding="utf-8") as handle:
        handle.write(f"\n## {event} — {_now()}\n\n{body}\n")


def notify(folder: Path, event: str, report: Optional[Dict[str, Any]] = None,
           text: str = "") -> int:
    """Best-effort GitLab comment; never raises, never fails the pipeline."""
    try:
        if not folder.is_dir():
            return 0
        body = format_comment(event, report, text)
        config = load_config(folder)
        issue = str(config.get("issue") or "").strip()
        if not issue:
            _append_pending(folder, event, body)
            return 0
        cmd = ["glab", "issue", "note", issue, "-m", body]
        repo = str(config.get("repo") or "").strip()
        if repo:
            cmd += ["--repo", repo]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            _append_pending(folder, event, body)
            return 0
        return 0
    except Exception:
        # Last resort: a malformed report or an unwritable folder must never
        # break the pipeline (spec edge case "glab/falha não derruba a wave").
        try:
            _append_pending(folder, event, f"(fallback) {event} — comentário não pôde ser formado/enviado")
        except Exception:
            pass
        return 0
