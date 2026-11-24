# FORK-DELTA — alethe-orca/skill

Fork de https://github.com/Kc1t/alethe-orchestrate-skill (MIT) com o delta do NDS.
Arquivos modificados/criados em relação ao upstream (manter esta lista atualizada a cada task):

## Modificados
- skill/skills/alethe/scripts/orchestrate.py (import nds; flag --gate-before; subcomandos gate, nds-event, spec)
- skill/skills/alethe/playbooks.yaml (playbook handoff-spec-review; adapter opencode)

## Criados
- skill/FORK-DELTA.md (este arquivo)
- skill/skills/alethe/scripts/nds.py (gate + notify + spec attempts)
- skill/skills/alethe/references/nds-spec-matrix.md
- skill/skills/alethe/references/nds-runbook.md
- skill/tests/test_nds_gate.py
- skill/tests/test_nds_notify.py

## Auditoria: os 7 problemas resolvidos
1. Handoff entre etapas sem mecanismo → runner do alethe controla as waves + write-back visível na issue (Tasks 3–5)
2. Prompts gigantes embutidos em `--command` → briefs em arquivo no modelo do alethe; comandos do runbook curtos (Task 7)
3. `--dangerously-skip-permissions` → executor via worker safety do alethe, sem essa flag (runbook Task 7)
4. Loop de reprovação sem teto → `spec rejected` com máximo 2, 3ª aborta exit 2 (Task 6)
5. IDs de modelo hardcoded → config na playbook/runbook, não em comandos (Task 7)
6. Sem estado persistente → issue GitLab como estado + `gate.json`/`spec_attempts.json` em disco (Tasks 2/4/5)
7. Sem timeout por wave → gate 24h (`NDS_GATE_HOURS`) + `defaultTimeoutSeconds` por wave no runbook (Tasks 2/7)

## Como sincronizar com o upstream
git fetch upstream && git merge upstream/main --no-edit
Conflitos só aparecem nos arquivos listados acima; resolva preservando o delta NDS.
