"""NDS fork helpers: human gate and dual-forge write-back for alethe-orchestrate.

Stdlib only. The gate is a small JSON state machine in the orchestration folder;
approval comes from this terminal's stdin or from `orchestrate.py gate approve`
in another terminal. Never raises into the runner: write-back is best effort.
Comments go to GitHub (`gh`) or GitLab (`glab`) per the resolved forge.
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
FORGE_ENV = "NDS_FORGE"
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


def _resolve_report(factory: Optional[Callable[[], Optional[Dict[str, Any]]]]) -> Optional[Dict[str, Any]]:
    """Evaluate a lazy report factory; a raising factory degrades to no report."""
    if factory is None:
        return None
    try:
        return factory()
    except Exception:
        return None


def gate_wait(folder: Path, label: str, timeout_hours: float = 24.0,
              poll_seconds: float = 2.0,
              report_factory: Optional[Callable[[], Optional[Dict[str, Any]]]] = None) -> int:
    """Block until the gate for `label` is approved (0) or rejected/expired (3)."""
    env_hours = os.environ.get(GATE_ENV_HOURS, "").strip()
    if env_hours:
        try:
            timeout_hours = float(env_hours)
        except ValueError:
            pass
    existing = _read_gate(folder)
    if existing and existing.get("label") == label and existing.get("state") == "approved":
        return 0  # idempotente: retry não pausa de novo
    if existing and existing.get("label") == label and existing.get("state") == "rejected":
        return 3
    _write_gate(folder, "waiting", label, "terminal")
    _prompt(label, folder)
    notify(folder, "gate-waiting", _resolve_report(report_factory),
           text=f"Wave `{label}` pausada; aguardando aprovação humana "
                f"(libere com `orchestrate.py gate approve --in \"{folder}\"`).")
    threading.Thread(target=_stdin_watcher, args=(folder, label), daemon=True).start()
    deadline = time.monotonic() + (timeout_hours * 3600)
    while True:
        state = _read_gate(folder) or {}
        if state.get("state") == "approved":
            notify(folder, "gate-approved", _resolve_report(report_factory),
                   text=f"Wave `{label}` liberada.")
            return 0
        if state.get("state") == "rejected":
            notify(folder, "gate-rejected", _resolve_report(report_factory),
                   text=f"Wave `{label}` abortada: recusada pelo usuário.")
            return 3
        if time.monotonic() > deadline:
            _write_gate(folder, "expired", label, "timeout")
            notify(folder, "gate-rejected", _resolve_report(report_factory),
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


def resolve_forge(config: Dict[str, Any]) -> str:
    """Env `NDS_FORGE` > nds.json `"forge"` > default `"gitlab"` (comportamento antigo).

    Um valor desconhecido em qualquer fonte é ignorado e a próxima candidata
    decide; sem nenhuma válida, o default gitlab preserva o fork antigo.
    """
    for candidate in (os.environ.get(FORGE_ENV, ""), config.get("forge", "")):
        value = str(candidate or "").strip().lower()
        if value in ("github", "gitlab"):
            return value
    return "gitlab"


def _comment_cmd(forge: str, issue: str, body: str, repo: str) -> list:
    """O argv de comentário do forge: gh no GitHub, glab no GitLab.

    `--repo` viaja só quando o config tem `repo` — nos dois forges (o gh aceita
    `--repo <owner>/<repo>`; o glab já recebia assim, inalterado).
    """
    if forge == "github":
        cmd = ["gh", "issue", "comment", issue, "--body", body]
    else:
        cmd = ["glab", "issue", "note", issue, "-m", body]
    if repo:
        cmd += ["--repo", repo]
    return cmd


def notify(folder: Path, event: str, report: Optional[Dict[str, Any]] = None,
           text: str = "") -> int:
    """Best-effort comment on the resolved forge; never raises, never fails the pipeline."""
    try:
        if not folder.is_dir():
            return 0
        body = format_comment(event, report, text)
        config = load_config(folder)
        issue = str(config.get("issue") or "").strip()
        if not issue:
            _append_pending(folder, event, body)
            return 0
        repo = str(config.get("repo") or "").strip()
        cmd = _comment_cmd(resolve_forge(config), issue, body, repo)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            # gh/glab ausente/quebrado/estourou timeout: preserva o comentário
            # COMPLETO (tabela inclusive) localmente — só surpresas inesperadas
            # caem no fallback de marcação única lá embaixo.
            _append_pending(folder, event, body)
            return 0
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


def pending_warning(folder: Path) -> Optional[str]:
    """One-line summary when write-back events are queued locally, else None."""
    path = folder / PENDING_FILE
    try:
        count = path.read_text(encoding="utf-8").count("\n## ")
    except OSError:
        return None
    if count:
        return f"NDS write-back: {count} evento(s) não enviados acumulados em {path}"
    return None


def spec_rejected(folder: Path, report: Optional[Dict[str, Any]] = None,
                  text: str = "",
                  report_factory: Optional[Callable[[], Optional[Dict[str, Any]]]] = None) -> int:
    """Count a spec rejection; abort (exit 2) on the third. Idempotent past the abort."""
    path = folder / ATTEMPTS_FILE
    try:
        attempts = int(json.loads(path.read_text(encoding="utf-8")).get("attempts", 0))
    except (OSError, ValueError):
        attempts = 0
    if attempts >= 3:
        return 2  # já abortou; não repete comentário nem contador
    attempts += 1
    path.write_text(json.dumps({"attempts": attempts, "updatedAt": _now()}), encoding="utf-8")
    detail = text or f"Reprovação {attempts} de 2 na validação das 5 categorias."
    effective = report if report is not None else _resolve_report(report_factory)
    notify(folder, "spec-rejected", effective, text=detail)
    if attempts >= 3:
        notify(folder, "abort", effective,
               text="Spec não aprovada em 2 tentativas; fluxo abortado. "
                    "Reescreva a spec com a matriz completa antes de reabrir a issue.")
        return 2
    return 0


def spec_approved(folder: Path, report: Optional[Dict[str, Any]] = None,
                  text: str = "",
                  report_factory: Optional[Callable[[], Optional[Dict[str, Any]]]] = None) -> int:
    path = folder / ATTEMPTS_FILE
    path.write_text(json.dumps({"attempts": 0, "updatedAt": _now()}), encoding="utf-8")
    effective = report if report is not None else _resolve_report(report_factory)
    return notify(folder, "spec-approved", effective,
                  text=text or "Spec aprovada nas 5 categorias; liberado para o gate humano.")
