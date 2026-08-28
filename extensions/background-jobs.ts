/**
 * Background Jobs for pi — kills the `nohup ... &` + `sleep N; tail` pattern.
 *
 * Session-log evidence (2026-08-18): one 24h session spent 3.3h inside 45
 * `sleep` polls across 26 hand-rolled background jobs, and lost two jobs
 * entirely to broken backgrounding chains. This extension gives the agent
 * a real job primitive:
 *
 *   bg_run    — start a detached job, returns job id + log file instantly
 *   bg_wait   — block (bounded) for a job; returns exit code + tail when done,
 *               or "still running" + progress tail on timeout (NOT an error)
 *   bg_logs   — tail a job's log
 *   bg_list   — all jobs with status
 *   bg_kill   — kill a job's whole process group
 *
 * When a job exits, a completion message (exit code, duration, tail) is
 * injected into the conversation automatically — even mid-turn — so the
 * agent never needs to poll with sleeps.
 *
 * Jobs survive pi restarts: state is persisted via appendEntry and re-attached
 * on session_start by pid probe. Log files live under $TMPDIR/pi-bg-jobs/.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import process from "node:process";
import { backgroundShellCommand } from "./background-jobs-shell.ts";

interface Job {
	id: number;
	name: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	exitCode: number | null; // null = running
	done: boolean;
	endedAt?: number;
	reported: boolean; // result already delivered via bg_wait
	notified: boolean; // completion notification sent
	killed: boolean; // terminated via bg_kill
	timer?: ReturnType<typeof setInterval>;
}

const jobs = new Map<number, Job>();
let nextId = 1;
let alive = true; // false once session_shutdown fired — never touch pi APIs after
// Some Windows shells expose TEMP as an unusable 8.3-style path. Prefer the
// canonical local-app-data location for log files on Windows.
const LOG_DIR = process.platform === "win32" && process.env.LOCALAPPDATA
	? join(process.env.LOCALAPPDATA, "Temp", "pi-bg-jobs")
	: join(tmpdir(), "pi-bg-jobs");
const IS_WINDOWS = process.platform === "win32";
const WINDOWS_RUNNER_PATH = fileURLToPath(new URL("./background-jobs-windows-runner.cjs", import.meta.url));
let piRef: ExtensionAPI | undefined;
let persistFn: (() => void) | undefined;

function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Read the last `lines` lines of a file (bounded: last 64KB). */
function tailFile(path: string, lines = 20): string {
	try {
		if (!existsSync(path)) return "(no output yet)";
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const len = Math.min(size, 65536);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			const all = buf.toString("utf8").split("\n").filter((l) => l !== "");
			return all.slice(-lines).join("\n") || "(no output yet)";
		} finally {
			closeSync(fd);
		}
	} catch {
		return "(log unreadable)";
	}
}

function findJob(idOrName: string): Job | undefined {
	const n = Number(idOrName);
	if (!Number.isNaN(n) && jobs.has(n)) return jobs.get(n);
	for (const j of jobs.values()) if (j.name === idOrName) return j;
	return undefined;
}

function jobLine(j: Job): string {
	const state = j.done ? `exited ${j.exitCode}` : "RUNNING";
	const dur = j.done && j.endedAt ? fmtDur(j.endedAt - j.startedAt) : fmtDur(Date.now() - j.startedAt);
	return `[${j.id}] ${j.name} — ${state} after ${dur} :: ${j.command}`;
}

/** Parse the sentinel line the wrapper writes: `__BG_EXIT_<code>`. */
function sentinelExit(path: string): number | null {
	const t = tailFile(path, 1);
	const m = t.match(/^__BG_EXIT_(-?\d+)$/);
	return m ? Number(m[1]) : null;
}

/** Single completion path: mark done, persist, notify the conversation.
 * `notifyDelayMs` (re-attach path) lets a simultaneously-arriving user
 * prompt win the first turn; the notification follows as followUp. */
function finishJob(j: Job, exitCode: number, notifyDelayMs = 0) {
	if (j.done) return;
	j.done = true;
	j.exitCode = exitCode;
	j.endedAt = Date.now();
	if (j.timer) clearInterval(j.timer);
	try {
		persistFn?.();
	} catch {
		// Stale extension ctx (session already torn down) — skip persistence.
	}
	const notify = () => {
		if (j.notified || !piRef || !alive) return;
		j.notified = true;
		const tail = tailFile(j.logFile, 15);
		const fate = j.killed ? "killed by bg_kill" : `exited ${exitCode}`;
		try {
			piRef.sendMessage(
				{
					customType: "bg-job",
					content:
						`[bg] job ${j.id} "${j.name}" ${fate} after ${fmtDur(j.endedAt - j.startedAt)}.\n` +
						`command: ${j.command}\nlast lines:\n${tail}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
				// Session runtime already torn down (print mode exit, /reload,
				// session switch). The job kept running detached; its state entry
				// stays done:false and the next session_start re-attaches + notifies.
				j.notified = false;
			}
	};
	if (notifyDelayMs > 0) setTimeout(notify, notifyDelayMs);
	else notify();
}

export default function (pi: ExtensionAPI) {
	piRef = pi;
	alive = true;
	persistFn = () => {
		const state = [...jobs.values()].map((j) => ({
			id: j.id,
			name: j.name,
			command: j.command,
			cwd: j.cwd,
			pid: j.pid,
			logFile: j.logFile,
			startedAt: j.startedAt,
			exitCode: j.exitCode,
			done: j.done,
		}));
		pi.appendEntry("bg-jobs-state", { jobs: state, nextId });
	};

	function watch(j: Job) {
		// Poll pid every 2s: works for detached children where 'exit' handlers
		// are unreliable, and after re-attach we have no child handle at all.
		j.timer = setInterval(() => {
			if (!alive) {
				if (j.timer) clearInterval(j.timer);
				return;
			}
			try {
				process.kill(j.pid, 0);
			} catch {
				finishJob(j, sentinelExit(j.logFile) ?? -1);
			}
		}, 2000);
	}

	// Stop all watchers when the session runtime goes away; jobs themselves
	// keep running (they are detached). The next session_start re-attaches.
	pi.on("session_shutdown", () => {
		alive = false;
		for (const j of jobs.values()) if (j.timer) clearInterval(j.timer);
	});

	// Re-attach after restart/reload: probe pids, keep results, resume watching.
	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === "bg-jobs-state" && e.data) {
				const d = e.data as {
					jobs: Array<Pick<Job, "id" | "name" | "command" | "cwd" | "pid" | "logFile" | "startedAt" | "exitCode" | "done">>;
					nextId: number;
				};
				nextId = d.nextId ?? 1;
				for (const r of d.jobs ?? []) {
					if (jobs.has(r.id)) continue;
					const j: Job = { ...r, reported: false, notified: r.done ?? false };
					jobs.set(j.id, j);
					if (!j.done) {
						try {
							process.kill(j.pid, 0); // still running?
							watch(j);
						} catch {
							finishJob(j, sentinelExit(j.logFile) ?? -1, 2500); // died while away
						}
					}
				}
				break;
			}
		}
	});

	pi.registerTool({
		name: "bg_run",
		label: "Background Run",
		description:
			"Start a long-running shell command as a background job and return immediately with a job id and log file. Use for anything expected to run >2 minutes (cargo test, just check-all, builds, dev servers, watchers). Completion is reported automatically in the conversation — no sleep-polling needed.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run (bash -c on POSIX; cmd.exe /c on Windows)" }),
			name: Type.Optional(Type.String({ description: "Short label, e.g. 'gate', 'vttd-tests'. Defaults to first word of command." })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: pi cwd)" })),
		}),
		promptGuidelines: [
			"Use bg_run instead of `nohup ... &` or `command & disown` for long-running work (test gates, builds, servers) — it returns a job id instantly and reports completion automatically.",
			"Never poll background work with `sleep N; tail log` in bash; call bg_wait (bounded) or bg_logs instead.",
		],
		async execute(_toolCallId, params) {
			mkdirSync(LOG_DIR, { recursive: true });
			const id = nextId++;
			const name = params.name?.trim() || params.command.trim().split(/\s+/)[0].slice(0, 24);
			const logFile = join(LOG_DIR, `job-${id}-${Date.now()}.log`);
			const cwd = params.cwd || process.cwd();
			// The wrapper appends a sentinel line with the exact exit code so a
			// re-attached session can still recover it from the log alone. It uses
			// cmd.exe syntax on Windows and bash syntax elsewhere.
			const shell = backgroundShellCommand(params.command, logFile, process.platform, process.env.ComSpec, WINDOWS_RUNNER_PATH);
			const out = openSync(logFile, "a");
			const child = spawn(shell.executable, shell.args, {
				cwd,
				stdio: ["ignore", out, out],
				detached: true,
				windowsHide: true,
			});
			closeSync(out);
			child.unref();
			const j: Job = {
				id,
				name,
				command: params.command,
				cwd,
				pid: child.pid!,
				logFile,
				startedAt: Date.now(),
				exitCode: null,
				done: false,
				reported: false,
				notified: false,
				killed: false,
			};
			jobs.set(id, j);
			watch(j);
			try {
				persistFn?.();
			} catch {
				// Session already tearing down — best effort only.
			}
			return {
				content: [
					{
						type: "text",
						text:
							`started job ${id} "${name}" (pid ${j.pid})\nlog: ${j.logFile}\n` +
							`You will be notified when it exits. Check progress with bg_logs/bg_list, or block with bg_wait.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "bg_wait",
		label: "Background Wait",
		description:
			"Wait (bounded) for a background job. Returns exit code + tail when finished, or 'still running' + progress tail when the timeout elapses (not an error). Prefer doing other work while jobs run and letting the completion notification arrive.",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name" }),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to block (default 120, max 600)" })),
			tailLines: Type.Optional(Type.Number({ description: "Tail lines to include (default 20)" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const j = findJob(params.job);
			if (!j) return { content: [{ type: "text", text: `no job '${params.job}' (see bg_list)` }], isError: true };
			const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 120, 1), 600) * 1000;
			const deadline = Date.now() + timeoutMs;
			let lastUpdate = 0;
			while (!j.done) {
				if (signal?.aborted) break;
				if (Date.now() >= deadline) break;
				if (onUpdate && Date.now() - lastUpdate > 30000) {
					lastUpdate = Date.now();
					onUpdate({
						content: [
							{ type: "text", text: `still running (${fmtDur(Date.now() - j.startedAt)} elapsed)…\n${tailFile(j.logFile, 5)}` },
						],
					});
				}
				await new Promise((r) => setTimeout(r, 500));
			}
			const tail = tailFile(j.logFile, params.tailLines ?? 20);
			if (j.done) {
				j.reported = true;
				return {
					content: [
						{
							type: "text",
							text: `job ${j.id} "${j.name}" exited ${j.exitCode} after ${fmtDur((j.endedAt ?? Date.now()) - j.startedAt)}\n${tail}`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`job ${j.id} "${j.name}" STILL RUNNING after ${fmtDur(Date.now() - j.startedAt)} ` +
							`(wait timed out — not an error; do other work, call bg_wait again, or rely on the completion notification)\n` +
							`recent output:\n${tail}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Background Logs",
		description: "Show the tail of a background job's log.",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name" }),
			lines: Type.Optional(Type.Number({ description: "Tail lines (default 30)" })),
		}),
		async execute(_toolCallId, params) {
			const j = findJob(params.job);
			if (!j) return { content: [{ type: "text", text: `no job '${params.job}'` }], isError: true };
			return { content: [{ type: "text", text: `${jobLine(j)}\n${tailFile(j.logFile, params.lines ?? 30)}` }] };
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "Background Jobs",
		description: "List background jobs with status.",
		parameters: Type.Object({}),
		async execute() {
			const all = [...jobs.values()].sort((a, b) => a.id - b.id);
			return {
				content: [{ type: "text", text: all.length ? all.map(jobLine).join("\n") : "no background jobs" }],
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Kill",
		description: "Kill a running background job (whole process group).",
		parameters: Type.Object({
			job: Type.String({ description: "Job id or name" }),
		}),
		async execute(_toolCallId, params) {
			const j = findJob(params.job);
			if (!j) return { content: [{ type: "text", text: `no job '${params.job}'` }], isError: true };
			if (j.done) return { content: [{ type: "text", text: jobLine(j) }] };
			j.killed = true;
			if (IS_WINDOWS) {
				// Windows has no POSIX process groups. taskkill /T terminates the
				// wrapper and every child it created, which is the closest equivalent.
				const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /pid ${j.pid} /t /f`], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.unref();
				return { content: [{ type: "text", text: `sent taskkill /T /F to job ${j.id} "${j.name}" (pid ${j.pid})` }] };
			}
			try {
				process.kill(-j.pid, "SIGTERM"); // negative pid = process group
			} catch {
				try {
					process.kill(j.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
			return { content: [{ type: "text", text: `sent SIGTERM to job ${j.id} "${j.name}" (pgid ${j.pid})` }] };
		},
	});

	pi.registerCommand("bg", {
		description: "List background jobs",
		handler: async (_args, ctx) => {
			const all = [...jobs.values()].sort((a, b) => a.id - b.id);
			ctx.ui.notify(all.length ? all.map(jobLine).join("\n") : "no background jobs", "info");
		},
	});
}
