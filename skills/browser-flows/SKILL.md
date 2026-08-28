---
name: browser-flows
description: Records, documents, discovers, replays, branches, and repairs agent-browser workflows through Pi's browser_action and browser_flow tools. Use for repeated browser tasks where prior successful paths and website knowledge should be reused to save time and tokens.
compatibility: Requires Pi browser-flows extension and agent-browser available on PATH.
---

# Browser Flows

Use saved workflow graphs before re-exploring a website.

## Reuse first

1. Call `browser_flow` with `operation: "list"`.
2. If a flow matches, inspect it with `operation: "show"` only when needed.
3. Replay with `operation: "run"` and the narrowest useful checkpoint `target`.
4. Successful replay is intentionally compact. Do not request snapshots afterward unless verification is missing.

## Record a new path

1. Start with `browser_flow { operation: "start_recording", name, description, browserArgs? }`.
2. Drive the site only through `browser_action`.
3. Prefer durable semantic commands:
   - `find role button click --name Settings`
   - `find text "See all settings" click --exact`
   - `find label Email fill value`
   - CSS only when semantic locators are unavailable.
4. For legacy same-origin iframe/popup controls that semantic lookup cannot reach, use only the constrained durable fallbacks:
   - `frame-click <frame-css> <element-css>` — click a stable selector inside one same-origin iframe.
   - `frame-select-text <frame-css> <select-css> <visible-option>` — select one exact visible option inside a same-origin iframe; recording requires explicit opt-in.
   - `frame-assert-text <frame-css> <visible-text>` — wait for text inside that iframe.
   - `click-visible <css>` — click the first visible duplicate in the current document.
   - `tab-switch-url <url-glob>` — switch to exactly one matching popup tab.
   These are fixed extension actions, not saved eval scripts. Use stable IDs/attributes and document why the fallback is needed.
5. Avoid recording `@eN` refs. They are snapshot-local and saved nodes containing them are marked unstable.
6. Give navigation actions an `expectUrl` or `expectText` assertion.
7. Mark submits, sends, creates, deletes, and purchases with the correct `sideEffect`.
8. End with `browser_flow { operation: "stop_recording", checkpoint: "useful-name" }`.

Set `record: false` on observations (`snapshot`, `get`, screenshots), authentication, secrets, and one-off recovery actions.

## Add branches

A flow is a directed graph, not a linear script. To add another route after a shared node:

1. Start recording the existing flow with `from` set to a node ID or checkpoint. If that node already has an outgoing path, also set `branchTarget` to the new route's intended checkpoint/target.
2. Record the new route and stop with a new checkpoint.
3. Use `add_edge` with a `url` condition for runtime state branches (logged-in vs login page). Use `remove_edge` to retire stale paths during repair.

Do not duplicate login/navigation prefixes when a shared checkpoint can be reused.

## Path documentation and website knowledge

Treat each saved flow and checkpoint as reusable documentation, not merely a click queue. Use `browser_flow document` after recording or learning what a path does.

Documentation fields:

- `docPurpose` — what the flow/path configures, displays, or accomplishes (required)
- `docUseWhen` — user intents for which an agent should choose it
- `docPrerequisites` — required selections, permissions, authentication, or prior setup
- `docOutcome` — what state exists after reaching the checkpoint
- `docDetails` — longer domain knowledge and UI quirks
- `docTags` — discovery terms

Omit `node` to document the whole flow. Set `node` to a node ID or checkpoint to document that route. Use `remove_document` when knowledge becomes obsolete.

Example checkpoint documentation:

```json
{
  "operation": "document",
  "name": "admin-portal",
  "node": "report-settings",
  "docPurpose": "Configure report visibility and scheduled delivery",
  "docUseWhen": "The user wants to change who can see reports or when reports are emailed",
  "docPrerequisites": ["An organization must be selected", "The account needs admin permission"],
  "docOutcome": "The report settings page is open for the selected organization",
  "docTags": ["reports", "organization", "permissions", "scheduling"]
}
```

`browser_flow list` exposes flow and checkpoint purposes, outcomes, and tags so choose a documented path without opening every graph. `browser_flow show` returns the full documentation. Relevant documentation is also included in replay failures.

Legacy `add_note` memos remain readable, but prefer structured `document` knowledge. Documentation explains prerequisites; when a prerequisite can be automated reliably, also record it as a branch.

## Repair failures

A failed replay writes a compact interactive snapshot and screenshot under `~/.pi/agent/browser-flows/artifacts/` and returns their paths.

1. Read the failure snapshot only—not every prior page.
2. Identify a durable semantic replacement for the failed node.
3. Patch it with `operation: "update_node"`, or add a changed route with `add_edge`.
4. Replay to the same target to verify.
5. Do not blindly retry irreversible steps. Set `allowIrreversible` only after explicit user approval.

## Authentication and secrets

- Keep login state in flow-level `browserArgs`, normally `--profile <Windows profile path>` or `--session-name <name>`.
- Do not put passwords, cookies, tokens, recovery codes, or session state in a flow.
- Use `record: false` for authentication actions.
- Pause for user login, MFA, CAPTCHA, or account consent when necessary.
- Prefer a checkpoint immediately before any externally visible side effect.

## Import, export, and private-repo sync

Use `browser_flow export` to create a sanitized, portable JSON file. Export always strips flow-level browser/profile/session arguments and refuses commands or documentation that may contain credentials, entered values, personal paths, email addresses, URL query values, page-evaluation data, or local file paths. Always review the resulting JSON before sharing or committing it.

Use `browser_flow import` to validate and copy a sanitized JSON flow into local storage. Import strips browser arguments again, refuses unsafe content, and does not overwrite an existing flow unless `overwrite: true` is explicit. Configure machine-local `browserArgs` after import when required.

Do not copy `artifacts/`, `revisions/`, `.recording.json`, screenshots, or browser state into a shared repository. For a private flow repository, track only reviewed exported `*.json` files and ignore runtime data.

## Storage

Flows are versioned JSON graphs in `~/.pi/agent/browser-flows/`; no graph database is needed. Previous revisions and failure artifacts are kept in subdirectories. Prefer the extension tools over editing a live graph while recording.
