# Alethe Report

A right-sidebar panel (`src/panel.tsx`) and the plugin's own worker (`src/worker.ts`). The panel asks with `plugin.request`, the worker answers with `orca.panels.handle`, and `src/protocol.ts` types both sides: `list-reports` runs a `find` for `report.html` under `~/.config/alethe/orchestrations` in an ephemeral terminal and answers with the paths it found (newest first, at most 50); `open-report` runs `orca tab create --url 'file://…' --json` (path shell-quoted) in another ephemeral terminal to open one in Orca's browser tab; `setup-report` is the one-click flow — one terminal checks whether `~/.agents/skills/alethe` is installed, clones the repo (credentials from the machine's own git/gh config) when it is missing, another terminal finds the newest orchestration folder with a run, and a third renders `report.html` next to it; `start-task` takes the text of the panel's **Qual tarefa?** field and opens a live agent terminal running `opencode run '<kickoff>'` — the alethe skill, the NDS runbook and the task itself — which is the frictionless path for starting work without touching a shell. The panel's **⚙️ Preparar e gerar relatório** button (empty state, and beside `Recarregar` when a list is shown) runs that flow in one click: it installs the alethe if it is missing and generates the report, then opens it in the embedded browser and refreshes the list; when there are no tasks yet it says so, and the panel's **Qual tarefa?** field plus its **🚀 Orquestrar tarefa** button (below) is the frictionless way to start one. Every ephemeral terminal the worker opens is closed again in a `finally`, even when a step fails — the agent terminal that `start-task` opens is the single exception, because it is the live session the person watches while the waves run — and a failure comes back as data (`error` on the answer), never as an exception. The panel draws one of four states: `Carregando relatórios…` while the worker has not answered; the list, one row per report with its name (`wave-2/report.html`), the folder chain above it and an `Abrir` button whose inline feedback says how the report opened or why it could not; the empty state, whose instruction reads ``Sem relatórios ainda — escreva a tarefa acima e clique em 🚀 Orquestrar tarefa.`` — no shell hint anywhere: `/alethe` belongs to an agent conversation (see "`/alethe` não é comando de shell" below) — and which also draws the **Qual tarefa?** field with the **🚀 Orquestrar tarefa** button; and, on any worker failure (a rejected request or the worker's own `error`), that same empty UI plus an error line in the destructive tone — a failure is always data in the frame, never a thrown exception. `Recarregar` sits in the header in every state and re-runs the list request. Orca transpiles both files when they load, so there is no build step: save and the panel or worker reloads. `orca plugin test .` runs `src/panel.test.tsx` and `src/worker.test.ts` in Node with `orca/testing`, and `orca plugin check .` renders the panel with the worker in each `src/panel.check.ts` scenario; `npx tsc -p .` type-checks against the typings `orca plugin types .` writes to `.orca/types/`. With the folder loaded, `orca plugin dev request` calls the worker as the panel does:

```sh
orca plugin dev request . list-reports
orca plugin dev request . open-report --data '{"path":"/home/you/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html"}'
orca plugin dev request . setup-report
orca plugin dev request . start-task --data '{"task":"escrever o plano de testes"}'
```

## `/alethe` não é comando de shell

`/alethe` é um comando de conversa com o agente: ele se digita **dentro de um chat de agente** (o terminal de agente do Orca, o `opencode`, etc.), nunca no shell. Digitado no zsh/bash ele responde `no such file or directory`, porque a shell procura um arquivo chamado `/alethe` — o erro não é do alethe, é do lugar onde foi digitado.

O caminho sem atrito, que não exige tocar em shell nenhum, é o do painel: escreva a tarefa no campo **Qual tarefa?** e clique em **🚀 Orquestrar tarefa** (estado vazio; o botão fica desabilitado enquanto o campo estiver vazio). O worker roda `start-task`, que (1) recusa campo vazio antes de qualquer chamada ao host, (2) garante que o skill alethe está instalado — o mesmo check/instalação do **⚙️ Preparar e gerar relatório**, pelo `ensureAlethe` compartilhado —, (3) lê o workspace focado e (4) abre um terminal de agente com o kickoff:

```sh
opencode run 'Use a skill alethe para orquestrar a tarefa seguindo o runbook NDS em ~/.agents/skills/alethe/references/nds-runbook.md. TAREFA: <sua tarefa>'
```

Esse terminal **não** é fechado: é a sessão viva que você acompanha enquanto as waves rodam (todos os outros terminais do worker são efêmeros e fechados num `finally`), e o relatório aparece no painel quando elas concluírem. A tarefa inteira passa pelo `shellQuote`, então `"`, `$()` e backticks dentro do texto viram dados, nunca sintaxe de shell. Falhas voltam como nota inline no painel (campo vazio, clone recusado, nenhum workspace focado) — nunca como exceção no frame.

## Decisão de abertura (Task 4, 2026-11-24)

- Sonda: `orca tab create --url "file:///tmp/alethe-probe.html" --json` → **abriu e carregou**: `{"ok": true, "result": {"browserPageId": "8fc35093-5acd-48bc-b17a-8af632c9cdea"}}`; conferido com `orca tab show --page <id>` e `orca tab list` → `url: "file:///tmp/alethe-probe.html"`, `title: "alethe-probe.html"`, `loaded: true`, `loadError: null`. O mesmo comando, executado de um terminal efêmero no workspace exatamente como o worker o faz (sem `--worktree`), também carregou a página (`loaded: true`, `loadError: null`).
- Comportamento: `browser-tab` (`via` no retorno de `open-report`)
- Motivo: o browser embutido do Orca aceita o scheme `file://` e renderiza a página (`loaded: true`, `loadError: null`), então o caminho da spec — aba de browser — é o que o código já faz: nenhum fallback foi necessário, `openReport` segue **sem** `editor.open` e uma falha do terminal continua respondendo `via: "none"` com o `error` lido. Fora de um terminal do Orca o mesmo comando recusou com `selector_ambiguous` (`More than one Orca workspace matched the current directory. Choose an exact workspace.` — 6 folder workspaces duplicados no cwd `Projetos_ebnez`): é resolução de workspace, não recusa do scheme; dentro do terminal do Orca, onde o worker roda, o contexto resolve sozinho.

## Instalar

```bash
orca plugin install ./plugin/alethe-report --json   # exit 3 → approval_required: re-run com o --approve que o Orca imprimir
# desenvolvimento:
orca plugin dev load ./plugin/alethe-report --json
```

## Develop

```sh
orca plugin validate .
orca plugin types .    # writes .orca/types/ (gitignored) — required before tsc on a fresh clone
npx tsc -p .           # type-checks against the typings the step above wrote
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
