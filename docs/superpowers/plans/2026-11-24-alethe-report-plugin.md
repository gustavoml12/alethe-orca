# Alethe Report Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin do Orca `alethe-report` que lista os `report.html` gerados pelo skill alethe nos workspaces e abre o escolhido na aba de browser embutida do Orca, com estado vazio instrutivo.

**Architecture:** Um plugin `trusted-worker` com painel `components` (TSX): o **worker** (Node) faz a descoberta e a abertura usando apenas APIs host de capability concedida — descoberta via terminal temporário com `find` (`terminal.create` + `terminal.read` + `terminal.close`), abertura via `terminal.create` com o comando `orca tab create --url file://…` — e expõe tudo a painel via `plugin.request`/`panels.handle`. O **painel** só desenha (lista, botões, empty state) e chama o worker. Sem fs API nem API de browser no host — o terminal é a única ponte, e é a ponte que o próprio Orca concede.

**Tech Stack:** TypeScript/TSX sem build step (transpilado pelo Orca), `orca/worker` types, `orca/testing` para testes, scaffold `orca plugin create --template worker-panel`.

**Spec:** `alethe-orca/docs/superpowers/specs/2026-11-22-alethe-orca-design.md` (RF-4 + §4 linha "report.html não existe" + §5)

## Global Constraints

- Plugins importam só `orca`, `orca/*` e arquivos relativos; sem `node_modules` commitado; worker `main` é `.js/.mjs/.ts/.mts`.
- Permissões mínimas declaradas: `workspace:read`, `terminal:send`, `terminal:read` (nada mais).
- `orca-plugin.json`: `manifestVersion: 2`, `execution: "trusted-worker"`, `engines.orca: ">=1.4.259"` (precisa de `workspace.list` 1.3 / `terminal.*` 1.7 estáveis), `id: "alethe-report"`, publisher omitido.
- Todo comando `orca plugin …` usa `--json` e ramifica por `error.code` (nunca por texto).
- Gate de aprovação: **nunca** passar `--approve <fingerprint>` sem o usuário ter visto os grants e pedido exatamente isto (Task 5 para e pergunta).
- Estado vazio do painel: "Rode `/alethe report html` no terminal do projeto" (texto da spec RF-4).
- Testes: `orca plugin test` + `orca plugin check` verdes antes de qualquer load no app; suíte Plano 1 (223) intocada.
- Commits atômicos por task, mensagem exata de cada task.

## Review Focus

1. **Descoberta sem fs API** — o worker usa terminal temporário para `find`; se o `find` falhar (path inexistente, sem `find`), o handler deve retornar lista vazia com erro registrado no log, nunca exceção que trave o painel. → Task 2, teste `list-reports` com host falhando.
2. **Abertura `file://` no browser embutido** — pode ser recusado pelo Orca (URL scheme). Se recusado, fallback é `editor.open` (aba de editor) e a decisão fica registrada; nunca falhar silenciosamente. → Task 4 é sonda explícita com esse branch.
3. **Terminal temporário não pode vazar** — todo `terminal.create` de descoberta/abertura deve ser fechado com `terminal.close` (o plugin "keeps its terminals until disabled" — sem close, enche a UI). → Task 2/4, teste de que close é chamado em todos os caminhos (inclusive erro).
4. **Painel não pode crashar com worker ausente** — `plugin.request` com worker desligado/errado deve cair para o empty state com mensagem, não exceção no frame. → Task 3, teste do catch.
5. **Capabilities do manifesto têm que bater com o usado** — manifest sem `terminal:read` → `capability_denied` em runtime só descoberto no app. → Task 1 compara capabilities com o código da Task 2 (grep), Task 5 confirma no load.

---

### Task 1: Scaffold + manifesto

**Files:**
- Create: `plugin/alethe-report/` (scaffold inteiro via `orca plugin create`)
- Modify: `plugin/alethe-report/orca-plugin.json` (manifesto final)

**Interfaces:**
- Consumes: CLI Orca (`orca plugin create`, `plugin validate`, `plugin types`).
- Produces: plugin scaffold validado (`plugin validate` exit 0) com `execution: trusted-worker`, painel `panels` entry `.tsx` com `"ui": "components"`, capabilities `workspace:read`/`terminal:send`/`terminal:read`, `engines.orca >=1.4.259`.

- [ ] **Step 1: Criar o scaffold**

```bash
cd /Users/gustavomartinslima/Documents/Projetos_ebnez/alethe-orca
orca plugin create plugin/alethe-report --template worker-panel --id alethe-report --name "Alethe Report" --json
```

Expected: `ok: true`. Se exit 3 (`approval_required`), anotar o fingerprint e **parar** — reportar NEEDS_CONTEXT ao controller (o template não deve pedir approval para create; se pedir, é sinal de algo errado).

- [ ] **Step 2: Inspecionar o scaffold gerado**

Ler todos os arquivos gerados (`ls -R plugin/alethe-report` + leitura dos principais: `orca-plugin.json`, `src/main.*`, `src/panel.*`, `tsconfig.json`, `*.test.*`). Anotar no report: nomes exatos de entry do worker e do painel, assinatura do `activate`, como o scaffold registra handlers. **Esses nomes são o contrato para as Tasks 2–3 — não invente, use os do scaffold.**

- [ ] **Step 3: Escrever o manifesto final**

Substituir `plugin/alethe-report/orca-plugin.json` por (preservando campos que o scaffold já preencheu corretamente e que não estão aqui):

```json
{
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "alethe-report",
  "name": "Alethe Report",
  "version": "0.1.0",
  "description": "Lista os relatórios /alethe report html e abre na aba de browser embutida do Orca.",
  "engines": { "orca": ">=1.4.259" },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "terminal:send" },
    { "kind": "terminal:read" }
  ],
  "main": "<entry do worker gerado no scaffold>",
  "panels": [
    {
      "id": "reports",
      "title": "Alethe Reports",
      "icon": "file-text",
      "entry": "<entry .tsx do painel gerado no scaffold>",
      "ui": "components"
    }
  ]
}
```

(Se o scaffold usa `contributes.panels` em vez de `panels`, seguir a chave que `plugin validate` aceitar — o validador é autoridade; registrar a forma final no report.)

- [ ] **Step 4: Types + validação**

```bash
orca plugin types plugin/alethe-report --json
orca plugin validate plugin/alethe-report --json
```

Expected: validate `ok: true` / exit 0. Iterar até passar (mensagem do validador é autoridade).

- [ ] **Step 5: Commit**

```bash
git add plugin/alethe-report
git commit -m "feat(plugin): scaffold do alethe-report com manifesto trusted-worker"
```

---

### Task 2: Worker — descoberta e abertura dos relatórios

**Files:**
- Modify: `plugin/alethe-report/<entry do worker>` (scaffold)
- Modify/Create: `plugin/alethe-report/<módulo lógico relativo>` (se o scaffold separar; preferir um `reports.ts` irmão para testabilidade)
- Test: `plugin/alethe-report/<arquivo .test.ts do worker>` (scaffold já tem um — estender)

**Interfaces:**
- Consumes: APIs host `workspace.list` (`workspace:read`), `terminal.create`/`terminal.read`/`terminal.close` (`terminal:send`/`terminal:read`), `panels.handle`/`plugin.request` (contrato do scaffold).
- Produces (handlers registrados no worker, chamados pelo painel via `plugin.request`):
  - `list-reports` → `{ reports: Array<{ path: string, mtimeMs: number, size: number }>, error?: string }` — mais recentes primeiro, máx. 50.
  - `open-report` → `{ opened: boolean, via: "browser-tab" | "editor-tab" | "none", error?: string }` — recebe `{ path: string }`.
  - Funções puras exportadas p/ teste: `parseFindOutput(text: string)`, `isReportPath(p: string)`.

- [ ] **Step 1: Escrever os testes falhando**

No arquivo de teste do worker — API real do kit (`orca skills get orca-plugin-authoring --reference references/testing.md`): `describe`/`test` são re-exports do `node:test`, asserções via `node:assert` (**não existe `expect`/`it`**):

```ts
import { describe, test } from "orca/testing";
import assert from "node:assert";
import { parseFindOutput, isReportPath } from "./reports";

describe("parseFindOutput", () => {
  test("keeps only report.html paths, order preserved", () => {
    const text = [
      "/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html",
      "/home/u/.config/alethe/orchestrations/2026-11-24-1/not-report.txt",
      "",
    ].join("\n");
    assert.deepEqual(parseFindOutput(text), [
      "/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html",
    ]);
  });

  test("returns [] on empty output", () => {
    assert.deepEqual(parseFindOutput(""), []);
  });
});

describe("isReportPath", () => {
  test("accepts report.html anywhere, rejects other names", () => {
    assert.equal(isReportPath("/a/b/report.html"), true);
    assert.equal(isReportPath("/a/b/report.htmlx"), false);
    assert.equal(isReportPath("/a/b/Report.html"), false);
  });
});
```

(Caminho do import `./reports` conforme a estrutura real da Task 1 — se o scaffold não separa módulos, colocar as funções puras no próprio worker e importar de lá.)

(Assinaturas `parseFindOutput`/`isReportPath` podem precisar de ajuste ao padrão de export do scaffold — o comportamento dos asserts é o contrato.)

- [ ] **Step 2: Rodar para confirmar falha**

```bash
orca plugin test plugin/alethe-report --json
```

Expected: exit ≠ 0 com falha de import/símbolo (módulo não existe).

- [ ] **Step 3: Implementar `reports.ts` (lógica pura + orquestração com host injetado)**

```ts
export type Host = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export function isReportPath(p: string): boolean {
  return p.endsWith("/report.html");
}

export function parseFindOutput(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(isReportPath);
}

const ORCHESTRATIONS = "~/.config/alethe/orchestrations";

export async function listReports(host: Host): Promise<{
  reports: Array<{ path: string }>;
  error?: string;
}> {
  let terminalId: string | undefined;
  try {
    const ctx = (await host.call("workspace.readContext", {})) as { workspaceId?: string } | null;
    const workspaceId = ctx?.workspaceId;
    if (!workspaceId) return { reports: [], error: "nenhum workspace focado" };
    const created = (await host.call("terminal.create", {
      workspaceId,
      title: "alethe-report: find",
      command: `find ${ORCHESTRATIONS} -name report.html -type f 2>/dev/null`,
    })) as { terminalId: string };
    terminalId = created.terminalId;
    await new Promise((r) => setTimeout(r, 1500)); // find curto; ver Task 2 Step 6 p/ robustez
    const read = (await host.call("terminal.read", {
      terminalId,
      maxLines: 500,
    })) as { lines: string[] };
    const paths = parseFindOutput(read.lines.join("\n")).slice(0, 50);
    return { reports: paths.map((path) => ({ path })) };
  } catch (err) {
    return { reports: [], error: String(err) };
  } finally {
    if (terminalId) {
      try {
        await host.call("terminal.close", { terminalId });
      } catch {
        /* best effort */
      }
    }
  }
}

export async function openReport(
  host: Host,
  path: string
): Promise<{ opened: boolean; via: "browser-tab" | "editor-tab" | "none"; error?: string }> {
  let terminalId: string | undefined;
  try {
    const ctx = (await host.call("workspace.readContext", {})) as { workspaceId?: string } | null;
    const workspaceId = ctx?.workspaceId;
    if (!workspaceId) return { opened: false, via: "none", error: "nenhum workspace focado" };
    const created = (await host.call("terminal.create", {
      workspaceId,
      title: "alethe-report: open",
      command: `orca tab create --url "file://${path}"`,
    })) as { terminalId: string };
    terminalId = created.terminalId;
    await new Promise((r) => setTimeout(r, 1200));
    const read = (await host.call("terminal.read", {
      terminalId,
      maxLines: 50,
    })) as { lines: string[] };
    const out = read.lines.join("\n");
    if (/error|refused|invalid/i.test(out)) {
      // fallback: aba de editor (Task 4 valida se o browser aceita file://)
      await host.call("editor.open", { workspaceId, path });
      return { opened: true, via: "editor-tab" };
    }
    return { opened: true, via: "browser-tab" };
  } catch (err) {
    return { opened: false, via: "none", error: String(err) };
  } finally {
    if (terminalId) {
      try {
        await host.call("terminal.close", { terminalId });
      } catch {
        /* best effort */
      }
    }
  }
}
```

(Ajustar `host.call` para a forma real do scaffold — se o scaffold expõe `orca.host.call`, usar isso; o contrato é: mesma lógica, host injetável, `finally` fecha terminal em TODOS os caminhos.)

- [ ] **Step 4: Rodar testes da lógica pura**

```bash
orca plugin test plugin/alethe-report --json
```

Expected: exit 0.

- [ ] **Step 5: Registrar os handlers no worker**

No `main` do scaffold, seguir o padrão que o scaffold/`references/host-api.md` indicam para `orca.panels.handle(nome, handler)`:

```ts
export function activate(orca: OrcaWorkerApi) {
  const host = { call: (m: string, p: Record<string, unknown>) => orca.host.call(m, p as never) };
  orca.panels.handle("list-reports", () => listReports(host));
  orca.panels.handle("open-report", (input) =>
    openReport(host, String((input as { path?: string })?.path ?? ""))
  );
  orca.log("alethe-report worker ativo");
}
```

(Assinatura exata conforme o scaffold da Task 1 — se `panels.handle` não for o nome real, usar o que o scaffold documenta e registrar no report.)

- [ ] **Step 6: Teste de falha do host (Review Focus 1), de close (Focus 3) e do wiring dos handlers (Focus 5)**

O kit tem `mountWorker(module, { capabilities })` (chama o `activate` real com um `mockHost`) e `tw.request(name)` responde pelo `orca.panels.handle` — e o `mockHost` **recusa calls sem a capability do manifesto**, o que testa a paridade manifesto×código offline:

```ts
import { describe, test, mountWorker } from "orca/testing";
import assert from "node:assert";
import * as worker from "./main"; // entry do worker conforme scaffold

describe("list-reports handler", () => {
  test("finds report.html through the host and closes its terminal", async () => {
    const tw = await mountWorker(worker, {
      capabilities: ["workspace:read", "terminal:send", "terminal:read"],
    });
    tw.host.respond("workspace.readContext", { workspaceId: "w1" });
    tw.host.respond("terminal.create", { terminalId: "t1" });
    tw.host.respond("terminal.read", { lines: ["/x/report.html", "/x/other.txt"] });
    tw.host.respond("terminal.close", {});
    const res = (await tw.request("list-reports")) as { reports: Array<{ path: string }> };
    assert.deepEqual(res.reports, [{ path: "/x/report.html" }]);
    assert.equal(tw.host.callsOf("terminal.close").length, 1);
    await tw.deactivate();
  });

  test("refuses (capability_denied) when the manifest lacks terminal:read", async () => {
    const tw = await mountWorker(worker, { capabilities: ["workspace:read"] });
    tw.host.respond("workspace.readContext", { workspaceId: "w1" });
    tw.host.respond("terminal.create", { terminalId: "t1" });
    const res = (await tw.request("list-reports")) as { reports: unknown[]; error?: string };
    assert.deepEqual(res.reports, []);
    assert.ok(res.error, "erro propagado como resposta, não como exceção");
    await tw.deactivate();
  });
});
```

Mais os dois testes puros de falha/finally (host que rejeita → `{reports: [], error}`; read falha → `terminal.close` ainda chamado), com o host injetável à mão:

```ts
test("listReports returns empty + error when host.call rejects", async () => {
  const host = { call: async () => { throw new Error("boom"); } };
  const res = await listReports(host);
  assert.deepEqual(res.reports, []);
  assert.match(res.error ?? "", /boom/);
});

test("listReports closes the terminal even when read fails", async () => {
  const calls: string[] = [];
  const host = {
    call: async (m: string) => {
      calls.push(m);
      if (m === "workspace.readContext") return { workspaceId: "w1" };
      if (m === "terminal.create") return { terminalId: "t1" };
      if (m === "terminal.read") throw new Error("read failed");
      return {};
    },
  };
  await listReports(host);
  assert.ok(calls.includes("terminal.close"));
});
```

Rodar `orca plugin test plugin/alethe-report --json` → exit 0.

Nota de robustez (não bloqueia): o `setTimeout` fixo é aceitável para `find` local; se na Task 5 ao vivo o output vier vazio, trocar por poll de `terminal.read` até a linha aparecer ou 5s — registrar no report qual foi a escolha final.

- [ ] **Step 7: Commit**

```bash
git add plugin/alethe-report
git commit -m "feat(plugin): worker lista e abre report.html com terminal efêmero"
```

---

### Task 3: Painel TSX — lista, botões, empty state

**Files:**
- Modify: `plugin/alethe-report/<entry .tsx do painel>` (scaffold)
- Test: `plugin/alethe-report/<.test.tsx do painel>` (estender)

**Interfaces:**
- Consumes: `host.plugin.request("list-reports" | "open-report", …)` do frame (API `plugin.request`, sem capability) — contrato da Task 2.
- Produces: painel com estados `loading | ready(list) | empty | error(msg)`; botão "Abrir" por item; botão "Recarregar"; empty state com o texto exato da spec: "Rode `/alethe report html` no terminal do projeto".

- [ ] **Step 1: Teste do painel falhando**

API real do kit: `mount(import("./panel"))` → `TestPanel` (`find/findAll/press/summary/errors`). Para testar a lógica, o painel exporta sua função de carga com a request injetável:

```ts
import { describe, test, mount } from "orca/testing";
import assert from "node:assert";
import { load } from "./panel"; // export nomeado da função de carga

describe("load (lógica)", () => {
  test("empty list → estado vazio com a instrução da spec", async () => {
    const state = await load(async () => ({ reports: [] }));
    assert.equal(state.kind, "empty");
    assert.match(state.instruction ?? "", /Rode `\/alethe report html` no terminal do projeto/);
  });

  test("worker request failure → estado de erro amigável, nunca exceção (Focus 4)", async () => {
    const state = await load(async () => { throw new Error("worker off"); });
    assert.equal(state.kind, "error");
    assert.match(state.message ?? "", /worker off/);
  });

  test("list with items → rows com path", async () => {
    const state = await load(async () => ({ reports: [{ path: "/x/report.html" }] }));
    assert.equal(state.kind, "ready");
    assert.deepEqual(state.reports, [{ path: "/x/report.html" }]);
  });
});

describe("panel render", () => {
  test("draws the empty-state instruction when mounted with no reports", async () => {
    const panel = await mount(import("./panel"), {
      /* injetar load com lista vazia conforme MountOptions em .orca/types */
    });
    assert.ok(panel.find({ text: /alethe report html/ }), "instrução visível");
    assert.deepEqual(panel.errors, []);
    await panel.unmount();
  });
});
```

(O mecanismo exato de injeção no `mount` vem de `MountOptions` em `.orca/types` — ler antes de escrever; se não houver injeção, o caso de render usa o `plugin.request` real com o worker do scaffold ativo. Os três comportamentos de `load` são o contrato.)

- [ ] **Step 2: Rodar para confirmar falha**

```bash
orca plugin test plugin/alethe-report --json
```

Expected: exit ≠ 0.

- [ ] **Step 3: Implementar o painel**

Estilo com as CSS variables do tema (`--orca-background`, `--orca-card`, `--orca-muted`, `--orca-foreground`, `--orca-radius`) — nunca cores fixas. Estrutura:

- `useEffect` no mount → `plugin.request("list-reports")` → estado.
- Loading: "Carregando relatórios…".
- Ready: lista ordenada (worker já ordena), cada row: nome do arquivo (`report.html` + pasta), botão "Abrir" → `plugin.request("open-report", { path })` → feedback inline ("aberto na aba" / erro).
- Empty: **"Rode `/alethe report html` no terminal do projeto"** + botão "Recarregar".
- Error (Focus 4): catch no `plugin.request` → mesma UI do empty + linha de erro em `--orca-destructive`.
- Botão "Recarregar" sempre visível.

- [ ] **Step 4: Rodar testes + typecheck**

```bash
orca plugin test plugin/alethe-report --json
npx tsc -p plugin/alethe-report --noEmit 2>&1 | head -20
```

Expected: teste exit 0; tsc sem erros nos arquivos do plugin (o tsconfig estende `.orca/types` — `plugin types` já rodou na Task 1).

- [ ] **Step 5: Check offline (renderiza o painel sem app)**

```bash
orca plugin check plugin/alethe-report --json
```

Expected: exit 0, sem erros de runtime no render. Se acusar erro de frame, corrigir e repetir.

- [ ] **Step 6: Commit**

```bash
git add plugin/alethe-report
git commit -m "feat(plugin): painel de lista com empty state e tratamento de falha do worker"
```

---

### Task 4: Sonda `file://` no browser embutido + fallback decidido

**Files:**
- Modify: `plugin/alethe-report/reports.ts` (apenas se a sonda ditar fallback)
- Modify: `plugin/alethe-report/README.md` (novo — registro da decisão)

**Interfaces:**
- Consumes: CLI do Orca com app rodando (`orca status`), `orca tab create`.
- Produces: decisão registrada em `README.md` — `file://` funciona (browser embutido, caminho da spec) OU cai para `editor.open` (aba de editor) com o porquê; código coerente com a decisão; teste do caminho de fallback verde.

- [ ] **Step 1: Sonda direta (sem plugin)**

```bash
orca status --json   # app precisa estar rodando; se não, orca open (só se o usuário pediu ou status diz que não roda)
echo '<html><body><h1>probe</h1></body></html>' > /tmp/alethe-probe.html
orca tab create --url "file:///tmp/alethe-probe.html" --json
```

Expected: tab abre renderizando "probe". Se recusar (`invalid`, `refused`, erro de scheme): anotar o erro EXATO no report e seguir para Step 2.

- [ ] **Step 2: Se recusado — fallback que RENDERIZA (não mostra código-fonte)**

`editor.open` puro abriria o HTML como texto na aba Source — não é o "fiel ao HTML" da RF-4. Nesse caso, adicionar uma **custom editor** de renderização:

1. Manifesto: `contributes.customEditors` com `id: "alethe-report-html"`, `filenames: ["report.html"]` (nome exato — só relatórios do alethe têm esse nome), `entry` = HTML novo `render.html`, `priority: "default"`, `frame: "isolated"`, `contentKind: "text"`.
2. `render.html` recebe o documento (API `document.session()`/`document.get()` — ver `references/host-api.md`, seção Custom editor) e renderiza fielmente dentro de um `<iframe sandbox srcdoc="…">` — o HTML original do relatório aparece como a página é, sem re-renderizar por fora.
3. `openReport` mantém: tenta browser (`file://`); no erro cai para `editor.open` — que agora aterrissa na nossa custom editor (Orca escolhe editor default pelo filename) → `via: "editor-tab"`.
4. Teste do caminho de fallback: `openReport` com host que falha no `orca tab create` deve chamar `editor.open` e retornar `via: "editor-tab"`; `orca plugin validate` precisa passar com o `customEditors` novo.

Se a custom editor não convencer (validate/teste não passarem), o piso é `editor.open` puro com `via: "editor-tab"` e o README registrando a degradação — decidir na hora e justificar no report.

- [ ] **Step 3: Registrar a decisão**

Criar `plugin/alethe-report/README.md`:

```markdown
# alethe-report

Abre os relatórios do `/alethe report html` dentro do Orca.

## Decisão de abertura (Task 4, <data>)
- Sonda: `orca tab create --url file://…` → <resultado com o texto do erro ou sucesso>
- Comportamento: <browser-tab | editor-tab> (`via` no retorno de `open-report`)
- Motivo: <…>
```

- [ ] **Step 4: Rodar testes + check**

```bash
orca plugin test plugin/alethe-report --json
orca plugin check plugin/alethe-report --json
```

Expected: exit 0 nos dois.

- [ ] **Step 5: Commit**

```bash
git add plugin/alethe-report
git commit -m "feat(plugin): sonda file:// decidida e registrada no README"
```

---

### Task 5: Load no app (GATE DE APROVAÇÃO DO USUÁRIO) + verificação ao vivo

**Files:**
- Modify: nada de código (só verificação); `plugin/alethe-report/README.md` ganha a seção de instalação.

**Interfaces:**
- Consumes: `orca plugin dev load` (exit 3 `approval_required` com fingerprint), `orca plugin shot`, `orca plugin logs`.
- Produze: plugin carregado e aprovado pelo usuário; screenshot do painel lido e verificado; instalação documentada.

- [ ] **Step 1: Dev load — e PARAR para o usuário**

```bash
orca plugin dev load plugin/alethe-report --json
```

Expected: exit 3, `approval_required`, `error.data.command` com `--approve <fingerprint>` e a lista de grants.

**PARAR AQUI.** Mostrar ao usuário: o fingerprint, os grants exatos (capabilities + painel + worker) e a fonte (pasta local deste repo). **Só após o usuário pedir explicitamente** para aprovar, rodar o comando com `--approve <fingerprint>` exatamente como o Orca imprimiu. Se o usuário não aprovar, reportar DONE_WITH_CONCERNS com o estado (código pronto, não carregado).

- [ ] **Step 2: Abrir o painel e capturar**

```bash
orca plugin open alethe.report --panel reports --json   # id do plugin key conforme plugin list
orca plugin shot alethe.report --panel reports --json
```

Ler o PNG gerado (`.orca/shots/…`) e conferir visualmente: lista ou empty state correto, sem erro no frame.

- [ ] **Step 3: Teste ao vivo do fluxo completo**

1. Sem relatório: painel mostra o empty state com a instrução.
2. Gerar um relatório real (num projeto com o skill Plano 1: `orchestrate.py report --format html` numa pasta de orquestração existente, ou criar um `report.html` de mentira em `~/.config/alethe/orchestrations/<stamp>/x/report.html` para o find achar).
3. "Recarregar" → item aparece → "Abrir" → tab de browser/abre o esperado (conforme decisão da Task 4).
4. `orca plugin logs alethe.report --json` → sem erros `[frame]`.

- [ ] **Step 4: Instalação documentada no README**

Acrescentar:

```markdown
## Instalar
orca plugin install <caminho>/plugin/alethe-report --json   # exit 3 → approve conforme pedido
# ou, para desenvolvimento:
orca plugin dev load <caminho>/plugin/alethe-report --json
```

- [ ] **Step 5: Commit**

```bash
git add plugin/alethe-report
git commit -m "docs(plugin): instalação do alethe-report e registro do load aprovado"
```

---

## Fora do escopo deste plano (Planos 3 e 4)

- Plugin `nds-onboarding` (Plano 3).
- `install.sh`, template da issue GitLab, `PROCESSO.md`, `ONBOARDING.md`, E2E manual dos 4 projetos (Plano 4).
- Publicação em catálogo do Orca (spec: fora de escopo).
