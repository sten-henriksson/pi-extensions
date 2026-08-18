# pi-extensions

Extensions for [pi](https://npmjs.com/package/@earendil-works/pi-coding-agent), installable as one package:

| Extension | What it does |
|---|---|
| **background-jobs** (`bg_run` / `bg_wait` / `bg_logs` / `bg_list` / `bg_kill`, `/bg`) | First-class background jobs for agents: start long commands detached, get job ids + logs, bounded waits that treat timeouts as *not an error*, whole-process-tree kills, and **automatic completion notifications** injected into the conversation (exit code + tail), with restart re-attach via pid probe + exit-code sentinels. |
| **beads** | Injects `bd prime` workflow context on session start (deduped, re-armed after compaction) — the pi equivalent of the Claude Code / Codex hooks a bd repo already carries. No-op in repos without bd. |
| **mimo-memory** (`/dream`, `/distill`) | Cross-session memory & skill distillation, ported from Xiaomi MiMo Code's Evolution theme. `/dream` consolidates session traces into an injectable `MEMORY.md` (map-reduce, mtime-keyed cache, review gate); `/distill` mines repeated workflows, counts occurrences in code, gates on frequency + safety, and stages candidate skills — nothing auto-installed. |
| **ralph** (`/ralph`, `ralph_start`/`ralph_done`) | Long-running agent loops (fork of tmustier/pi-ralph-wiggum, MIT) with an **independent completion verifier**: the completion marker is a claim, not a verdict — a judge model (`.ralph/judge.json`, ideally a different model) reviews the task file's verification record before the loop may complete; rejected claims re-prompt with reasons (max 3). |

## Why background-jobs exists

A 24h agent session log (341 bash calls) showed the model hand-rolling job control:

- **3.3h** spent inside 45 `sleep N; tail log` poll statements
- **26** fragile `nohup ... & disown` background jobs, **2 lost entirely** to broken backgrounding chains
- 24 tool calls blocked >5min waiting on test gates

With this extension the agent starts a gate, does other work, and gets woken with the result. No polling, no lost jobs.

## ralph

Long-running loops for verifiable tasks (checklists, refactors, error sweeps): the agent works in iterations, `ralph_done` advances, compaction absorbs history, `.ralph/<name>.md` carries durable state. Forked from [tmustier/pi-ralph-wiggum](https://github.com/tmustier/pi-extensions) (MIT, itself from Geoffrey Huntley's ralph-loop).

**Fork addition — independent verifier** (glla's "bamboozle trap", MiMo Code's `/goal`): on each `<promise>COMPLETE</promise>` a judge model reads the task file's *Final Verification* record (exact command + output) and the agent's claim, and decides whether completion is *demonstrated*. Rejections re-prompt the agent with concrete reasons (cap 3, then completes to avoid a verify-loop; verifier errors fail open). Configure the judge with `.ralph/judge.json`: `{"model": "provider/model-id"}` — use a different model than the working agent for true independence (defaults to the active model). Verified e2e: first claim rejected over a 15-vs-16-byte inconsistency, accepted only after hash-verified evidence.

## mimo-memory

`/dream [days]` (default 7) scans this directory's session traces, extracts durable facts per session (cheap model, cached by session mtime), consolidates them into `MEMORY.md` (merge/dedup/prune, changelog, snapshots), and injects it into the system prompt every turn. `/distill [days]` (default 30) mines repeated workflows from the same traces, requires ≥2 distinct sessions (`minOccurrences`), scans for unsafe patterns, and stages SKILL.md candidates under review — activate with `/distill install <name>`.

Files always land in the repo: `<cwd>/.pi/memory/` (`MEMORY.md`, `config.json` with `mapModel`/`reduceModel` for the independent-verifier rule e.g. `"google/gemini-2.5-flash"`, `extracts/` cache, `distill-staging/`, `dream-log.jsonl`) and `<cwd>/.pi/skills/` for installed skills — never the user config dir, so memory is committed and shared with the repo. Cadence is a once-daily nag, never auto-run. Design: reviewability first (plain markdown you can edit/delete), counting and path-validity in code, zero-packaging is a valid distill outcome.

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
