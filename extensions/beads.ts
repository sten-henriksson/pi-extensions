/**
 * Beads (bd) integration for pi:
 *
 *   1. Context injection (the pi equivalent of this repo's other harness
 *      hook wiring — same `bd prime` the Claude/Codex hooks use):
 *        .claude/settings.json → SessionStart:             `bd prime`
 *        .codex/hooks.json     → SessionStart/Pre/PostCompact: `bd codex-hook`
 *        .pi/extensions/beads.ts (this file)               `bd prime` via events
 *
 *   2. Backlog display:
 *        - persistent widget above the editor: in-progress + ready beads
 *        - `/beads` → interactive overlay side panel (right-anchored):
 *          Tab cycles filter (ready / in-progress / all open), Enter shows
 *          `bd show <id>` detail, r refreshes, q closes.
 *        - `/beads refresh` → force a `bd prime` re-injection (also the
 *          fallback in print mode, where there is no TUI).
 *
 * Silent no-op when `bd` is missing or no beads workspace resolves, so this
 * file is also safe to symlink into ~/.pi/agent/extensions/ for every repo.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PRIME_TYPE = "bd-prime";
const WIDGET_ID = "beads-backlog";
const CACHE_TTL_MS = 15_000;

/** Subset of the theme API this extension uses (structural, palette-relevant keys only). */
interface ThemeLike {
  fg: (
    color: "accent" | "error" | "warning" | "success" | "muted" | "dim" | "border" | "toolTitle",
    text: string
  ) => string;
  bold: (text: string) => string;
}

interface Bead {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type?: string;
  assignee?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface Backlog {
  /** Claimable: open, no active blockers (`bd ready`). */
  ready: Bead[];
  /** status=in_progress */
  active: Bead[];
  /** status=open but not claimable (dependency-blocked or simply not ready). */
  queued: Bead[];
  /** status=blocked */
  blocked: Bead[];
  /** status=deferred */
  deferred: Bead[];
}

/* ------------------------------------------------------------------ */
/* Data layer                                                          */
/* ------------------------------------------------------------------ */

const ansiRe = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string): string => s.replace(ansiRe, "");

function byPriority(a: Bead, b: Bead): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return (a.created_at ?? "").localeCompare(b.created_at ?? "");
}

function parseJsonArray(stdout: string): Bead[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is Bead => typeof b === "object" && b !== null && typeof (b as Bead).id === "string"
    );
  } catch {
    return [];
  }
}

let backlogCache: { cwd: string; at: number; backlog: Backlog } | undefined;

/**
 * Fetch the non-closed backlog in two calls: `bd list` for everything open,
 * `bd ready` for the claimable subset. Returns undefined when bd or the
 * workspace is unavailable (widget/panel treat that as "no beads here").
 */
export async function fetchBacklog(cwd: string, force = false): Promise<Backlog | undefined> {
  if (!force && backlogCache && backlogCache.cwd === cwd && Date.now() - backlogCache.at < CACHE_TTL_MS) {
    return backlogCache.backlog;
  }
  try {
    // SEQUENTIAL on purpose: bd uses an embedded dolt database whose file
    // lock serializes concurrent readers — running these in parallel makes
    // both queue behind the lock (observed 20s+ on large backlogs) and can
    // blow the timeout even though each call alone is fast. A generous
    // timeout matters: `bd list` on a 340-issue repo takes ~10s idle.
    const listRes = await exec(
      "bd",
      ["list", "--json", "--status", "open,in_progress,blocked,deferred", "-n", "0"],
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const readyRes = await exec("bd", ["ready", "--json", "-n", "0"], {
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const all = parseJsonArray(listRes.stdout);
    const readyIds = new Set(parseJsonArray(readyRes.stdout).map((b) => b.id));
    const backlog: Backlog = {
      ready: all.filter((b) => b.status === "open" && readyIds.has(b.id)).sort(byPriority),
      active: all.filter((b) => b.status === "in_progress").sort(byPriority),
      queued: all.filter((b) => b.status === "open" && !readyIds.has(b.id)).sort(byPriority),
      blocked: all.filter((b) => b.status === "blocked").sort(byPriority),
      deferred: all.filter((b) => b.status === "deferred").sort(byPriority),
    };
    backlogCache = { cwd, at: Date.now(), backlog };
    return backlog;
  } catch {
    return undefined;
  }
}

/** `bd show <id>` as plain text, ANSI-stripped (bd disables color off-tty). */
async function bdShow(cwd: string, id: string): Promise<string> {
  const { stdout } = await exec("bd", ["show", id], { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stripAnsi(stdout).trimEnd();
}

/* ------------------------------------------------------------------ */
/* Rendering helpers (exported for tests)                              */
/* ------------------------------------------------------------------ */

function prioColor(theme: ThemeLike, p: number): (s: string) => string {
  if (p <= 0) return (s) => theme.fg("error", s);
  if (p === 1) return (s) => theme.fg("warning", s);
  if (p === 2) return (s) => theme.fg("accent", s);
  return (s) => theme.fg("muted", s);
}

const pid = (b: Bead): string => `P${b.priority}`;

/** Widget/panel row cap for the id column — keeps titles aligned even with
 *  absurdly long project-prefixed ids. */
const ID_COL_CAP = 24;

/** Shared status glyphs so widget and panel read the same way
 *  (◐/○ follow bd's own legend; ready/queued split is ours):
 *  ◐ in progress · ● ready · ○ queued · ⊘ blocked · ◇ deferred. */
export function beadMarker(b: Bead, readyIds: Set<string>): string {
  switch (b.status) {
    case "in_progress":
      return "◐";
    case "blocked":
      return "⊘";
    case "deferred":
      return "◇";
    default:
      return readyIds.has(b.id) ? "●" : "○";
  }
}

/** One widget row: `▶ P0 bd-a3f8    Fix login` — id padded to idWidth so
 *  titles line up in a column. */
export function beadLine(theme: ThemeLike, b: Bead, marker: string, idWidth: number): string {
  const id = truncateToWidth(b.id, idWidth, "…").padEnd(idWidth);
  return (
    prioColor(theme, b.priority)(marker) +
    " " +
    prioColor(theme, b.priority)(pid(b)) +
    " " +
    theme.fg("dim", id) +
    " " +
    b.title.replace(/[\r\n]+/g, " ")
  );
}

/** Header line: `◆ beads  2 ready · 1 active · 3 queued · 1 blocked`. */
export function widgetHeader(theme: ThemeLike, b: Backlog): string {
  const counts: Array<[number, string, (s: string) => string]> = [
    [b.ready.length, "ready", (s) => theme.fg("success", s)],
    [b.active.length, "active", (s) => theme.fg("warning", s)],
    [b.queued.length, "queued", (s) => theme.fg("muted", s)],
    [b.blocked.length, "blocked", (s) => theme.fg("error", s)],
    [b.deferred.length, "deferred", (s) => theme.fg("dim", s)],
  ];
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, label, color]) => color(`${n} ${label}`));
  const summary =
    parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : theme.fg("dim", "backlog clear ✓");
  return theme.fg("accent", theme.bold("◆ beads")) + "  " + summary;
}

/** Widget body lines (header + top items + tail note). */
export function widgetLines(theme: ThemeLike, b: Backlog, maxItems = 6): string[] {
  const lines = [widgetHeader(theme, b)];
  const readyIds = new Set(b.ready.map((r) => r.id));
  const items: Bead[] = [...b.active, ...b.ready, ...b.queued];
  const shown = items.slice(0, maxItems);
  // Common id column width → titles align; capped so long ids truncate, not stretch.
  const idWidth = Math.min(ID_COL_CAP, Math.max(6, ...shown.map((s) => s.id.length)));
  for (const bead of shown) {
    lines.push(beadLine(theme, bead, beadMarker(bead, readyIds), idWidth));
  }
  const rest = items.length - shown.length + b.blocked.length + b.deferred.length;
  if (rest > 0) lines.push(theme.fg("dim", `  … +${rest} more — /beads to open panel`));
  return lines;
}

/* ------------------------------------------------------------------ */
/* Interactive side panel (overlay)                                    */
/* ------------------------------------------------------------------ */

type PanelMode = "ready" | "active" | "all";

const MODE_LABEL: Record<PanelMode, string> = {
  ready: "ACTIVE / READY",
  active: "IN PROGRESS",
  all: "ALL OPEN",
};

const EMPTY_MSG: Record<PanelMode, string> = {
  ready: "nothing ready to claim — backlog clear ✓",
  active: "no in-progress beads",
  all: "backlog clear ✓",
};

const LEGEND = "◐ active · ● ready · ○ queued · ⊘ blocked · ◇ deferred";
const LIST_HELP = "tab mode · ↵ detail · r refresh · q/esc close";
const MAX_VISIBLE = 15;
const MAX_DETAIL_LINES = 40;

function panelBeads(b: Backlog, mode: PanelMode): Bead[] {
  if (mode === "ready") return [...b.active, ...b.ready];
  if (mode === "active") return b.active;
  return [...b.active, ...b.ready, ...b.queued, ...b.blocked, ...b.deferred];
}

export interface PanelItem {
  value: string;
  label: string;
  description: string;
}

export function panelItems(b: Backlog, mode: PanelMode): PanelItem[] {
  const readyIds = new Set(b.ready.map((r) => r.id));
  return panelBeads(b, mode).map((bead) => ({
    value: bead.id,
    label: `${beadMarker(bead, readyIds)} ${pid(bead)} ${bead.id}`,
    description: bead.title.replace(/[\r\n]+/g, " "),
  }));
}

interface PanelOpts {
  theme: ThemeLike;
  cwd: string;
  backlog: Backlog;
  requestRender: () => void;
  onClose: () => void;
  /** Force-refresh; resolves to a new Backlog or undefined on failure. */
  onRefresh: () => Promise<Backlog | undefined>;
}

export class BeadsPanel implements Component {
  private readonly opts: PanelOpts;
  private mode: PanelMode = "ready";
  private view: "list" | "detail" = "list";
  private backlog: Backlog;
  private detailId?: string;
  private detailText?: string;
  private detailError = false;
  private idx = 0;
  private refreshing = false;

  constructor(opts: PanelOpts) {
    this.opts = opts;
    this.backlog = opts.backlog;
  }

  /** Switch filter mode, resetting the selection. */
  private setMode(mode: PanelMode): void {
    this.mode = mode;
    this.view = "list";
    this.idx = 0;
  }

  async refresh(): Promise<void> {
    this.refreshing = true;
    this.opts.requestRender();
    const fresh = await this.opts.onRefresh();
    this.refreshing = false;
    if (fresh) {
      this.backlog = fresh;
      this.idx = Math.min(this.idx, Math.max(0, panelBeads(fresh, this.mode).length - 1));
    }
    this.opts.requestRender();
  }

  private async openDetail(id: string): Promise<void> {
    this.view = "detail";
    this.detailId = id;
    this.detailText = undefined;
    this.detailError = false;
    this.opts.requestRender();
    try {
      this.detailText = await bdShow(this.opts.cwd, id);
    } catch {
      this.detailError = true;
    }
    this.opts.requestRender();
  }

  /** ANSI-aware: clip to the inner width and pad, so every row spans the box. */
  private row(content: string, inner: number, border: (s: string) => string): string {
    const clipped = visibleWidth(content) > inner ? truncateToWidth(content, inner, "…") : content;
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return border("│ ") + clipped + pad + border(" │");
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const border = (s: string) => t.fg("border", s);
    const inner = Math.max(12, width - 4);
    const lines: string[] = [];

    // Top border with the title embedded, window style: ┌─ title ──┐
    const plainTitle =
      this.view === "detail"
        ? `◆ ${this.detailId ?? ""}`
        : this.refreshing
          ? "◆ beads — refreshing…"
          : `◆ beads — ${MODE_LABEL[this.mode]} (${panelBeads(this.backlog, this.mode).length})`;
    const tw = visibleWidth(plainTitle);
    if (tw + 2 <= inner) {
      lines.push(
        border("┌─ ") + t.fg("accent", t.bold(plainTitle)) + border(` ${"─".repeat(inner - tw - 1)}┐`)
      );
    } else {
      lines.push(border(`┌${"─".repeat(inner + 2)}┐`));
      lines.push(this.row(t.fg("accent", t.bold(plainTitle)), inner, border));
    }
    lines.push(this.row("", inner, border));

    if (this.view === "detail") this.renderDetail(lines, inner, border);
    else this.renderList(lines, inner, border);

    lines.push(border(`└${"─".repeat(inner + 2)}┘`));
    return lines;
  }

  private renderList(lines: string[], inner: number, border: (s: string) => string): void {
    const t = this.opts.theme;
    const beads = panelBeads(this.backlog, this.mode);
    if (beads.length === 0) {
      lines.push(this.row(t.fg("dim", EMPTY_MSG[this.mode]), inner, border));
    } else {
      // idWidth from ALL beads in the mode, so the title column stays put
      // while scrolling the window.
      const readyIds = new Set(this.backlog.ready.map((r) => r.id));
      const idWidth = Math.min(ID_COL_CAP, Math.max(6, ...beads.map((b) => b.id.length)));
      const start = Math.max(
        0,
        Math.min(this.idx - Math.floor(MAX_VISIBLE / 2), beads.length - MAX_VISIBLE)
      );
      const end = Math.min(start + MAX_VISIBLE, beads.length);
      for (let i = start; i < end; i++) {
        const bead = beads[i]!;
        const selected = i === this.idx;
        const pc = prioColor(t, bead.priority);
        const id = truncateToWidth(bead.id, idWidth, "…").padEnd(idWidth);
        const head =
          (selected ? t.fg("accent", "❯ ") : "  ") +
          pc(beadMarker(bead, readyIds)) +
          " " +
          pc(pid(bead)) +
          " " +
          t.fg("dim", id) +
          " ";
        const titleText = bead.title.replace(/[\r\n]+/g, " ");
        lines.push(
          this.row(head + (selected ? t.bold(titleText) : t.fg("muted", titleText)), inner, border)
        );
      }
      if (start > 0 || end < beads.length) {
        lines.push(this.row(t.fg("dim", `(${this.idx + 1}/${beads.length})`), inner, border));
      }
    }
    lines.push(this.row(t.fg("dim", LEGEND), inner, border));
    lines.push(this.row(t.fg("dim", LIST_HELP), inner, border));
  }

  private renderDetail(lines: string[], inner: number, border: (s: string) => string): void {
    const t = this.opts.theme;
    if (this.detailError) {
      lines.push(this.row(t.fg("error", "`bd show` failed"), inner, border));
    } else if (this.detailText === undefined) {
      lines.push(this.row(t.fg("dim", "loading…"), inner, border));
    } else {
      // Truncate per line, never wrap: `bd show` aligns its own columns and
      // word-wrapping shreds that alignment in a narrow panel.
      const all = this.detailText.split("\n");
      for (const line of all.slice(0, MAX_DETAIL_LINES)) lines.push(this.row(line, inner, border));
      if (all.length > MAX_DETAIL_LINES) {
        lines.push(
          this.row(t.fg("dim", `… +${all.length - MAX_DETAIL_LINES} more lines`), inner, border)
        );
      }
    }
    lines.push(this.row(t.fg("dim", "esc back · q close"), inner, border));
  }

  invalidate(): void {
    // No cached render state.
  }

  handleInput(data: string): void {
    if (this.view === "detail") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) this.view = "list";
      else if (data === "q" || matchesKey(data, Key.ctrl("c"))) this.opts.onClose();
      return; // swallow everything else while reading detail
    }
    const beads = panelBeads(this.backlog, this.mode);
    if (matchesKey(data, Key.tab)) {
      this.setMode(this.mode === "ready" ? "active" : this.mode === "active" ? "all" : "ready");
    } else if (matchesKey(data, Key.shift(Key.tab))) {
      this.setMode(this.mode === "ready" ? "all" : this.mode === "all" ? "active" : "ready");
    } else if (beads.length > 0 && (matchesKey(data, Key.down) || data === "j")) {
      this.idx = (this.idx + 1) % beads.length;
    } else if (beads.length > 0 && (matchesKey(data, Key.up) || data === "k")) {
      this.idx = (this.idx - 1 + beads.length) % beads.length;
    } else if (beads.length > 0 && matchesKey(data, Key.enter)) {
      void this.openDetail(beads[this.idx]!.id);
    } else if (data === "r") {
      void this.refresh();
    } else if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.opts.onClose();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Prime context injection (unchanged behaviour)                       */
/* ------------------------------------------------------------------ */

/** Cheap filesystem probe — `.beads/` marks a bd workspace (bd init creates
 *  it in the repo root). Used to tell "no beads repo here" (no widget) from
 *  "beads repo but bd failed/timed out" (visible diagnostic widget). */
function beadsRepoExists(cwd: string): boolean {
  return existsSync(join(cwd, ".beads"));
}

/** Runs `bd prime` in cwd. Returns undefined when bd/workspace is absent. */
async function bdPrime(cwd: string): Promise<string | undefined> {
  try {
    await exec("bd", ["where"], { cwd });
    const { stdout } = await exec("bd", ["prime"], { cwd, maxBuffer: 2 * 1024 * 1024 });
    const text = stdout.trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** True when a bd-prime message is already active (not compacted away). */
function primeActive(ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager
      .buildContextEntries()
      .some((e: { type?: string; customType?: string }) => e.type === "custom_message" && e.customType === PRIME_TYPE);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/** Re-render (or clear) the persistent backlog widget above the editor. */
async function updateWidget(ctx: ExtensionContext, force = false): Promise<void> {
  if (!ctx.hasUI) return;
  const backlog = await fetchBacklog(ctx.cwd, force);
  if (!backlog) {
    // Distinguish "no beads here" from "bd too slow / failed": bd missing or
    // no workspace is a normal state for most repos (no widget), but a
    // timeout in a real beads repo should be visible, not silent.
    if (beadsRepoExists(ctx.cwd)) {
      ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
        const line = theme.fg("dim", "◆ beads — `bd` timed out or failed — /beads refresh");
        return {
          render: (width: number) => [truncateToWidth(line, width, "…")],
          invalidate: () => {},
        };
      });
    } else {
      ctx.ui.setWidget(WIDGET_ID, undefined);
    }
    return;
  }
  const maxItems = Number.parseInt(process.env.PI_BEADS_WIDGET_ROWS ?? "", 10) || 6;
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    const lines = widgetLines(theme as unknown as ThemeLike, backlog, maxItems);
    return {
      render: (width: number) => lines.map((line) => truncateToWidth(line, width, "…")),
      invalidate: () => {},
    };
  });
}

/** Open the overlay side panel. Opens immediately with cached data (or a
 *  loading state) and refreshes in the background — on slow dolt-backed
 *  repos a forced fetch can take 15-30s, which would otherwise freeze the
 *  command with zero feedback. */
async function openPanel(ctx: ExtensionContext): Promise<void> {
  const cached = await fetchBacklog(ctx.cwd); // cache hit is instant
  if (!cached && !beadsRepoExists(ctx.cwd)) {
    if (ctx.hasUI) ctx.ui.notify("No Beads workspace found (`bd` failed).", "error");
    return;
  }
  const initial: Backlog =
    cached ?? { ready: [], active: [], queued: [], blocked: [], deferred: [] };
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const panel = new BeadsPanel({
        theme: theme as unknown as ThemeLike,
        cwd: ctx.cwd,
        backlog: initial,
        requestRender: () => tui.requestRender(),
        onClose: () => done(null),
        onRefresh: () => fetchBacklog(ctx.cwd, true),
      });
      // No cache → kick a background refresh so the panel shows live data
      // as soon as bd answers (panel renders its own "refreshing…" state).
      if (!cached) setTimeout(() => void panel.refresh(), 0);
      return panel;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        width: "48%",
        minWidth: 48,
        maxHeight: "80%",
        margin: 1,
      },
    }
  );
  await updateWidget(ctx); // cheap re-sync after close
}

export default function (pi: ExtensionAPI) {
  let pending: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    pending = primeActive(ctx) ? undefined : ((await bdPrime(ctx.cwd)) ?? undefined);
    await updateWidget(ctx);
  });

  // Compaction summarises away the injected context — re-arm so the next
  // message re-primes (mirrors the Codex Pre/PostCompact hook pair).
  pi.on("session_compact", async (_event, ctx) => {
    pending = (await bdPrime(ctx.cwd)) ?? undefined;
  });

  // The agent may have claimed/closed beads during the turn — re-sync.
  // Force: the 15s cache would otherwise mask changes from a quick turn.
  pi.on("agent_settled", async (_event, ctx) => {
    void updateWidget(ctx, true);
  });

  pi.on("session_shutdown", () => {
    backlogCache = undefined;
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (pending === undefined) return;
    const content = pending;
    pending = undefined;
    return {
      message: {
        customType: PRIME_TYPE,
        content: `[bd prime] Injected by .pi/extensions/beads.ts — run /beads to refresh.\n\n${content}`,
        display: true,
      },
    };
  });

  pi.registerCommand("beads", {
    description:
      "Beads (bd): open the backlog side panel · `/beads refresh` re-injects `bd prime` context",
    handler: async (args, ctx) => {
      if (ctx.mode === "tui" && args.trim() !== "refresh") {
        await openPanel(ctx);
        return;
      }
      pending = (await bdPrime(ctx.cwd)) ?? undefined;
      if (ctx.hasUI) {
        ctx.ui.notify(
          pending !== undefined
            ? "Beads context armed — injecting on your next message."
            : "No Beads workspace found (`bd where` failed).",
          pending !== undefined ? "info" : "error"
        );
      }
    },
  });
}
