# pi-extensions

Extensions for [pi](https://npmjs.com/package/@earendil-works/pi-coding-agent), installable as one package:

| Extension | What it does |
|---|---|
| **background-jobs** (`bg_run` / `bg_wait` / `bg_logs` / `bg_list` / `bg_kill`, `/bg`) | First-class background jobs for agents: start long commands detached, get job ids + logs, bounded waits that treat timeouts as *not an error*, whole-process-tree kills, and **automatic completion notifications** injected into the conversation (exit code + tail), with restart re-attach via pid probe + exit-code sentinels. |
| **beads** | Injects `bd prime` workflow context on session start (deduped, re-armed after compaction) — the pi equivalent of the Claude Code / Codex hooks a bd repo already carries. No-op in repos without bd. |

## Why background-jobs exists

A 24h agent session log (341 bash calls) showed the model hand-rolling job control:

- **3.3h** spent inside 45 `sleep N; tail log` poll statements
- **26** fragile `nohup ... & disown` background jobs, **2 lost entirely** to broken backgrounding chains
- 24 tool calls blocked >5min waiting on test gates

With this extension the agent starts a gate, does other work, and gets woken with the result. No polling, no lost jobs.

## Install

```bash
pi install git:github.com/sten-henriksson/pi-extensions
# or try without installing:
pi -e git:github.com/sten-henriksson/pi-extensions
```

Then enable/disable individual extensions with `pi config`.

## Develop

```bash
git clone … && cd pi-extensions
pi -e . -p 'bg_run …'   # live-test against the working tree
bash test/e2e.sh        # full battery (uses ~7 model calls; see header)
```

Layout: `extensions/*.ts` are auto-loaded (`package.json` → `pi.extensions`). Each extension is a single self-contained file with zero npm dependencies (node builtins + pi/typebox peers only).
