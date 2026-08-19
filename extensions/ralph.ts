/**
 * ralph — long-running agent loops for iterative development.
 * Fork of tmustier/pi-ralph-wiggum (MIT), itself a port of Geoffrey Huntley's
 * ralph-loop for Claude Code. Upstream: https://github.com/tmustier/pi-extensions
 *
 * Fork addition — INDEPENDENT COMPLETION VERIFIER (glla's "bamboozle trap"
 * fix, MiMo Code's Goal mechanism): the completion marker no longer completes
 * the loop by itself. On every completion attempt, a judge model — ideally a
 * DIFFERENT model than the working agent (.ralph/judge.json {"model":
 * "provider/model-id"}) — reads the task file's verification record and the
 * agent's claim, and decides whether completion is demonstrated. Rejected
 * completions re-prompt the agent with the verifier's reasons (max 3
 * rejections, then the loop completes to avoid a verify-loop).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const RALPH_DIR = ".ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Commands run, working directories, relevant environment variables, outputs, and preserved artifacts

## Final Verification
- Exact monitor-rerunnable command: <command>
- Working directory: <path>
- Required preserved artifacts: <paths>
- Result: <output summary>

## Notes
(Update this as you work)
`;

const DEFAULT_COMPLETION_GATE = `COMPLETION GATE

Do not output ${COMPLETE_MARKER} based only on checked checklist items.
Before completion:
1. Run a final verification command that an external monitor can rerun from the same worktree in a fresh shell.
2. Record the exact command, working directory, relevant environment variables, and output summary in the task file.
3. Preserve every artifact required by that command, including build directories, generated libraries, virtualenvs, caches, or copied dylibs.
4. If cleanup removes required artifacts, recreate them or update the final command before completing.
5. If the final command cannot be made externally rerunnable, mark the item blocked/deferred instead of complete.`;

const DEFAULT_STALE_PROMPT_GUARD = `STALE PROMPT GUARD

Before doing any work from a Ralph prompt, reload the loop state file named in the prompt (usually .ralph/<name>.state.json).
If the state says \"status\": \"completed\", do not edit files, do not run task commands, and do not call ralph_done. Reply briefly that the stale prompt was ignored because the loop is already completed.`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";

interface LoopState {
	name: string;
	taskFile: string;
	iteration: number;
	maxIterations: number;
	itemsPerIteration: number; // Prompt hint only - "process N items per turn"
	reflectEvery: number; // Reflect every N iterations
	reflectInstructions: string;
	active: boolean; // Backwards compat
	status: LoopStatus;
	startedAt: string;
	completedAt?: string;
	lastReflectionAt: number; // Last iteration we reflected at
	ownerSessionId?: string; // Session that currently owns automatic prompt injection for this loop
	verifyRejections?: number; // Times the independent verifier has rejected a completion attempt
}

const VERIFY_REJECT_CAP = 3;

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };

export default function (pi: ExtensionAPI) {
	let currentLoop: string | null = null;

	// --- File helpers ---

	const ralphDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, RALPH_DIR);
	const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
	const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
	const sessionId = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId?.();

	function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		return path.join(dir, `${sanitize(name)}${ext}`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function safeMtimeMs(filePath: string): number {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return 0;
		}
	}

	function tryRemoveDir(dirPath: string): boolean {
		try {
			if (fs.existsSync(dirPath)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	// --- State management ---

	function migrateState(raw: Partial<LoopState> & { name: string }): LoopState {
		if (!raw.status) raw.status = raw.active ? "active" : "paused";
		raw.active = raw.status === "active";
		// Migrate old field names
		if ("reflectEveryItems" in raw && !raw.reflectEvery) {
			raw.reflectEvery = (raw as any).reflectEveryItems;
		}
		if ("lastReflectionAtItems" in raw && raw.lastReflectionAt === undefined) {
			raw.lastReflectionAt = (raw as any).lastReflectionAtItems;
		}
		return raw as LoopState;
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		const content = tryRead(getPath(ctx, name, ".state.json", archived));
		return content ? migrateState(JSON.parse(content)) : null;
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		const filePath = getPath(ctx, state.name, ".state.json", archived);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateState(JSON.parse(content)) : null;
			})
			.filter((s): s is LoopState => s !== null);
	}

	function isOwnedByCurrentSession(ctx: ExtensionContext, state: LoopState): boolean {
		const currentSessionId = sessionId(ctx);
		return Boolean(currentSessionId && state.ownerSessionId === currentSessionId);
	}

	function getCurrentOwnedState(ctx: ExtensionContext): LoopState | null {
		if (!currentLoop) return null;
		const state = loadState(ctx, currentLoop);
		if (!state || !isOwnedByCurrentSession(ctx, state)) {
			currentLoop = null;
			return null;
		}
		return state;
	}

	function findActiveOwnedState(ctx: ExtensionContext): LoopState | undefined {
		return listLoops(ctx).find((state) => state.status === "active" && isOwnedByCurrentSession(ctx, state));
	}

	// --- Loop state transitions ---

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.active = false;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	// --- Independent completion verifier (fork addition) ---

	interface Verdict {
		satisfied: boolean;
		reasons: string;
	}

	function parseVerdict(raw: string): Verdict | null {
		const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const s = (fence ? fence[1] : raw).trim();
		const start = s.indexOf("{");
		const end = s.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			const v = JSON.parse(s.slice(start, end + 1));
			if (typeof v?.satisfied !== "boolean") return null;
			return { satisfied: v.satisfied, reasons: String(v.reasons ?? "").slice(0, 1200) };
		} catch {
			return null;
		}
	}

	/**
	 * Judge the completion claim against the task file's verification record.
	 * Judge model: .ralph/judge.json {"model":"provider/id"} — SHOULD differ
	 * from the working model (independent verifier). Falls back to the active
	 * model (still an independent context/prompt, same weights).
	 * Fails OPEN (satisfied) on model/parse errors so verifier outages can't
	 * wedge the loop; rejections are capped by VERIFY_REJECT_CAP anyway.
	 */
	async function verifyCompletion(ctx: ExtensionContext, state: LoopState, assistantClaim: string): Promise<Verdict> {
		const taskPath = path.resolve(ctx.cwd, state.taskFile);
		let taskContent = "(task file unreadable)";
		try {
			taskContent = fs.readFileSync(taskPath, "utf-8").slice(0, 12000);
		} catch {
			/* judge with what we have */
		}

		let judge: any = ctx.model;
		try {
			const cfgPath = path.join(ralphDir(ctx), "judge.json");
			if (fs.existsSync(cfgPath)) {
				const spec = JSON.parse(fs.readFileSync(cfgPath, "utf-8"))?.model;
				const slash = String(spec ?? "").indexOf("/");
				if (slash > 0) judge = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) ?? judge;
			}
		} catch {
			/* fall back to active model */
		}
		const judgeId = judge ? `${judge.provider}/${judge.id}` : "active-model";

		const prompt = `You are an INDEPENDENT completion verifier for an autonomous coding loop. You did NOT do this work; your job is to catch premature or unverified completion claims (the "bamboozle trap": the agent that wrote the code also says it is done).

Loop: ${state.name}

TASK FILE (goals, checklist, and the required "Final Verification" record — exact command, working directory, artifacts, output summary):
<task_file>
${taskContent}
</task_file>

AGENT'S COMPLETION CLAIM (its final message):
<claim>
${assistantClaim.slice(0, 4000)}
</claim>

Decide STRICTLY by the evidence:
- satisfied=true ONLY if the task file's Final Verification record shows a concrete, monitor-rerunnable command AND its recorded output demonstrates the goals (not just checked boxes, not promises).
- If the record is missing, placeholder, un-rerunnable, or its output does not demonstrate the goals — satisfied=false.
- Never evaluate from the agent's confidence alone.

Respond with a single JSON object only:
{"satisfied": true|false, "reasons": "one short paragraph: what evidence checked out, or what is missing/unproven"}`;

		try {
			const response = await ctx.modelRegistry.complete(
				judge,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 1024, cacheRetention: "none" },
			);
			const raw = response.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			const verdict = parseVerdict(raw);
			console.error(`[ralph] verifier (${judgeId}): ${verdict ? (verdict.satisfied ? "SATISFIED" : "REJECTED") : "unparseable (fail-open)"} — ${verdict?.reasons?.slice(0, 200) ?? raw.slice(0, 200)}`);
			return verdict ?? { satisfied: true, reasons: "(verifier output unparseable — fail-open)" };
		} catch (err: any) {
			console.error(`[ralph] verifier error (fail-open): ${err?.message ?? err}`);
			return { satisfied: true, reasons: `(verifier error: ${err?.message ?? err})` };
		}
	}

	function completeLoop(ctx: ExtensionContext, state: LoopState, banner: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		pi.sendUserMessage(banner, { deliverAs: "followUp" });
	}

	function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	// --- UI ---

	function formatLoop(l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		return `${l.name}: ${status} (iteration ${iter})`;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const state = getCurrentOwnedState(ctx);
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const reflection =
			state.reflectEvery > 0
				? ` · 🪞 reflect in ${state.reflectEvery - ((state.iteration - 1) % state.reflectEvery)}`
				: "";
		const title = theme.fg("success", theme.bold("Ralph Wiggum"));
		const status = theme.fg(
			"dim",
			` · 🔁 ${state.name} · ${STATUS_ICONS[state.status]} ${state.status} · 🔢 ${state.iteration}${maxStr} · 📄 ${state.taskFile}${reflection} · Esc pause · msg resume · /ralph-stop stop`,
		);

		ctx.ui.setStatus("ralph", `${title}${status}`);
		ctx.ui.setWidget("ralph", undefined);
	}

	// --- Prompt building ---

	function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

		const parts = [header, ""];
		if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

		parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
		parts.push(`\n## Stale Prompt Guard\n\n${DEFAULT_STALE_PROMPT_GUARD}\n`);
		parts.push(`\n## Completion Gate\n\n${DEFAULT_COMPLETION_GATE}\n`);
		parts.push(`\n## Instructions\n`);
		parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n");
		parts.push(
			`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
		);

		if (state.itemsPerIteration > 0) {
			parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`);
			parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
		} else {
			parts.push(`1. Continue working on the task`);
		}
		parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
		parts.push(`3. When FULLY COMPLETE and the completion gate is satisfied, respond with: ${COMPLETE_MARKER}`);
		parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

		return parts.join("\n");
	}

	// --- Arg parsing ---

	function parseArgs(argsStr: string) {
		const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
		const result = {
			name: "",
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
		};

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--max-iterations" && next) {
				result.maxIterations = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--items-per-iteration" && next) {
				result.itemsPerIteration = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-every" && next) {
				result.reflectEvery = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-instructions" && next) {
				result.reflectInstructions = next.replace(/^"|"$/g, "");
				i++;
			} else if (!tok.startsWith("--")) {
				result.name = tok;
			}
		}
		return result;
	}

	// --- Commands ---

	const commands: Record<string, (rest: string, ctx: ExtensionContext) => void> = {
		start(rest, ctx) {
			const args = parseArgs(rest);
			if (!args.name) {
				ctx.ui.notify(
					"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
					"warning",
				);
				return;
			}

			const isPath = args.name.includes("/") || args.name.includes("\\");
			const loopName = isPath ? sanitize(path.basename(args.name, path.extname(args.name))) : args.name;
			const taskFile = isPath ? args.name : path.join(RALPH_DIR, `${loopName}.md`);

			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				ctx.ui.notify(`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`, "warning");
				return;
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			if (!fs.existsSync(fullPath)) {
				ensureDir(fullPath);
				fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
				ctx.ui.notify(`Created task file: ${taskFile}`, "info");
			}

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: args.maxIterations,
				itemsPerIteration: args.itemsPerIteration,
				reflectEvery: args.reflectEvery,
				reflectInstructions: args.reflectInstructions,
				active: true,
				status: "active",
				startedAt: existing?.startedAt || new Date().toISOString(),
				lastReflectionAt: 0,
				ownerSessionId: sessionId(ctx),
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			const content = tryRead(fullPath);
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${taskFile}`, "error");
				return;
			}
			pi.sendUserMessage(buildPrompt(state, content, false), { deliverAs: "followUp" });
		},

		stop(_rest, ctx) {
			const state = getCurrentOwnedState(ctx) ?? findActiveOwnedState(ctx);
			if (!state) {
				ctx.ui.notify("No active Ralph loop owned by this session", "warning");
				updateUI(ctx);
				return;
			}
			pauseLoop(ctx, state, `Paused Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},

		resume(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph resume <name>", "warning");
				return;
			}

			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "completed") {
				ctx.ui.notify(`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`, "warning");
				return;
			}

			// Pause this session's current loop if different. A loop transferred to
			// another session must not be mutated from the stale former owner.
			if (currentLoop && currentLoop !== loopName) {
				const curr = getCurrentOwnedState(ctx);
				if (curr) pauseLoop(ctx, curr);
			}

			state.status = "active";
			state.active = true;
			state.ownerSessionId = sessionId(ctx);
			state.iteration++;
			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			ctx.ui.notify(`Resumed: ${loopName} (iteration ${state.iteration})`, "info");

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${state.taskFile}`, "error");
				return;
			}

			const needsReflection =
				state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
			pi.sendUserMessage(buildPrompt(state, content, needsReflection), { deliverAs: "followUp" });
		},

		status(_rest, ctx) {
			const loops = listLoops(ctx);
			if (loops.length === 0) {
				ctx.ui.notify("No Ralph loops found.", "info");
				return;
			}
			ctx.ui.notify(`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		cancel(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
				return;
			}
			if (!loadState(ctx, loopName)) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			tryDelete(getPath(ctx, loopName, ".state.json"));
			ctx.ui.notify(`Cancelled: ${loopName}`, "info");
			updateUI(ctx);
		},

		archive(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph archive <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "active") {
				ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
				return;
			}

			if (currentLoop === loopName) currentLoop = null;

			const srcState = getPath(ctx, loopName, ".state.json");
			const dstState = getPath(ctx, loopName, ".state.json", true);
			ensureDir(dstState);
			if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			if (srcTask.startsWith(ralphDir(ctx)) && !srcTask.startsWith(archiveDir(ctx))) {
				const dstTask = getPath(ctx, loopName, ".md", true);
				if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
			}

			ctx.ui.notify(`Archived: ${loopName}`, "info");
			updateUI(ctx);
		},

		clean(rest, ctx) {
			const all = rest.trim() === "--all";
			const completed = listLoops(ctx).filter((l) => l.status === "completed");

			if (completed.length === 0) {
				ctx.ui.notify("No completed loops to clean", "info");
				return;
			}

			for (const loop of completed) {
				tryDelete(getPath(ctx, loop.name, ".state.json"));
				if (all) tryDelete(getPath(ctx, loop.name, ".md"));
				if (currentLoop === loop.name) currentLoop = null;
			}

			const suffix = all ? " (all files)" : " (state only)";
			ctx.ui.notify(
				`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
				"info",
			);
			updateUI(ctx);
		},

		list(rest, ctx) {
			const archived = rest.trim() === "--archived";
			const loops = listLoops(ctx, archived);

			if (loops.length === 0) {
				ctx.ui.notify(
					archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.",
					"info",
				);
				return;
			}

			const label = archived ? "Archived loops" : "Ralph loops";
			ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		nuke(rest, ctx) {
			const force = rest.trim() === "--yes";
			const warning =
				"This deletes all .ralph state, task, and archive files. External task files are not removed.";

			const run = () => {
				const dir = ralphDir(ctx);
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No .ralph directory found.", "info");
					return;
				}

				currentLoop = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) {
					ctx.ui.notify(ok ? "Removed .ralph directory." : "Failed to remove .ralph directory.", ok ? "info" : "error");
				}
				updateUI(ctx);
			};

			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop files?", warning).then((confirmed) => {
						if (confirmed) run();
					});
				} else {
					ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			run();
		},
	};

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = commands[cmd];
			if (handler) {
				handler(args.slice(cmd.length).trim(), ctx);
			} else {
				ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
				}
				return;
			}

			const state = getCurrentOwnedState(ctx) ?? findActiveOwnedState(ctx);
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("No active Ralph loop owned by this session", "warning");
				updateUI(ctx);
				return;
			}

			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	// --- Tool for agent self-invocation ---

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		description: "Start a long-running development loop. Use for complex multi-iteration tasks.",
		promptSnippet: "Start a persistent multi-iteration development loop with pacing and reflection controls.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
			itemsPerIteration: Type.Optional(Type.Number({ description: "Suggest N items per turn (0 = no limit)" })),
			reflectEvery: Type.Optional(Type.Number({ description: "Reflect every N iterations" })),
			maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 50)", default: 50 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = sanitize(params.name);
			const taskFile = path.join(RALPH_DIR, `${loopName}.md`);

			if (loadState(ctx, loopName)?.status === "active") {
				return { content: [{ type: "text", text: `Loop "${loopName}" already active.` }], details: {} };
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, params.taskContent, "utf-8");

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				active: true,
				status: "active",
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
				ownerSessionId: sessionId(ctx),
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			pi.sendUserMessage(buildPrompt(state, params.taskContent, false), { deliverAs: "followUp" });

			return {
				content: [{ type: "text", text: `Started loop "${loopName}" (max ${state.maxIterations} iterations).` }],
				details: {},
			};
		},
	});

	// Tool for agent to signal iteration complete and request next
	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		description: "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = getCurrentOwnedState(ctx);
			if (!state || state.status !== "active") {
				updateUI(ctx);
				return { content: [{ type: "text", text: "No active Ralph loop owned by this session." }], details: {} };
			}

			if (ctx.hasPendingMessages()) {
				return {
					content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }],
					details: {},
				};
			}

			// Increment iteration
			state.iteration++;

			// Check max iterations
			if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
				completeLoop(
					ctx,
					state,
					`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
				);
				return { content: [{ type: "text", text: "Max iterations reached. Loop stopped." }], details: {} };
			}

			const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
			if (needsReflection) state.lastReflectionAt = state.iteration;

			saveState(ctx, state);
			updateUI(ctx);

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				pauseLoop(ctx, state);
				return { content: [{ type: "text", text: `Error: Could not read task file: ${state.taskFile}` }], details: {} };
			}

			// Queue next iteration - use followUp so user can still interrupt
			pi.sendUserMessage(buildPrompt(state, content, needsReflection), { deliverAs: "followUp" });

			return {
				content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Next iteration queued.` }],
				details: {},
			};
		},
	});

	// --- Event handlers ---

	pi.on("before_agent_start", async (event, ctx) => {
		const state = getCurrentOwnedState(ctx);
		if (!state || state.status !== "active") {
			updateUI(ctx);
			return;
		}

		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;

		// Sticky goals: the queued iteration prompt (full task text) is
		// conversation-side and gets compacted away; this per-turn system-prompt
		// injection re-reads the task file so the goals survive compaction and
		// pick up live edits. Same pattern as mimo-memory's MEMORY.md injection.
		const taskPath = path.resolve(ctx.cwd, state.taskFile);
		let taskContent = "(task file unreadable — re-read it before working)";
		try {
			taskContent = fs.readFileSync(taskPath, "utf-8").slice(0, 6000);
			if (fs.readFileSync(taskPath, "utf-8").length > 6000) {
				taskContent += "\n…(truncated — read the full task file for the remainder)";
			}
		} catch {
			/* keep the placeholder */
		}

		let instructions = `You are in a Ralph loop. Task file: ${state.taskFile}\n`;
		instructions += `## Current Task (injected fresh each turn)\n\n${taskContent}\n\n`;
		instructions += `- Before doing work, reload .ralph/${state.name}.state.json; if status is completed, ignore this stale prompt and do not call ralph_done\n`;
		if (state.itemsPerIteration > 0) {
			instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
		}
		instructions += `- Update the task file as you progress\n`;
		instructions += `- Preserve artifacts needed by final verification\n`;
		instructions += `- Record an exact monitor-rerunnable final command before completion\n`;
		instructions += `- When FULLY COMPLETE and externally rerunnable: ${COMPLETE_MARKER}\n`;
		instructions += `- Otherwise, call ralph_done tool to proceed to next iteration`;

		return {
			systemPrompt: event.systemPrompt + `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = getCurrentOwnedState(ctx);
		if (!state || state.status !== "active") {
			updateUI(ctx);
			return;
		}

		// Check for completion marker
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";

		if (text.includes(COMPLETE_MARKER)) {
			// FORK: independent verifier gate — the marker is a claim, not a verdict
			const verdict = await verifyCompletion(ctx, state, text);
			if (!verdict.satisfied && (state.verifyRejections ?? 0) < VERIFY_REJECT_CAP) {
				state.verifyRejections = (state.verifyRejections ?? 0) + 1;
				saveState(ctx, state);
				const banner = `🧪 VERIFIER REJECTED completion (${state.verifyRejections}/${VERIFY_REJECT_CAP}) — loop "${state.name}" continues`;
				console.error(`[ralph] ${banner}`);
				if (ctx.hasUI) ctx.ui.notify(`${banner}\n${verdict.reasons}`, "warning");
				pi.sendUserMessage(
					`───────────────────────────────────────────────────────────────────────\n🧪 RALPH VERIFIER: completion NOT accepted (attempt ${state.verifyRejections}/${VERIFY_REJECT_CAP})\n───────────────────────────────────────────────────────────────────────\n\nAn independent verifier reviewed the task file's Final Verification record and rejected the completion claim:\n\n${verdict.reasons}\n\nContinue the loop: fix the gaps, run a concrete monitor-rerunnable final verification command, record its exact command + output in the task file, then try ${COMPLETE_MARKER} again. If the goals are genuinely unachievable, mark items blocked/deferred in the task file instead.`,
					{ deliverAs: "followUp" },
				);
				return;
			}
			const verifiedNote = verdict.satisfied ? "" : ` (verifier still unsatisfied after ${VERIFY_REJECT_CAP} rejections — completing anyway)`;
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations${verifiedNote}\n───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Check max iterations
		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Don't auto-continue - let the agent call ralph_done to proceed
		// This allows user's "stop" message to be processed first
	});

	pi.on("session_start", async (_event, ctx) => {
		const active = listLoops(ctx).filter((l) => l.status === "active");
		const owned = active.filter((state) => isOwnedByCurrentSession(ctx, state));

		// Rehydrate only loops that are owned by this Pi session. Older state
		// files do not have ownerSessionId, so a new unrelated session must use
		// /ralph resume <name> before Ralph injects loop instructions.
		if (!currentLoop && owned.length > 0) {
			const mostRecent = owned.reduce((best, candidate) => {
				const bestMtime = safeMtimeMs(getPath(ctx, best.name, ".state.json"));
				const candidateMtime = safeMtimeMs(getPath(ctx, candidate.name, ".state.json"));
				return candidateMtime > bestMtime ? candidate : best;
			});
			currentLoop = mostRecent.name;
		}

		if (active.length > 0 && ctx.hasUI) {
			const lines = active.map(
				(l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
			);
			ctx.ui.notify(`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`, "info");
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = getCurrentOwnedState(ctx);
		if (state) saveState(ctx, state);
	});
}
