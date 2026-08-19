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
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  SelectList,
  Text,
  truncateToWidth,
  matchesKey,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
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
    const [listRes, readyRes] = await Promise.all([
      exec("bd", ["list", "--json", "--status", "open,in_progress,blocked,deferred", "-n", "0"], {
        cwd,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      }),
      exec("bd", ["ready", "--json", "-n", "0"], { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
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

/** One widget/panel row: `● P1 bd-a3f8 · Fix login`. */
export function beadLine(theme: ThemeLike, b: Bead, marker = "●"): string {
  return (
    prioColor(theme, b.priority)(marker) +
    " " +
    prioColor(theme, b.priority)(pid(b)) +
    " " +
    theme.fg("dim", b.id) +
    theme.fg("muted", " · ") +
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
  const items: Bead[] = [...b.active, ...b.ready, ...b.queued.slice(0, Math.max(0, maxItems - b.active.length - b.ready.length))];
  const shown = items.slice(0, maxItems);
  for (const bead of shown) {
    const marker = bead.status === "in_progress" ? "▶" : b.ready.some((r) => r.id === bead.id) ? "●" : "○";
    lines.push(beadLine(theme, bead, marker));
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
  ready: "READY",
  active: "IN PROGRESS",
  all: "ALL OPEN",
};

function panelBeads(b: Backlog, mode: PanelMode): Bead[] {
  if (mode === "ready") return [...b.active, ...b.ready];
  if (mode === "active") return b.active;
  return [...b.active, ...b.ready, ...b.queued, ...b.blocked, ...b.deferred];
}

export function panelItems(b: Backlog, mode: PanelMode): SelectItem[] {
  return panelBeads(b, mode).map((bead) => ({
    value: bead.id,
    label: `${pid(bead)} ${bead.id}`,
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
  private container = new Container();
  private select?: SelectList;
  private refreshing = false;

  constructor(opts: PanelOpts) {
    this.opts = opts;
    this.backlog = opts.backlog;
    this.rebuild();
  }

  /** Modes cycle ready → active → all → ready. */
  private cycleMode(): void {
    this.mode = this.mode === "ready" ? "active" : this.mode === "active" ? "all" : "ready";
    this.view = "list";
    this.rebuild();
  }

  private async refresh(): Promise<void> {
    this.refreshing = true;
    this.rebuild();
    this.opts.requestRender();
    const fresh = await this.opts.onRefresh();
    this.refreshing = false;
    if (fresh) this.backlog = fresh;
    this.rebuild();
    this.opts.requestRender();
  }

  private async openDetail(id: string): Promise<void> {
    this.view = "detail";
    this.detailId = id;
    this.detailText = undefined;
    this.detailError = false;
    this.rebuild();
    this.opts.requestRender();
    try {
      this.detailText = await bdShow(this.opts.cwd, id);
    } catch {
      this.detailError = true;
    }
    this.rebuild();
    this.opts.requestRender();
  }

  private modeTitle(): string {
    const theme = this.opts.theme;
    const beads = panelBeads(this.backlog, this.mode);
    return (
      theme.fg("accent", theme.bold(`◆ beads — ${MODE_LABEL[this.mode]}`)) +
      theme.fg("muted", `  (${beads.length})`)
    );
  }

  private rebuild(): void {
    const theme = this.opts.theme;
    this.container = new Container();
    this.select = undefined;

    if (this.view === "list") {
      const items = panelItems(this.backlog, this.mode);
      this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      const status = this.refreshing ? theme.fg("dim", "refreshing…") : this.modeTitle();
      this.container.addChild(new Text(status, 1, 0));

      const select = new SelectList(items, 15, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      select.onSelect = (item) => void this.openDetail(item.value);
      // Escape in list view closes the panel (SelectList emits onCancel).
      select.onCancel = () => this.opts.onClose();
      this.select = select;
      this.container.addChild(select);

      this.container.addChild(
        new Text(theme.fg("dim", "tab filter · enter detail · r refresh · q/esc close"), 1, 0)
      );
      this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    } else {
      this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      this.container.addChild(
        new Text(
          theme.fg("accent", theme.bold(`◆ ${this.detailId ?? ""}`)) + theme.fg("dim", "  (esc back)"),
          1,
          0
        )
      );
      let body: string;
      if (this.detailError) {
        body = theme.fg("error", "`bd show` failed");
      } else if (this.detailText === undefined) {
        body = theme.fg("dim", "loading…");
      } else {
        body = this.detailText;
      }
      // Cap very long audit trails; the overlay clips anyway.
      const lines = body.split("\n");
      const capped =
        lines.length > 40 ? lines.slice(0, 40).join("\n") + `\n… +${lines.length - 40} more lines` : body;
      this.container.addChild(new Text(capped, 1, 0));
      this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    }
  }

  render(width: number): string[] {
    return this.container.render(width).map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (this.view === "detail") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
        this.view = "list";
        this.rebuild();
      }
      return; // swallow everything else while reading detail
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleMode();
    } else if (matchesKey(data, Key.shift(Key.tab))) {
      this.mode = this.mode === "ready" ? "all" : this.mode === "all" ? "active" : "ready";
      this.rebuild();
    } else if (data === "r") {
      void this.refresh();
    } else if (data === "q") {
      this.opts.onClose();
    } else if (data === "j" || data === "k") {
      // Translate vim keys to the arrows SelectList understands natively.
      this.select?.handleInput(data === "j" ? "\x1b[B" : "\x1b[A");
    } else {
      this.select?.handleInput(data);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Prime context injection (unchanged behaviour)                       */
/* ------------------------------------------------------------------ */

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
async function updateWidget(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const backlog = await fetchBacklog(ctx.cwd);
  if (!backlog) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
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

/** Open the overlay side panel; refreshes backlog data afterwards. */
async function openPanel(ctx: ExtensionContext): Promise<void> {
  const backlog = await fetchBacklog(ctx.cwd, true);
  if (!backlog) {
    if (ctx.hasUI) ctx.ui.notify("No Beads workspace found (`bd` failed).", "error");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) =>
      new BeadsPanel({
        theme: theme as unknown as ThemeLike,
        cwd: ctx.cwd,
        backlog,
        requestRender: () => tui.requestRender(),
        onClose: () => done(null),
        onRefresh: () => fetchBacklog(ctx.cwd, true),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        width: "45%",
        minWidth: 44,
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
  pi.on("agent_settled", async (_event, ctx) => {
    void updateWidget(ctx);
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
