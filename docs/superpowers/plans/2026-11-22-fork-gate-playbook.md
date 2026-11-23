# NDS Standard — Plano 1: Fork + Gate Humano + Write-back GitLab + Playbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forkar o `alethe-orchestrate-skill` para `alethe-orca/skill/` com gate humano nativo, write-back de status/tokens na issue GitLab e a playbook `handoff-spec-review` do processo NDS.

**Architecture:** O fork preserva o runner stdlib do upstream (`orchestrate.py`, 6.6k linhas) e adiciona um módulo irmão novo `nds.py` (gate + notificações GitLab) injetado por import leve. Integrações são pontos finos: um subcomando `gate`, uma flag `--gate-before` no `run`, um subcomando `nds-event` e chamadas de notificação no fim do `run`. A playbook entra no `playbooks.yaml` existente e é validada pelo validador próprio do upstream.

**Tech Stack:** Python 3.9+ (stdlib only), unittest (não pytest — a CI upstream usa `python -m unittest discover -s tests`), PyYAML só para `tools/check_playbooks.py`, `glab` CLI para comentários na issue.

**Spec:** `alethe-orca/docs/superpowers/specs/2026-11-22-alethe-orca-design.md`

**Repositório de trabalho:** `alethe-orca/` (repo central, já existe com a spec commitada). O fork vive em `alethe-orca/skill/`.

## Global Constraints

- Python ≥ 3.9; **somente stdlib** no runner (única exceção: subprocess chamando `glab`; PyYAML só em tooling de validação).
- **unittest, não pytest** — desvio consciente da spec (a spec diz pytest; a CI upstream é unittest; manter unittest preserva a CI e os testes existentes). Cobrir todos os cenários da spec.
- A suíte upstream deve continuar **100% verde** após cada task: `python -m unittest discover -s tests`.
- LICENSE (MIT) do upstream preservado; **todo arquivo tocado listado em `FORK-DELTA.md`** (Task 8).
- IDs de modelo NDS (não hardcoded em comandos): planner = `opencode` (modelo gratuito), validator/reviewer = `claude` `opus`, executor = `agy` `gemini-3.7-pro`. Valores no bloco `models`/fases da playbook.
- Mesmo worktree sempre (`--in current`); **nunca** `--dangerously-skip-permissions`.
- Gate humano é inegociável: sem aprovação explícita (`sim`/`approve`) não existe wave de execução.
- Write-back nunca derruba o pipeline: falha de `glab` → acumula em `writeback-pending.md`.
- Gate timeout default: **24 horas** (`NDS_GATE_HOURS` env sobrescreve).

## Review Focus

Os 5 pontos que a spec implica mas que mais vão morder quem usar o software:

1. **`run --gate-before` sem `--in`** — a wave avulsa não tem pasta de orquestração onde gravar o gate; o esperado é falhar cedo com `PlanError` claro (exit 2), não rodar sem gate. → Task 3, teste `test_gate_before_requires_orchestration`.
2. **`glab` ausente ou deslogado** — write-back é best-effort; o esperado é que a wave continue normalmente e o comentário caia em `writeback-pending.md` com data/evento. → Task 4, teste com PATH sem `glab`.
3. **Gate idempotente** — re-executar `run --gate-before` depois de aprovado (retry do mesmo wave) não deve pausar de novo nem recontar. → Task 2, teste `test_gate_wait_approves_without_pause_when_already_approved`.
4. **Contador de reprovação de spec** — o 3º evento `spec-rejected` deve gerar UM comentário de aborto e exit ≠ 0; eventos repetidos do mesmo estado não podem inflar o contador. → Task 6, teste `test_third_rejection_aborts_once`.
5. **CLI upstream sem o fork NDS** — se `nds.py` não existir/nao importar, tudo do upstream continua funcionando (import guardado). → Task 3, teste `test_cli_works_without_nds_module`.

---

### Task 1: Fork bootstrap do upstream

**Files:**
- Create: `skill/` (cópia completa do upstream, sem `.git`)
- Create: `skill/FORK-DELTA.md`
- Modify: `.gitignore` (raiz do repo)

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: árvore `skill/` com `skills/alethe/scripts/orchestrate.py`, `skills/alethe/playbooks.yaml`, `tests/`, `tools/`; remote `upstream` apontando para o GitHub original; baseline verde que as próximas tasks usam.

- [ ] **Step 1: Copiar o upstream para dentro do repo**

```bash
cd /Users/gustavomartinslima/Documents/Projetos_ebnez/alethe-orca
git clone --depth 1 https://github.com/Kc1t/alethe-orchestrate-skill.git /tmp/alethe-upstream-fork
rsync -a --exclude='.git' /tmp/alethe-upstream-fork/ skill/
rm -rf /tmp/alethe-upstream-fork
```

- [ ] **Step 2: Registrar o remote upstream e criar o esqueleto de FORK-DELTA.md**

```bash
git remote add upstream https://github.com/Kc1t/alethe-orchestrate-skill.git
```

Criar `skill/FORK-DELTA.md` com o conteúdo:

```markdown
# FORK-DELTA — alethe-orca/skill

Fork de https://github.com/Kc1t/alethe-orchestrate-skill (MIT) com o delta do NDS.
Arquivos modificados/criados em relação ao upstream (manter esta lista atualizada a cada task):

## Modificados
_(Task 3 preenche: skills/alethe/scripts/orchestrate.py)_

## Criados
- skill/FORK-DELTA.md (este arquivo)
- skill/skills/alethe/scripts/nds.py (Tasks 2–6)
- skill/tests/test_nds_gate.py (Tasks 2–3)
- skill/tests/test_nds_notify.py (Tasks 4–6)
- skill/skills/alethe/references/nds-spec-matrix.md (Task 7)
- skill/skills/alethe/playbooks.yaml → entrada handoff-spec-review (Task 7)

## Como sincronizar com o upstream
git fetch upstream && git merge upstream/main --no-edit
Conflitos só aparecem nos arquivos listados acima; resolva preservando o delta NDS.
```

- [ ] **Step 3: Rodar a suíte upstream como baseline**

```bash
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -5
```

Expected: `OK` (todos os testes passam — é uma cópia limpa).

- [ ] **Step 4: Validar os playbooks do baseline (requer PyYAML)**

```bash
cd skill && python3 -m pip install --user pyyaml -q && python3 tools/check_playbooks.py
```

Expected: exit 0, sem problemas reportados. Se `pyyaml` não instalar via `--user`, usar `python3 -m pip install pyyaml` (ambiente do NDS tem permissão).

- [ ] **Step 5: Commit**

```bash
cd /Users/gustavomartinslima/Documents/Projetos_ebnez/alethe-orca
echo "__pycache__/" >> .gitignore
echo "*.pyc" >> .gitignore
git add skill .gitignore
git commit -m "feat(fork): importa alethe-orchestrate-skill como base do NDS"
```

---

### Task 2: Módulo `nds.py` — máquina de estados do gate humano

**Files:**
- Create: `skill/skills/alethe/scripts/nds.py`
- Test: `skill/tests/test_nds_gate.py`

**Interfaces:**
- Consumes: nada (módulo novo, stdlib puro).
- Produces (exatos, usados pela Task 3):
  - `GATE_FILE = "gate.json"`, `PENDING_FILE = "writeback-pending.md"`, `CONFIG_FILE = "nds.json"`
  - `gate_status(folder: Path, label: str | None = None) -> dict`
  - `gate_approve(folder: Path, label: str | None = None) -> dict`
  - `gate_reject(folder: Path, label: str | None = None) -> dict`
  - `gate_wait(folder: Path, label: str, timeout_hours: float = 24.0, poll_seconds: float = 2.0) -> int` — retorna `0` (aprovado), `3` (rejeitado/expirado)
  - Formato de `gate.json`: `{"label": str, "state": "waiting|approved|rejected|expired", "createdAt": iso, "resolvedAt": iso | null, "by": "terminal|file"}`

- [ ] **Step 1: Escrever o teste falhando**

Criar `skill/tests/test_nds_gate.py`:

```python
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Rodar o teste para confirmar que falha**

```bash
cd skill && python3 -m unittest tests.test_nds_gate -v 2>&1 | tail -5
```

Expected: FAIL com `FileNotFoundError: .../nds.py` (módulo não existe).

- [ ] **Step 3: Implementar `nds.py` (gate)**

Criar `skill/skills/alethe/scripts/nds.py`:

```python
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
    state = _read_gate(folder)
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
    state = _read_gate(folder)
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
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
cd skill && python3 -m unittest tests.test_nds_gate -v 2>&1 | tail -8
```

Expected: `OK` (5 testes).

- [ ] **Step 5: Commit**

```bash
git add skill/skills/alethe/scripts/nds.py skill/tests/test_nds_gate.py
git commit -m "feat(nds): gate humano com estado em gate.json e aprovação por terminal/arquivo"
```

---

### Task 3: Integração no `orchestrate.py` — `gate` e `run --gate-before`

**Files:**
- Modify: `skill/skills/alethe/scripts/orchestrate.py` (imports no topo; parsers perto da linha ~6342 onde `run_parser` é criado; dispatch na cadeia `if args.command == ...` que começa na linha ~6452; branch do `run` que retorna `run_batch(...)` na linha ~6660)
- Test: `skill/tests/test_nds_gate.py` (adicionar classe `GateCliTest`)

**Interfaces:**
- Consumes: `nds.gate_wait/gate_status/gate_approve/gate_reject/GateError` (Task 2), `resolve_folder` (existente, linha 3972), `PlanError` (existente).
- Produces: CLI `orchestrate.py gate {status|approve|reject} --in <folder> [--label L]` e flag `run --gate-before <label>`; comportamento de exit: `0` aprovado, `3` gate rejeitado/expirado, `2` erro de uso.

- [ ] **Step 1: Escrever os testes falhando**

Adicionar ao final de `skill/tests/test_nds_gate.py` (antes de `if __name__`):

```python
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

    def test_cli_works_without_nds_module(self):
        # compat: import guardado — main continua existindo sem nds
        self.assertTrue(hasattr(self.orch_mod, "main"))
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
cd skill && python3 -m unittest tests.test_nds_gate -v 2>&1 | tail -6
```

Expected: FAIL em `GateCliTest` (`gate` não é subcomando reconhecido → SystemExit/`PlanError`).

- [ ] **Step 3: Implementar no `orchestrate.py`**

3a. **Import guardado** — logo após os imports padrão do topo do arquivo (junto dos outros `import`):

```python
# NDS fork: gate humano + write-back GitLab (see FORK-DELTA.md)
try:
    import nds  # type: ignore
except ImportError:  # pragma: no cover - upstream copy without the NDS delta
    nds = None
```

Se `import nds` não resolver (scripts não está no `sys.path` quando o arquivo é carregado por importlib), usar no lugar:

```python
import sys as _sys
from pathlib import Path as _Path
_scripts_dir = str(_Path(__file__).resolve().parent)
if _scripts_dir not in _sys.path:
    _sys.path.insert(0, _scripts_dir)
try:
    import nds  # type: ignore
except ImportError:  # pragma: no cover
    nds = None
```

3b. **Parser da flag** — junto da criação do `run_parser` (linha ~6342):

```python
run_parser.add_argument(
    "--gate-before", metavar="LABEL",
    help="NDS: pause for human approval before starting this wave's workers",
)
```

3c. **Subcomando `gate`** — logo após o bloco do `run_parser`:

```python
gate_parser = subparsers.add_parser("gate", help="NDS: inspect, approve or reject a human gate")
gate_parser.add_argument("action", choices=["status", "approve", "reject"])
gate_parser.add_argument("--in", dest="into", metavar="FOLDER", default="current")
gate_parser.add_argument("--label", default=None)
```

3d. **Dispatch** — inserir na cadeia de `if args.command == ...` (antes do branch `if args.command == "run":`), com o mesmo padrão dos vizinhos:

```python
if args.command == "gate":
    if nds is None:
        raise PlanError("NDS fork helpers are not installed (nds.py missing)")
    folder = resolve_folder(None if args.into == "current" else Path(args.into))
    if args.action == "status":
        print(json.dumps(nds.gate_status(folder, args.label), ensure_ascii=False))
    elif args.action == "approve":
        print(json.dumps(nds.gate_approve(folder, args.label), ensure_ascii=False))
    else:
        print(json.dumps(nds.gate_reject(folder, args.label), ensure_ascii=False))
    return 0
```

(Tratar `nds.GateError` imprimindo `error: {msg}` em stderr e `return 2`, mesmo padrão do `except PlanError` no fim do `main`.)

3e. **Gate no branch do `run`** — no bloco do `run` que resolve `run_dir`/`folder` (linha ~6647), **antes** do `if args.detach:`:

```python
if args.gate_before:
    if nds is None:
        raise PlanError("NDS fork helpers are not installed (nds.py missing)")
    if not args.into:
        raise PlanError("--gate-before requires --in (an orchestration folder); "
                        "a bare run has nowhere to keep the gate state")
    gate_rc = nds.gate_wait(folder, args.gate_before)
    if gate_rc != 0:
        return gate_rc
```

(`folder` já foi resolvido acima pelo bloco `if args.into:` — reaproveitar essa variável; se o branch do `run` calcular `folder` só dentro do `if args.into`, movê-lo para fora do `if` mantendo o mesmo valor.)

- [ ] **Step 4: Rodar os testes novos e a suíte completa**

```bash
cd skill && python3 -m unittest tests.test_nds_gate -v 2>&1 | tail -8
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -4
```

Expected: ambos `OK`. Se `test_cli_works_without_nds_module` falhar por import circular, ajustar o import guardado para o caminho com `sys.path` (3a).

- [ ] **Step 5: Commit**

```bash
git add skill/skills/alethe/scripts/orchestrate.py skill/tests/test_nds_gate.py
git commit -m "feat(nds): subcomando gate e run --gate-before com pausa humana obrigatória"
```

---

### Task 4: Write-back GitLab — `nds.notify` e `nds-event`

**Files:**
- Modify: `skill/skills/alethe/scripts/nds.py` (adicionar função `notify` e helpers)
- Modify: `skill/skills/alethe/scripts/orchestrate.py` (subcomando `nds-event`)
- Test: `skill/tests/test_nds_notify.py`

**Interfaces:**
- Consumes: `build_report(run_dirs, folder)` (existente, linha 5552 do orchestrate.py), `resolve_folder`, `glab` no PATH.
- Produces:
  - `nds.load_config(folder) -> dict` — lê `nds.json` (`{"issue": "<iid>", "repo": "<path|url opcional>"}`) ou env `NDS_ISSUE` (iid)
  - `nds.format_comment(event: str, report: dict | None, text: str = "") -> str` — markdown com tabela `Etapa | Modelo | Status | Tokens | Custo`
  - `nds.notify(folder, event, report=None, text="") -> int` — `0` enviado/pending registrado; **nunca lança exceção**
  - CLI: `orchestrate.py nds-event <event> --in <folder> [--text "..."]` com events `spec-rejected|spec-approved|wave-done|gate-waiting|gate-approved|gate-rejected|abort|final`

- [ ] **Step 1: Escrever o teste falhando**

Criar `skill/tests/test_nds_notify.py`:

```python
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
cd skill && python3 -m unittest tests.test_nds_notify -v 2>&1 | tail -5
```

Expected: FAIL com `AttributeError: module ... has no attribute 'format_comment'`.

- [ ] **Step 3: Implementar `notify` em `nds.py`**

Acrescentar ao final de `skill/skills/alethe/scripts/nds.py`:

```python
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
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        _append_pending(folder, event, body)
        return 0
    if result.returncode != 0:
        _append_pending(folder, event, body)
        return 0
    return 0
```

- [ ] **Step 4: Rodar os testes do notify**

```bash
cd skill && python3 -m unittest tests.test_nds_notify -v 2>&1 | tail -6
```

Expected: `OK` (3 testes).

- [ ] **Step 5: Escrever o teste do subcomando `nds-event` (falha primeiro)**

Adicionar em `skill/tests/test_nds_notify.py`:

```python
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
```

Rodar: `cd skill && python3 -m unittest tests.test_nds_notify.NdsEventCliTest -v`
Expected: FAIL (`nds-event` não existe).

- [ ] **Step 6: Implementar o subcomando `nds-event` no `orchestrate.py`**

Parser (junto dos demais subparsers):

```python
nds_event_parser = subparsers.add_parser(
    "nds-event", help="NDS: publish a write-back event to the GitLab issue")
nds_event_parser.add_argument("event", choices=[
    "spec-rejected", "spec-approved", "wave-done",
    "gate-waiting", "gate-approved", "gate-rejected", "abort", "final"])
nds_event_parser.add_argument("--in", dest="into", metavar="FOLDER", default="current")
nds_event_parser.add_argument("--text", default="")
nds_event_parser.add_argument("--report", default=None,
                              help="folder or run dir to build the tokens/models table from")
```

Dispatch (mesma cadeia `if args.command == ...`):

```python
if args.command == "nds-event":
    if nds is None:
        raise PlanError("NDS fork helpers are not installed (nds.py missing)")
    folder = resolve_folder(None if args.into == "current" else Path(args.into))
    report = None
    if args.report:
        report = build_report(find_run_dirs([Path(args.report)]), folder)
    elif args.event in ("wave-done", "final"):
        try:
            report = build_report(wave_dirs(folder), folder)
        except Exception:
            report = None
    nds.notify(folder, args.event, report, text=args.text)
    return 0
```

(`wave_dirs` e `find_run_dirs` existem no upstream — `report_target`, linha ~4202, usa os dois; `build_report` é a linha ~5552.)

- [ ] **Step 7: Rodar tudo**

```bash
cd skill && python3 -m unittest tests.test_nds_notify -v 2>&1 | tail -4
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -4
```

Expected: `OK` nos dois.

- [ ] **Step 8: Commit**

```bash
git add skill/skills/alethe/scripts/nds.py skill/skills/alethe/scripts/orchestrate.py skill/tests/test_nds_notify.py
git commit -m "feat(nds): write-back GitLab com tabela etapa/modelo/tokens/custo e fallback pendente"
```

---

### Task 5: Hooks de eventos no fluxo (gate + fim de wave)

**Files:**
- Modify: `skill/skills/alethe/scripts/nds.py` (`gate_wait` publica eventos)
- Modify: `skill/skills/alethe/scripts/orchestrate.py` (publica `wave-done` ao fim do `run`)
- Test: `skill/tests/test_nds_notify.py`

**Interfaces:**
- Consumes: `nds.notify` (Task 4), `gate_wait` (Task 2), `build_report` (upstream).
- Produces: comportamento — `run --gate-before` publica `gate-waiting` ao pausar, `gate-approved`/`gate-rejected` ao resolver; `run` com `--in` publica `wave-done` ao terminar (exit 0 ou ≠0). Config vem de `nds.json`/`NDS_ISSUE`; sem config, silencioso (só pending).

- [ ] **Step 1: Escrever o teste falhando**

Adicionar em `skill/tests/test_nds_notify.py`:

```python
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
```

Rodar: `cd skill && python3 -m unittest tests.test_nds_notify.GateNotifyTest -v`
Expected: FAIL (`notify` não é chamado por `gate_wait`).

- [ ] **Step 2: Implementar os eventos do gate em `nds.py`**

Três pontos exatos em `gate_wait` (reposicionar os `notify` assim):

1. Depois de `_write_gate(folder, "waiting", label, "terminal")` e `_prompt(...)`:

```python
    notify(folder, "gate-waiting", None,
           text=f"Wave `{label}` pausada; aguardando aprovação humana "
                f"(libere com `orchestrate.py gate approve --in \"{folder}\"`).")
```

2. Nos ramos que resolvem como aprovado — o ramo idempotente do topo **não** notifica:

```python
            notify(folder, "gate-approved", None, text=f"Wave `{label}` liberada.")
            return 0
```

3. Na rejeição explícita (stdin com palavra de rejeição, ou `gate.json` já em `rejected`):

```python
                notify(folder, "gate-rejected", None,
                       text=f"Wave `{label}` abortada: recusada pelo usuário.")
                return 3
```

e na expiração, logo após `_write_gate(folder, "expired", label, "timeout")`:

```python
            notify(folder, "gate-rejected", None,
                   text=f"Wave `{label}` abortada: gate expirou após {timeout_hours:g}h sem resposta.")
            return 3
```

- [ ] **Step 3: Hook do fim da wave no `orchestrate.py`**

No branch do `run`, envolver o retorno de `run_batch` (linha ~6660):

```python
        rc = run_batch(args.plan, run_dir, policy_path, args.strategy,
                       args._background, args.allow_low_quota)
        if nds is not None and args.into and not args._background:
            folder = resolve_folder(None if args.into == "current" else Path(args.into))
            report = None
            try:
                report = build_report([run_dir] if run_dir else [], folder)
            except Exception:
                report = None
            nds.notify(folder, "wave-done", report,
                       text=f"Wave terminou com exit {rc}.")
        return rc
```

- [ ] **Step 4: Rodar tudo**

```bash
cd skill && python3 -m unittest tests.test_nds_notify -v 2>&1 | tail -4
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -4
```

Expected: `OK` nos dois.

- [ ] **Step 5: Commit**

```bash
git add skill/skills/alethe/scripts/nds.py skill/skills/alethe/scripts/orchestrate.py skill/tests/test_nds_notify.py
git commit -m "feat(nds): eventos gate-waiting/approved/rejected e wave-done publicados na issue"
```

---

### Task 6: Teto de reprovação de spec (máx. 2 voltas)

**Files:**
- Modify: `skill/skills/alethe/scripts/nds.py` (contador de tentativas + abort)
- Test: `skill/tests/test_nds_notify.py`

**Interfaces:**
- Consumes: `notify` (Task 4).
- Produces: `nds.spec_rejected(folder, report=None, text="") -> int` — incrementa `spec_attempts.json` (`{"attempts": n, "updatedAt": iso}`); nas 1ª e 2ª reprovação publica `spec-rejected` e retorna `0` (lead deve voltar ao planner); na **3ª** publica `spec-rejected` + `abort` ("spec não aprovada em 2 tentativas") e retorna `2` (o lead **deve** abortar o fluxo). Eventos repetidos do mesmo valor de `attempts` são idempotentes (não publicam duas vezes).

- [ ] **Step 1: Escrever o teste falhando**

Adicionar em `skill/tests/test_nds_notify.py`:

```python
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
```

Rodar: `cd skill && python3 -m unittest tests.test_nds_notify.SpecAttemptsTest -v`
Expected: FAIL (`spec_rejected` não existe).

- [ ] **Step 2: Implementar em `nds.py`**

```python
def spec_rejected(folder: Path, report: Optional[Dict[str, Any]] = None,
                  text: str = "") -> int:
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
    notify(folder, "spec-rejected", report, text=detail)
    if attempts >= 3:
        notify(folder, "abort", report,
               text="Spec não aprovada em 2 tentativas; fluxo abortado. "
                    "Reescreva a spec com a matriz completa antes de reabrir a issue.")
        return 2
    return 0


def spec_approved(folder: Path, report: Optional[Dict[str, Any]] = None,
                  text: str = "") -> int:
    path = folder / ATTEMPTS_FILE
    path.write_text(json.dumps({"attempts": 0, "updatedAt": _now()}), encoding="utf-8")
    return notify(folder, "spec-approved", report,
                  text=text or "Spec aprovada nas 5 categorias; liberado para o gate humano.")
```

- [ ] **Step 3: Ligar ao CLI — subcomando `spec` no `orchestrate.py`**

Parser:

```python
spec_parser = subparsers.add_parser(
    "spec", help="NDS: record a spec validation result (counts rejections, max 2)")
spec_parser.add_argument("result", choices=["rejected", "approved"])
spec_parser.add_argument("--in", dest="into", metavar="FOLDER", default="current")
spec_parser.add_argument("--text", default="")
```

Dispatch (mesma cadeia):

```python
if args.command == "spec":
    if nds is None:
        raise PlanError("NDS fork helpers are not installed (nds.py missing)")
    folder = resolve_folder(None if args.into == "current" else Path(args.into))
    if args.result == "rejected":
        return nds.spec_rejected(folder, text=args.text)
    return nds.spec_approved(folder, text=args.text)
```

- [ ] **Step 4: Rodar tudo**

```bash
cd skill && python3 -m unittest tests.test_nds_notify -v 2>&1 | tail -4
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -4
```

Expected: `OK` nos dois.

- [ ] **Step 5: Commit**

```bash
git add skill/skills/alethe/scripts/nds.py skill/skills/alethe/scripts/orchestrate.py skill/tests/test_nds_notify.py
git commit -m "feat(nds): teto de 2 reprovações de spec com aborto na 3ª"
```

---

### Task 7: Playbook `handoff-spec-review` + matriz das 5 categorias

**Files:**
- Modify: `skill/skills/alethe/playbooks.yaml` (nova entrada em `playbooks:` + adapter `opencode` em `adapters:`)
- Create: `skill/skills/alethe/references/nds-spec-matrix.md`
- Create: `skill/skills/alethe/references/nds-runbook.md`

**Interfaces:**
- Consumes: validador `tools/check_playbooks.py` (formato documentado em `references/playbooks.md`: chaves de fase `id, role, who, tier, provider, model, effort, readOnly, workers, isolate, runner, does, returns, gate, if, with, after, then, rules`; `adapters` com `command, args, promptTransport, outputFormat, checked`).
- Produces: playbook `handoff-spec-review` que o lead escolhe; runbook com os comandos exatos das waves (inclui `--gate-before executor-approval` e `spec rejected/approved`).

- [ ] **Step 1: Criar a matriz das 5 categorias**

Criar `skill/skills/alethe/references/nds-spec-matrix.md` com a tabela integral da skill original (copiar de `.agents/skills/orca_superpowers_handoff_skill.md`, seção "Matriz de Avaliação de Specs") — as 5 categorias com colunas "Conteúdo Válido & Relevante (Aprovado)" e "Sinal de Cumprir Tabela (Reprovado)". Acrescentar ao final:

```markdown
## Regras de uso (NDS fork)

- O validador roda em read-only e só responde: APROVADO nas 5, ou a lista de falhas por categoria.
- Falhas => o lead roda `orchestrate.py spec rejected --in current --text "<falhas>"` e volta ao planner.
- Aprovação => `orchestrate.py spec approved --in current` e segue para o GATE HUMANO.
- Máximo 2 reprovações; a 3ª aborta o fluxo automaticamente.
```

- [ ] **Step 2: Criar o runbook com os comandos das waves**

Criar `skill/skills/alethe/references/nds-runbook.md`:

```markdown
# NDS runbook — playbook handoff-spec-review

Tudo roda na pasta de orquestração do workspace (mesmo worktree, `--in current`).

## Setup da issue (uma vez por tarefa)
    orca reference add <url-da-issue-gitlab> --worktree active
    echo '{"issue": "<iid>"}' > <folder>/nds.json

## Wave 1 — Planner (Opencode, modelo gratuito)
Brief: requisito inicial + "gere spec em docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md
e plano em docs/superpowers/plans/YYYY-MM-DD-<feature>.md usando as skills brainstorming e
writing-plans". defaultTimeoutSeconds: 1800.

## Wave 2 — Validador (Claude Opus, read-only)
Brief: "Leia a spec X e a matriz em skills/alethe/references/nds-spec-matrix.md;
responda APROVADO ou a lista de falhas por categoria". defaultTimeoutSeconds: 900.
Após a resposta do lead:
    python3 skills/alethe/scripts/orchestrate.py spec rejected --in current --text "<falhas>"
    # ou
    python3 skills/alethe/scripts/orchestrate.py spec approved --in current

## ⛔ GATE HUMANO (obrigatório, nativo)
O lead NÃO inicia a wave 3 sem o gate. O runner pausa sozinho:
    python3 skills/alethe/scripts/orchestrate.py run plano-executor.json --in current \
        --gate-before executor-approval
Aprovação: digitar "sim" no terminal OU `orchestrate.py gate approve --in current`
(em outro terminal; fica registrado na issue como gate-waiting/approved).

## Wave 3 — Executor (AGY / gemini-3.7-pro, write, MESMO worktree)
Brief: "Leia o plano Y; TDD estrito (teste -> falha -> código -> passa), commits atômicos,
marque os checkboxes [x]". isolate: false. Sem --dangerously-skip-permissions.
defaultTimeoutSeconds: 2700.

## Wave 4 — Reviewer (Claude Opus, read-only)
Brief: "Rode a suíte real de testes + lint; diff contra a spec; grave o review em
docs/superpowers/reviews/YYYY-MM-DD-<feature>-review.md com Strengths/Issues/Recommendations/
Assessment". defaultTimeoutSeconds: 1800.

## Fim
    python3 skills/alethe/scripts/orchestrate.py nds-event final --in current --text "Ready to merge" 
    python3 skills/alethe/scripts/orchestrate.py report --format html --in current  (abre o report)
```

- [ ] **Step 3: Adicionar a playbook e o adapter em `playbooks.yaml`**

Em `skills/alethe/playbooks.yaml`, dentro do mapa `playbooks:` (após a entrada `complete`), acrescentar:

```yaml
  handoff-spec-review:
    name: NDS Handoff Spec → Review
    goal: Sequential spec-first pipeline with a mandatory human gate and GitLab write-back.
    pickWhen: The NDS standard process: every task goes planner → spec validator → human gate → TDD executor → reviewer.
    avoidWhen: A task that is not going through spec approval (use complete instead).
    phases:
      - id: planner
        role: planner
        provider: opencode
        tier: cheap
        readOnly: false
        does: Read the requirement; write docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md and docs/superpowers/plans/YYYY-MM-DD-<feature>.md with brainstorming and writing-plans.
        returns: Paths of the spec and plan files.
        gate: Both files exist and the plan has checkboxes with explicit tests.
      - id: validator
        role: spec validator
        provider: claude
        model: opus
        effort: high
        readOnly: true
        does: Check the spec against references/nds-spec-matrix.md, all five categories, rejecting "cumprir tabela" sections.
        returns: APROVADO, or the failing categories with the reason.
        gate: |
          Record the result before moving on: run
          `orchestrate.py spec rejected --in current --text "<failures>"` or
          `orchestrate.py spec approved --in current`. On rejection send the
          brief back to the planner (maximum 2 rejections; the tool aborts on the third).
      - id: executor
        role: executor
        provider: agy
        model: gemini-3.7-pro
        readOnly: false
        isolate: false
        does: Execute the plan with strict TDD (test, watch it fail, minimal code, pass), atomic commits, tick the plan checkboxes.
        returns: Commits made, checks run, failures and risks.
        gate: The wave only starts with `run --gate-before executor-approval`; the human must approve.
      - id: reviewer
        role: reviewer
        provider: claude
        model: opus
        effort: high
        readOnly: true
        does: Run the real test suite and linter, diff against the approved spec, write docs/superpowers/reviews/YYYY-MM-DD-<feature>-review.md (Strengths / Issues Critical-Important-Minor with file:line / Recommendations / Assessment).
        returns: Ready to merge, or the pending issues.
        gate: Tests were really executed (never a visual read), and the review file exists.
```

E no mapa `adapters:` — se o mapa não existir no arquivo, criá-lo logo após `providers: [claude, codex]`:

```yaml
adapters:
  opencode:
    command: opencode
    args: ["run"]
    promptTransport: stdin
    outputFormat: text
    checked: true
```

- [ ] **Step 4: Validar com o validador do upstream**

```bash
cd skill && python3 tools/check_playbooks.py
```

Expected: exit 0. Se reportar problema (ex.: chave desconhecida, `checked` com formato errado, `model` inválido para agy), **corrigir conforme a mensagem exata do validador** e rodar de novo até passar — o validador é a fonte de verdade do formato; não remover a playbook para "fazer passar".

- [ ] **Step 5: Conferir que o runner reconhece a playbook**

```bash
cd skill && python3 skills/alethe/scripts/orchestrate.py playbook 2>/dev/null | grep -A2 handoff || python3 skills/alethe/scripts/orchestrate.py playbook | head -30
```

Expected: `handoff-spec-review` listada (o comando `playbook` mostra/valida a playbook ativa).

- [ ] **Step 6: Rodar a suíte completa**

```bash
cd skill && python3 -m unittest discover -s tests 2>&1 | tail -4
```

Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add skill/skills/alethe/playbooks.yaml skill/skills/alethe/references/nds-spec-matrix.md skill/skills/alethe/references/nds-runbook.md
git commit -m "feat(nds): playbook handoff-spec-review com gate, matriz 5 categorias e runbook"
```

---

### Task 8: `FORK-DELTA.md` final, CI do fork e verificação de aceite

**Files:**
- Modify: `skill/FORK-DELTA.md` (listas finais)
- Modify: `.github/workflows/ci.yml` — **não existe CI no repo central ainda**; criar `alethe-orca/.github/workflows/ci.yml`
- Test: verificação manual dos critérios de aceite da spec

**Interfaces:**
- Consumes: Tasks 1–7.
- Produce: CI verde no repo central + FORK-DELTA.md completo (é o que viabiliza `git merge upstream`).

- [ ] **Step 1: Criar a CI do repo central**

Criar `alethe-orca/.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  fork-tests:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest]
        python: ["3.9", "3.13"]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: skill
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: ${{ matrix.python }}
      - run: python -m unittest discover -s tests -v
      - run: python -m pip install pyyaml && python tools/check_playbooks.py

  nds-tests:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: skill
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.13"
      - run: python -m unittest tests.test_nds_gate tests.test_nds_notify -v
```

- [ ] **Step 2: Finalizar `FORK-DELTA.md`**

Atualizar `skill/FORK-DELTA.md` com as listas reais (conferir `git diff` do fork vs upstream):

```markdown
## Modificados
- skills/alethe/scripts/orchestrate.py (import nds; flag --gate-before; subcomandos gate, nds-event, spec)
- skills/alethe/playbooks.yaml (playbook handoff-spec-review; adapter opencode)

## Criados
- FORK-DELTA.md
- skills/alethe/scripts/nds.py (gate + notify + spec attempts)
- skills/alethe/references/nds-spec-matrix.md
- skills/alethe/references/nds-runbook.md
- tests/test_nds_gate.py
- tests/test_nds_notify.py
```

- [ ] **Step 3: Verificação de aceite da spec (manual, documentar resultado)**

```bash
cd skill
python3 -m unittest discover -s tests 2>&1 | tail -3        # suíte completa verde
python3 tools/check_playbooks.py                            # playbook válida
python3 skills/alethe/scripts/orchestrate.py --version      # CLI responde
python3 skills/alethe/scripts/orchestrate.py gate status --in /tmp  # gate responde (exit 0)
```

Conferir na spec (`docs/superpowers/specs/2026-11-22-alethe-orca-design.md`):
- [ ] Nenhum caminho abre executor sem aprovação (testado em `GateCliTest.test_gate_before_blocked_when_rejected`).
- [ ] Todo evento publicado ou cai em `writeback-pending.md` (`NotifyTest`).
- [ ] Tabela de tokens/modelos em `FormatCommentTest.test_table_has_models_and_tokens`.
- [ ] Os 7 problemas da auditoria marcados no `FORK-DELTA.md` (adiantar esta seção do item "Como sincronizar").

- [ ] **Step 4: Commit final**

```bash
git add .github skill/FORK-DELTA.md
git commit -m "chore: CI do fork NDS e FORK-DELTA completo"
```

---

## Fora do escopo deste plano

- Plugin `alethe-report` e plugin `nds-onboarding` (Planos 2 e 3).
- `install.sh`, `PROCESSO.md`, `ONBOARDING.md` e E2E manual (Plano 4).
- Publicação no catálogo de plugins do Orca.
