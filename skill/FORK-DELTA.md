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
