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
- **Máximo 2 reprovações; a 3ª aborta o fluxo automaticamente** (o próprio comando `spec rejected` retorna exit 2 e publica `abort` na issue na 3ª ocorrência).

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
