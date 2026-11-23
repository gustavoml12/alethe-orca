# Spec: NDS Standard — alethe-orca (processo padronizado + plugins Orca)

- **Data:** 2026-11-22
- **Status:** rascunho para aprovação
- **Solicitante:** NDS — Núcleo de Desenvolvimento de Software
- **Contexto de distribuição:** 32 estagiários, 4 projetos distintos

---

## 1. Contexto & Propósito (Why & Where)

Hoje o NDS padroniza o fluxo de desenvolvimento multi-agente apenas com a skill
`orca-superpowers-handoff` (`.agents/skills/`), que orquestra Opencode → Claude Opus →
AGY via abas de terminal do Orca. Problemas observados na auditoria desta skill:

- Sem mecanismo definido de read-back entre etapas (o fluxo pode travar entre validador e gate).
- Sem estado persistente: o andamento vive só em abas de terminal (restart do Orca perde tudo).
- Prompts longos embutidos em `--command` (frágil quanto a aspas/acentos/limite de shell).
- `agy --dangerously-skip-permissions` contradiz as red flags do próprio processo.
- Loop de reprovação spec × validador sem teto; IDs de modelo hardcoded; sem timeout por etapa.

Solução escolhida: adotar o **alethe-orchestrate-skill** (MIT, standalone) como orquestrador
padrão do NDS, com um **fork mínimo** no repo central **`alethe-orca/`**, e distribuir o
processo aos 4 projetos via **dois plugins do Orca** e um bootstrap único. A issue do
**GitLab work item** vira o gatilho e a fonte de verdade do fluxo, aparecendo no painel
Tarefas do Orca; o NDS (núcleo) mantém o padrão no repo central e os estagiários consomem.

**Resultado esperado:** qualquer estagiário dos 4 projetos, numa máquina nova, fica
operacional em ~10 minutos com o mesmo processo, visível e auditável pela issue GitLab
(marcos + modelos + tokens), com relatório HTML aberto no browser embutido do Orca.

---

## 2. Requisitos Funcionais & Comportamento (What)

### RF-1 — Fork do `alethe-orchestrate-skill` com gate humano nativo

- Clonar o upstream (`Kc1t/alethe-orchestrate-skill`, MIT) para `skill/` em `alethe-orca/`,
  preservando `LICENSE`/atribuição.
- Delta mínimo, todo listado em `FORK-DELTA.md`:
  - **Gate nativo:** wave com `gate: human` para o runner Python de vez; emite prompt de
    aprovação no terminal e só continua com resposta explícita (`sim`/`aprovado`). Recusa
    aborta o pipeline antes do executor e dispara write-back de aborto na issue.
  - **Write-back GitLab:** em cada marco (fim de wave, gate aguardando, aborto, resultado
    final) publica comentário na issue via `glab issue note` contendo status + tabela
    `Etapa | Modelo/Executor | Tokens | Custo` (dados reais do journal/report do alethe).
  - **Teto de reprovação:** no máximo **2 voltas** ao planner pela validação; estourou →
    aborta com comentário na issue explicando.
  - **Timeout por wave** configurável (defaults: planner 30 min, validador 15 min,
    executor 45 min, reviewer 30 min); estourou → marca wave como falha na issue.
  - **Config de modelos** no topo da playbook (`planner.model`, `validator.model`,
    `executor.model`, `reviewer.model`) — nada hardcoded nos comandos.
  - **Playbook embutida:** `handoff-spec-review.yaml` (ver RF-2) + a matriz das 5
    categorias como `references/` do skill.
- Sync com upstream: remote `upstream` configurado; `FORK-DELTA.md` lista os arquivos
  tocados para viabilizar merges futuros.

### RF-2 — Playbook `handoff-spec-review` (tradução da skill atual)

Waves, na ordem:

| Wave | Papel (padrão NDS) | Ação | Superpowers |
|---|---|---|---|
| 1 | Planner — Opencode (modelo gratuito) | grava spec + plano em `docs/superpowers/specs/` e `docs/superpowers/plans/` | `brainstorming` + `writing-plans` |
| 2 | Validador — Claude Opus | audita as **5 categorias** com a matriz anti-"cumprir tabela"; reprova devolve à wave 1 (máx. 2) | matriz da skill |
| ⛔ gate | **humano, nativo no runner** | pausa obrigatória; sem aprovação não há executor | — |
| 3 | Executor — AGY/Gemini | TDD estrito, commits atômicos, marca checkboxes `[x]` no plano | `executing-plans` |
| 4 | Reviewer — Claude Opus | roda a **suíte real de testes**, lint, diff × spec; grava review em `docs/superpowers/reviews/` | `requesting-code-review` + `verification-before-completion` |

Regras preservadas da skill original:

- **Mesmo worktree sempre** (`--worktree active`); proibido criar worktrees secundários.
- Executor **não** usa `--dangerously-skip-permissions`; vale a worker safety do alethe
  (cwd confinado, env sanitizado, git hooks off).
- Gate humano é inegociável (red flag nº 1 original).
- Review final exige execução real da suíte de testes — nunca só leitura de código.
- Template do review mantém `Strengths / Issues (Critical|Important|Minor) / Recommendations / Assessment`.

### RF-3 — Gatilho via issue GitLab (work item → Tarefas do Orca)

- Template de issue do NDS contém: checklist automático do fluxo (spec ✓ validação ✓ gate ✓
  execução ✓ review ✓), o **comando de kickoff** da versão atual do padrão e a orientação
  de acompanhar pelo painel Tarefas.
- Vinculação ao workspace: `orca reference add <issue-url> --worktree active` (faz a work
  item aparecer no painel Tarefas do Orca).
- Write-back: todos os marcos viram comentário na issue (RF-1), incluindo a tabela de
  modelos/tokens por etapa — quem acompanha pelo work item vê o estado sem abrir o Orca.
- O template é gerado/versado pelo plugin de onboarding (RF-5) e documentado em
  `docs/ONBOARDING.md`.

### RF-4 — Plugin Orca `alethe-report`

- Um painel no Orca que:
  1. Lista os `report.html` gerados pelo alethe nos workspaces (varredura nos diretórios
     de execução/relatório do skill);
  2. Abre o escolhido na **aba de browser embutida** do Orca (`orca tab create --url
     file://…`), sem re-renderizar (fiel ao HTML do skill);
  3. Estado vazio com instrução: "rode `/alethe report html` no terminal do projeto".
- Permissões mínimas declaradas no manifest (ler arquivos do workspace + abrir tab).
- Qualidade: `orca plugin check` + `orca plugin test` no CI.

### RF-5 — Plugin Orca `nds-onboarding`

- Painel/wizard de entrada do estagiário que:
  1. **Valida a máquina:** `glab` instalado e autenticado; CLIs `opencode`, `claude`, `agy`
     presentes e logados; Python ≥ 3.9; `npx`/Node disponíveis — status verde/vermelho por
     item;
  2. **Executa setup** (com aprovação do Orca por fingerprint, como o modelo exige):
     instalar CLIs que faltam (via instaladores oficiais que o próprio Orca/alethe já
     usam como referência), autenticar GitLab (`glab auth login` guiado);
  3. **Instala as skills do fluxo NDS:** `superpowers` e `ponytail` de suas fontes
     oficiais, e o `alethe` a partir do fork central deste repo;
  4. **Passa comandos e orientações:** copiar o template da issue GitLab, comando de
     kickoff, checklist do processo (`docs/PROCESSO.md`);
  5. Mostra versão do padrão instalada × versão oficial no repo central (drift do padrão).
- Permissões declaradas explicitamente; qualquer coisa fora do manifesto é recusada pelo Orca.

### RF-6 — Instalação distribuída (4 projetos / 32 pessoas)

- `install.sh` (bootstrap mínimo, roda uma vez por máquina):
  1. instala o plugin `nds-onboarding` no Orca;
  2. imprime instruções para abrir o wizard;
  3. **não** instala CLIs/skills por conta própria — isso é papel do wizard (RF-5).
- O wizard conclui: skills do fluxo, `alethe-report`, e gera o template da issue.
- `docs/PROCESSO.md` — o fluxo padronizado + matriz das 5 categorias.
- `docs/ONBOARDING.md` — estagiário novo operacional em ~10 minutos.

---

## 3. Restrições Técnicas & Arquiteturais (How)

- **Licença:** upstream `alethe-orchestrate-skill` é MIT — fork permitido mantendo
  LICENSE e atribução; o app Alethe (AGPL-3.0) **não** é fonte de código para este projeto.
- **Runner:** Python stdlib (≥3.9), sem shell, sem rede — preservar essa restrição do
  upstream também no fork; write-back GitLab usa `glab` como processo separado.
- **Orca:** plugins em TypeScript com scaffold via `orca plugin create`, usando a API de
  plugins do Orca (painéis, command palette, abas de browser embutido). Código de plugin
  só roda após aprovação por fingerprint (modelo de confiança do Orca).
- **GitLab:** única integração de escrita é via `glab` CLI (a CLI do Orca só expõe vínculo
  `--gitlab-issue`/`reference add`, não comentários); `glab` já instalado (v1.128.0).
- **Mesmo worktree:** pipeline roda no workspace/branch ativos; sem worktrees secundários.
- **Modelos:** IDs no bloco de config da playbook; valores default documentados, ajustáveis
  por projeto sem tocar no fork.
- **Repo central único:** `alethe-orca/` é a fonte do padrão; os 4 projetos só instalam —
  não forkam o processo.
- **Ambiente:** macOS (dev do NDS); o processo deve funcionar também em Linux (estagiários).

---

## 4. Tratamento de Erros & Casos de Borda (Edge Cases)

| Cenário | Comportamento esperado |
|---|---|
| Gate recusado pelo usuário | aborta antes do executor; comentário "ABORTADO pelo usuário" na issue; nada é commitado |
| Gate sem resposta (timeout) | wave fica pendurada até timeout do gate (default 24h) → aborta com comentário na issue |
| Validador reprova a spec | devolve à wave 1; contador de voltas; 3ª reprovação → aborta com "spec não aprovada em 2 tentativas" na issue |
| `glab` ausente ou deslogado | pipeline **continua rodando** (gate/waves não dependem dele); write-back acumula num arquivo local `docs/superpowers/writeback-pending.md` e avisa no relatório final; wizard marca item vermelho |
| Issue GitLab inacessível (permissão/rede) | idempotente: re-tenta no marco seguinte; nunca derruba a wave |
| CLI de worker ausente (`claude`/`agy`/`opencode`) | wave correspondente falha com mensagem clara apontando o wizard de onboarding; comentário de falha na issue |
| Timeout de wave | marca wave como falha na issue com duração excedida; para o pipeline (não segue para a wave seguinte) |
| Executor tenta commitar sem teste | worker safety do alethe (read-only check via git) pega; review final reforça; red flag documentada na playbook |
| `report.html` não existe ao abrir o plugin | painel mostra estado vazio com instrução (`/alethe report html`); não é erro fatal |
| Dois pipelines na mesma branch | o alethe já serializa por orquestração; segunda issue no mesmo workspace → wizard avisa conflito |
| Restart do Orca no meio do fluxo | waves retomam pelo estado do runner em disco; a issue GitLab mantém o estado visível (marcos já escritos) |
| Orca sem plugin system habilitado | wizard e report ficam indisponíveis; `install.sh` detecta e orienta (`orca plugin system on`) |

---

## 5. Critérios de Validação & Testes (Definition of Done)

### Testes automatizados

- **Fork (pytest):**
  - gate: aprovação → segue; recusa → aborta sem executor; timeout → aborta;
  - teto de 2 voltas do validador (3ª reprovação → aborta);
  - serialização do write-back (fixture de journal → comentário formatado com tabela de
    tokens/modelos);
  - modo offline do `glab` → `writeback-pending.md` preenchido, pipeline não para.
- **Plugin `alethe-report`:** `orca plugin check` (renderiza painel sem sandbox) +
  `orca plugin test` com fixture de `report.html`;
- **Plugin `nds-onboarding`:** `orca plugin check` + testes unitários da lógica de
  detecção de CLIs (mock de PATH) e do template da issue;
- **CI no repo central:** lint + pytest + `orca plugin check` dos dois plugins.

### Testes manuais / E2E (1 passagem real)

1. Máquina limpa → `install.sh` → wizard conclui com tudo verde (CLIs, glab, skills).
2. Criar issue GitLab com template → `reference add` → aparece em Tarefas no Orca.
3. Kickoff → playbook roda → **gate pausa de verdade** (sem "sim" não há executor).
4. Aprovar → executor TDD → reviewer roda suíte real → review gravado.
5. Comentários na issue com tabela `Etapa | Modelo | Tokens | Custo` em cada marco.
6. `/alethe report html` → painel lista → abre no browser embutido.
7. Repetir o passo 2 num 2º dos 4 projetos confirmando zero drift de versão.

### Critérios de aceite

- [ ] Nenhum caminho do fluxo abre o executor sem aprovação humana registrada (teste de portão automático no pytest).
- [ ] Toda wave concluída/abortada tem comentário correspondente na issue (ou em `writeback-pending.md`).
- [ ] Tabela de tokens/modelos presente em ≥ 90% dos marcos (falhas de rede do GitLab são o esperado escape).
- [ ] Os 4 projetos instalam a mesma versão do padrão e o wizard reporta "sem drift".
- [ ] Auditoria da spec original: todos os 7 problemas listados na auditoria marcados como resolvidos em `FORK-DELTA.md`.

---

## Fora de escopo (YAGNI)

- Publicar os plugins no catálogo oficial do Orca (instalação local via `install.sh` basta).
- Portar MCP tab / Skills tab / orchestration board do app Alethe.
- Modificar o app Alethe ou o runner além do delta listado em RF-1.
- Multi-host/SSH: processo assume máquina local do estagiário.
