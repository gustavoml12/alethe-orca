# Alethe Report

A right-sidebar panel (`src/panel.tsx`) and the plugin's own worker (`src/worker.ts`). The panel asks with `plugin.request`, the worker answers with `orca.panels.handle`, and `src/protocol.ts` types both sides: `list-reports` runs a `find` for `report.html` under `~/.config/alethe/orchestrations` in an ephemeral terminal and answers with the paths it found (find order, at most 50); `open-report` runs `orca tab create --url "file://…"` in another ephemeral terminal to open one in Orca's browser tab. Every terminal the worker opens is closed again in a `finally`, even when a step fails, and a failure comes back as data (`error` on the answer), never as an exception. Orca transpiles both files when they load, so there is no build step: save and the panel or worker reloads. `orca plugin test .` runs `src/panel.test.tsx` and `src/worker.test.ts` in Node with `orca/testing`, and `orca plugin check .` renders the panel with the worker in each `src/panel.check.ts` scenario; `npx tsc -p .` type-checks against the typings `orca plugin types .` writes to `.orca/types/`. With the folder loaded, `orca plugin dev request` calls the worker as the panel does:

```sh
orca plugin dev request . list-reports
orca plugin dev request . open-report --data '{"path":"/home/you/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html"}'
```

## Develop

```sh
orca plugin validate .
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
