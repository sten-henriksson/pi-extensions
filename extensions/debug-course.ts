import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const ENTRY = "breakpoint-tour-course-progress";
const DEFAULT_URL = "http://127.0.0.1:7878";

type Progress = {
  course: string;
  startedAt: string;
  completedAt?: string;
  completedStops: string[];
  lastStop?: string;
  projectCommit?: string;
};

type TourResponse = {
  stop: null | {
    symbol?: string;
    tour_symbol?: string | null;
    file?: string;
    line?: number;
    source?: Array<[number, string]>;
    locals?: Record<string, string>;
    dead_locals?: string[];
    backtrace?: string[];
    timestamp?: number;
  };
  prose?: string | null;
  stub?: string | null;
  fingerprint?: string;
};

function endpoint(): string {
  return (process.env.BPTOUR_URL || DEFAULT_URL).replace(/\/$/, "");
}

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${endpoint()}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `breakpoint-tour is not reachable at ${endpoint()} (${reason}). ` +
      "Start the tutorial debug configuration and wait for its first stop.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function proseKey(stop: NonNullable<TourResponse["stop"]>): string {
  return stop.tour_symbol || stop.symbol || "<unknown>";
}

function sensitiveName(name: string): boolean {
  return /(persoid|ftgoid|customer|employee|person(?:nr|id|name)?|name|email|address|token|password|secret)/i.test(name);
}

function sensitiveValue(value: string): boolean {
  // RESPONS company/person identifiers commonly contain long alphanumeric runs.
  return /["']?[0-9]{2,}[A-Z][A-Z0-9]{6,}["']?/i.test(value);
}

function safeTourState(raw: TourResponse, includeSource = false): object {
  if (!raw.stop) return { stop: null, message: "Debugger has not published a stop yet." };
  const allowRaw = process.env.BPTOUR_PI_UNREDACTED === "1";
  const locals = Object.fromEntries(
    Object.entries(raw.stop.locals || {}).map(([name, value]) => [
      name,
      !allowRaw && (sensitiveName(name) || sensitiveValue(value)) ? "<redacted>" : value,
    ]),
  );
  const stop = {
    symbol: raw.stop.symbol,
    tour_symbol: raw.stop.tour_symbol,
    prose_key: proseKey(raw.stop),
    file: raw.stop.file,
    line: raw.stop.line,
    locals,
    dead_locals: raw.stop.dead_locals || [],
    backtrace: (raw.stop.backtrace || []).slice(0, 12),
    ...(includeSource ? { source: raw.stop.source || [] } : {}),
  };
  return {
    stop,
    reviewed_prose: raw.prose || null,
    missing_prose_stub: raw.prose ? null : raw.stub || null,
    redaction: allowRaw
      ? "WARNING: BPTOUR_PI_UNREDACTED=1; values were not redacted"
      : "identifier-like local values are redacted before entering model context",
  };
}

function restoreProgress(ctx: ExtensionContext): Progress | undefined {
  let found: Progress | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENTRY) {
      found = entry.data && typeof entry.data === "object"
        ? entry.data as Progress
        : undefined;
    }
  }
  return found;
}

function persist(pi: ExtensionAPI, progress: Progress): void {
  pi.appendEntry(ENTRY, progress);
}

function setProgressWidget(ctx: ExtensionContext, progress?: Progress): void {
  if (!ctx.hasUI) return;
  if (!progress) {
    ctx.ui.setWidget("breakpoint-tour", undefined);
    return;
  }
  const done = progress.completedStops.length;
  const suffix = progress.completedAt ? " · complete" : "";
  ctx.ui.setWidget("breakpoint-tour", [
    `Debugger course: ${progress.course} · ${done} stop${done === 1 ? "" : "s"}${suffix}`,
    `Last: ${progress.lastStop || "waiting for first breakpoint"}`,
  ], { placement: "belowEditor" });
}

async function gitCommit(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000 });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function progressMarkdown(progress: Progress, cwd: string): string {
  const lines = [
    "# Debugger onboarding result",
    "",
    `- **Course:** \`${progress.course}\``,
    `- **Started:** ${progress.startedAt}`,
    `- **Finished:** ${progress.completedAt || "in progress"}`,
    `- **Project commit:** \`${progress.projectCommit || "unknown"}\``,
    `- **Workspace:** \`${cwd}\``,
    `- **Completed stops:** ${progress.completedStops.length}`,
    "",
    "## Stops completed",
    "",
    ...(progress.completedStops.length
      ? progress.completedStops.map((stop) => `- \`${stop}\``)
      : ["- None"]),
    "",
    "## Data handling",
    "",
    "This report deliberately excludes source windows, local-variable values, person identifiers, and conversation content.",
    "",
  ];
  return lines.join("\n");
}

function tutorPrompt(course: string, state?: object): string {
  return [
    `Act as the guided debugger tutor for course \`${course}\`.`,
    "Use reviewed_prose as the authority. Clearly label REVIEWED FACT, RUNTIME OBSERVATION, and AI HYPOTHESIS.",
    "Ask one focused question at a time. Do not invent payroll semantics and do not claim a stop is complete for the learner.",
    "The learner controls Continue in VS Code. Use debug_tour_state whenever the debugger reaches a new stop.",
    state ? `\nCurrent sanitized debugger state:\n${JSON.stringify(state, null, 2)}` : "",
  ].filter(Boolean).join("\n");
}

export default function (pi: ExtensionAPI) {
  let progress: Progress | undefined;

  pi.on("session_start", async (_event, ctx) => {
    progress = restoreProgress(ctx);
    setProgressWidget(ctx, progress);
  });

  pi.registerTool({
    name: "debug_tour_state",
    label: "Debugger Tour State",
    description: "Read the current breakpoint-tour stop, reviewed prose, sanitized locals, and backtrace. Identifier-like values are redacted by default.",
    promptSnippet: "Read the current live debugger-tour stop and its reviewed explanation",
    promptGuidelines: [
      "Use debug_tour_state during a guided debugger course instead of asking the learner to paste raw debugger state.",
      "Treat debug_tour_state reviewed_prose as authoritative; label any inference from locals as an AI hypothesis.",
    ],
    parameters: Type.Object({
      includeSource: Type.Optional(Type.Boolean({ description: "Include the source window; false by default to keep context small" })),
    }),
    async execute(_id, params) {
      const raw = await getJson<TourResponse>("/state");
      const safe = safeTourState(raw, params.includeSource === true);
      return {
        content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
        details: safe,
      };
    },
  });

  pi.registerTool({
    name: "debug_tour_history",
    label: "Debugger Tour History",
    description: "List recent debugger stops without local-variable values.",
    parameters: Type.Object({}),
    async execute() {
      const raw = await getJson<{ stops?: TourResponse["stop"][] }>("/history");
      const stops = (raw.stops || []).filter(Boolean).map((stop) => ({
        symbol: stop?.symbol,
        tour_symbol: stop?.tour_symbol,
        file: stop?.file,
        line: stop?.line,
        timestamp: stop?.timestamp,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ stops }, null, 2) }],
        details: { stops },
      };
    },
  });

  pi.registerCommand("debug-state", {
    description: "Explain the current breakpoint-tour stop using sanitized state",
    handler: async (_args, ctx) => {
      try {
        const raw = await getJson<TourResponse>("/state");
        const safe = safeTourState(raw, false);
        if (raw.stop && progress) {
          progress = { ...progress, lastStop: proseKey(raw.stop) };
          persist(pi, progress);
          setProgressWidget(ctx, progress);
        }
        pi.sendUserMessage(tutorPrompt(progress?.course || "debug-tour", safe));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("onboard", {
    description: "Run a guided breakpoint-tour course: start, state, complete, progress, export, reset",
    handler: async (args, ctx) => {
      const [action = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (action === "setup") {
        if (!ctx.hasUI) {
          throw new Error("/onboard setup requires interactive confirmation");
        }
        const tour = rest[0] || "wiki/tour/parity.md";
        const copyFrom = (rest.slice(1).join(" ") ||
          process.env.BPTOUR_COPY_FROM ||
          "Ratchet: rep80 only (smallest, start here)").replace(/^['\"]|['\"]$/g, "");
        const ok = await ctx.ui.confirm(
          "Install debugger course?",
          `Generate/update the tour entry in .vscode/launch.json from ${tour}, copying ${copyFrom}?`,
        );
        if (!ok) return;
        const toolRoot = process.env.BPTOUR_TOOL_PATH?.trim();
        const initArgs = [
          "-m",
          "breakpoint_tour",
          "init",
          "--tour",
          tour,
          "--copy-from",
          copyFrom,
        ];
        if (toolRoot) initArgs.push("--tool-path", resolve(toolRoot));
        initArgs.push("--write");
        const result = await pi.exec("python3", initArgs, { timeout: 15_000 });
        if (result.code !== 0) {
          ctx.ui.notify(result.stderr.trim() || result.stdout.trim() || "Debugger course setup failed", "error");
          return;
        }
        ctx.ui.notify(result.stdout.trim() || "Debugger course launch configuration installed", "info");
        return;
      }

      if (action === "start") {
        const course = rest[0] || "parity";
        progress = {
          course,
          startedAt: new Date().toISOString(),
          completedStops: [],
          projectCommit: await gitCommit(pi, ctx.cwd),
        };
        persist(pi, progress);
        setProgressWidget(ctx, progress);
        let safe: object | undefined;
        try {
          safe = safeTourState(await getJson<TourResponse>("/state"), false);
        } catch {
          // Starting before F5 is normal. The tutor tells the learner what to do.
        }
        pi.sendUserMessage([
          tutorPrompt(course, safe),
          safe
            ? "Begin with the current stop."
            : "The debugger has not stopped yet. Tell the learner to launch the tutorial configuration in VS Code, wait for the first breakpoint, then run /debug-state.",
        ].join("\n"));
        return;
      }

      if (action === "state" || action === "explain") {
        try {
          const raw = await getJson<TourResponse>("/state");
          const safe = safeTourState(raw, false);
          if (raw.stop && progress) {
            progress = { ...progress, lastStop: proseKey(raw.stop) };
            persist(pi, progress);
            setProgressWidget(ctx, progress);
          }
          pi.sendUserMessage(tutorPrompt(progress?.course || "debug-tour", safe));
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (action === "complete") {
        if (!progress) {
          ctx.ui.notify("No active course. Run /onboard start parity", "warning");
          return;
        }
        try {
          const raw = await getJson<TourResponse>("/state");
          if (!raw.stop) throw new Error("Debugger has not published a stop yet");
          const stop = proseKey(raw.stop);
          progress = {
            ...progress,
            lastStop: stop,
            completedStops: [...new Set([...progress.completedStops, stop])],
          };
          persist(pi, progress);
          setProgressWidget(ctx, progress);
          ctx.ui.notify(`Completed stop: ${stop}. Continue in VS Code, then run /debug-state.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (action === "finish") {
        if (!progress) {
          ctx.ui.notify("No active course", "warning");
          return;
        }
        progress = { ...progress, completedAt: new Date().toISOString() };
        persist(pi, progress);
        setProgressWidget(ctx, progress);
        ctx.ui.notify("Course marked complete. Run /onboard export to create a sanitized report.", "info");
        return;
      }

      if (action === "progress") {
        if (!progress) {
          ctx.ui.notify("No active course. Run /onboard start parity", "warning");
          return;
        }
        ctx.ui.notify(
          `${progress.course}: ${progress.completedStops.length} completed; last ${progress.lastStop || "none"}`,
          "info",
        );
        return;
      }

      if (action === "export") {
        if (!progress) {
          ctx.ui.notify("No active course to export", "warning");
          return;
        }
        const requested = rest.join(" ");
        const output = resolve(ctx.cwd, requested || `onboarding-results/${progress.course}-${Date.now()}.md`);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, progressMarkdown(progress, ctx.cwd), "utf8");
        ctx.ui.notify(`Sanitized report written to ${relative(ctx.cwd, output) || output}`, "info");
        return;
      }

      if (action === "reset") {
        progress = undefined;
        pi.appendEntry(ENTRY, null);
        setProgressWidget(ctx, undefined);
        ctx.ui.notify("Debugger course progress reset", "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /onboard setup [tour] [copy-config] | start [course] | state | complete | progress | finish | export [path] | reset",
        "info",
      );
    },
  });
}
