/**
 * Beads (bd) integration for pi — the pi equivalent of this repo's other
 * harness hook wiring:
 *
 *   .claude/settings.json → SessionStart:            `bd prime`
 *   .codex/hooks.json     → SessionStart/Pre/PostCompact: `bd codex-hook`
 *   .pi/extensions/beads.ts (this file)              `bd prime` via events
 *
 * Behaviour:
 *   - session_start (startup | new | resume | fork): runs `bd prime` and arms
 *     a one-shot injection of its output into the next agent turn.
 *   - Skips injection when a bd-prime message is still active in the session
 *     (covers /reload and /resume without duplicating context).
 *   - session_compact: re-arms — `bd prime` exists precisely to recover the
 *     workflow context that compaction drops.
 *   - `/beads` command: force a refresh; the injection lands on your next
 *     message.
 *
 * Silent no-op when `bd` is missing or no beads workspace resolves
 * (`bd where` fails), so this file is also safe to symlink into
 * ~/.pi/agent/extensions/ for use in every repo.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PRIME_TYPE = "bd-prime";

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

export default function (pi: ExtensionAPI) {
  let pending: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    pending = primeActive(ctx) ? undefined : ((await bdPrime(ctx.cwd)) ?? undefined);
  });

  // Compaction summarises away the injected context — re-arm so the next
  // message re-primes (mirrors the Codex Pre/PostCompact hook pair).
  pi.on("session_compact", async (_event, ctx) => {
    pending = (await bdPrime(ctx.cwd)) ?? undefined;
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
    description: "Refresh Beads (bd) context — injects `bd prime` output on your next message",
    handler: async (_args, ctx) => {
      pending = (await bdPrime(ctx.cwd)) ?? undefined;
      if (pending !== undefined) {
        if (ctx.hasUI) ctx.ui.notify("Beads context armed — injecting on your next message.", "info");
      } else if (ctx.hasUI) {
        ctx.ui.notify("No Beads workspace found (`bd where` failed).", "error");
      }
    },
  });
}
