# pi-extensions

Extensions for [pi](https://npmjs.com/package/@earendil-works/pi-coding-agent), installable as one package:

| Extension | What it does |
|---|---|
| **browser-flows** (`browser_action` / `browser_flow`, `/flow`, `browser-flows` skill) | Records agent-browser actions as versioned workflow graphs, replays documented paths with compact results, supports branches/checkpoints and targeted repair artifacts, and preserves structured path knowledge (purpose, usage, prerequisites, outcomes, tags). Credentials and captured site data are not packaged; each user's flows stay under `~/.pi/agent/browser-flows/`. |
| **background-jobs** (`bg_run` / `bg_wait` / `bg_logs` / `bg_list` / `bg_kill`, `/bg`) | First-class background jobs for agents: start long commands detached, get job ids + logs, bounded waits that treat timeouts as *not an error*, whole-process-tree kills, and **automatic completion notifications** injected into the conversation (exit code + tail), with restart re-attach via pid probe + exit-code sentinels. |
| **beads** (`/beads`, `/beads refresh`) | Injects `bd prime` workflow context on session start (deduped, re-armed after compaction) — the pi equivalent of the Claude Code / Codex hooks a bd repo already carries. Plus a backlog display: a persistent widget above the editor (in-progress → ready → queued, priority-colored) and `/beads` opening an overlay side panel (Tab cycles ready/in-progress/all-open, Enter shows `bd show` detail, `r` refreshes, j/k navigate). Auto-resyncs after each agent turn. No-op in repos without bd. |
| **mimo-memory** (`/dream`, `/distill`) | Cross-session memory & skill distillation, ported from Xiaomi MiMo Code's Evolution theme. `/dream` consolidates session traces into an injectable `MEMORY.md` (map-reduce, mtime-keyed cache, review gate); `/distill` mines repeated workflows, counts occurrences in code, gates on frequency + safety, and stages candidate skills — nothing auto-installed. |
| **ralph** (`/ralph`, `ralph_start`/`ralph_done`) | Long-running agent loops (fork of tmustier/pi-ralph-wiggum, MIT) with an **independent completion verifier**: the completion marker is a claim, not a verdict — a judge model (`.ralph/judge.json`, ideally a different model) reviews the task file's verification record before the loop may complete; rejected claims re-prompt with reasons (max 3). |

## browser-flows

Browser flows turn repeated `agent-browser` work into local, documented workflow graphs instead of spending model tokens rediscovering the same route. The package provides two tools:

- `browser_action` runs one `agent-browser` command and records it when recording is active.
- `browser_flow` lists, records, documents, branches, replays, repairs, imports, and exports flows.

```text
/flow list
/flow record admin-settings
/flow stop settings-page
/flow run admin-settings settings-page
/flow export admin-settings ./reviewed-flows/
/flow import ./reviewed-flows/admin-settings.json
```

Use `/skill:browser-flows ...` to force the bundled skill for agent-driven recording or repair. Flow files, revision history, active recording state, failure snapshots, and screenshots are created locally under `~/.pi/agent/browser-flows/` and are never part of this package. Passwords, cookies, tokens, and session state must not be recorded; value-entry actions are opt-in while recording. `agent-browser` must be available on `PATH`.

Export creates a portable JSON copy, always removes browser/profile/session arguments, and refuses commands or documentation that look private (credentials, entered values, email addresses, user paths, URL query values, eval/storage/auth data, or local file paths). Import validates the graph, applies the same safety scan, strips browser arguments again, and refuses implicit overwrite. Review exports before committing them to a private flow repository; never sync runtime artifacts or browser state.

The graph format supports shared prefixes and guarded branches, so authenticated navigation can be reused by multiple destinations. Structured flow/checkpoint documentation lets agents discover a saved path by purpose and tags before inspecting its implementation.

Legacy same-origin iframe and popup paths can use constrained durable actions when semantic lookup is unavailable: `frame-click`, `frame-assert-text`, `click-visible`, and `tab-switch-url`. These translate to fixed extension-controlled browser operations, so flows store reviewed selectors/globs rather than eval source or snapshot-local refs.

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

## scripts/model-bench.py

Throughput/latency/cost table for every model your pi can reach — one real
generation per model through the pi binary, so it measures your actual
providers, keys and gateways.

```bash
./scripts/model-bench.py                # every model in `pi --list-models`
./scripts/model-bench.py zai            # filter by provider/model substring
./scripts/model-bench.py -n 3 zai       # 3 runs each, best tok/s wins
./scripts/model-bench.py --md bench.md  # also write the markdown table
```

Columns: tok/s (visible output tokens over the generation window), TTFT (first
assistant event — pi's json mode has no token deltas, so this is a proxy), wall,
output tokens, reasoning tokens, cost. Rate-limited or unauthenticated models
are listed with the API error instead of being dropped.

## scripts/task-bench.py

A deterministic coding-task benchmark that measures **pass rate, time-to-green,
and cost-to-green**, not merely generation speed. Every run copies a clean
standard-library Python fixture, applies a deliberately failing task setup, runs
a real `pi` worker, checks that protected tests were not modified, and runs the
machine-verifiable checker in a fresh shell.

```bash
./scripts/task-bench.py --verify-only
./scripts/task-bench.py --models github-copilot/gpt-5.4-mini --runs 1
./scripts/task-bench.py --models zai/glm-5.3,github-copilot/gpt-5.4-mini --runs 3
./scripts/task-bench.py --models github-copilot/gpt-5.4-mini --tasks slug-normalization,record-merge
```

Four initial tasks live in `bench/tasks/`: slug normalization, remainder-safe
money splitting, bounded retry, and stable record merging. Results write to
`bench/results/latest.md` plus timestamped JSON/Markdown reports (ignored by
Git). It is intentionally a script rather than a pi extension: it needs clean
disposable worktrees, long subprocesses, hard timeouts, and shell verification.

## Develop

```bash
git clone … && cd pi-extensions
pi -e . -p 'bg_run …'   # live-test against the working tree
bash test/e2e.sh        # full battery (uses ~7 model calls; see header)
```

Layout: `extensions/*.ts` and extension subdirectories are auto-loaded (`package.json` → `pi.extensions`); bundled skills live under `skills/`. Most extensions are single files, while browser-flows is split into focused modules. Runtime code uses only Node builtins and Pi/typebox peers.
