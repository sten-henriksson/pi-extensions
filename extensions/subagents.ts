/**
 * subagents.ts — one minimal delegation tool.
 *
 * `subagent` handles both execution backends:
 *   mode="text"  — direct, tool-free cheap-model completion for supplied text/files
 *   mode="agent" — isolated read-only pi child for repository inspection
 *
 * Give it one task for a narrow delegation, or several independent tasks to
 * run in parallel. Model tier and execution mode are selected per task.
 *
 * Config: ~/.pi/agent/subagents.json
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "text" | "agent";
type Tier = "cheap" | "medium" | "strong";

interface TierConfig {
	textModel: string | null;
	agentModel: string | null;
	enabled?: boolean;
}

interface Config {
	tiers: Record<Tier, TierConfig>;
	defaultTier: Tier;
	tools: string[];
	writeTools: string[];
	maxConcurrency: number;
	maxFileChars: number;
	timeoutMs: number;
}

const DEFAULT_CONFIG: Config = {
	tiers: {
		cheap: { textModel: null, agentModel: null },
		medium: { textModel: null, agentModel: null },
		strong: { textModel: null, agentModel: null },
	},
	defaultTier: "medium",
	tools: ["read", "grep", "ls", "find"],
	writeTools: ["read", "grep", "ls", "find", "edit", "write", "bash"],
	maxConcurrency: 2,
	maxFileChars: 60_000,
	timeoutMs: 15 * 60_000,
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "subagents.json");

function loadConfig(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		const rawTiers = raw.tiers ?? {};
		return {
			...DEFAULT_CONFIG,
			...raw,
			tiers: {
				cheap: { ...DEFAULT_CONFIG.tiers.cheap, ...(rawTiers.cheap ?? {}) },
				medium: { ...DEFAULT_CONFIG.tiers.medium, ...(rawTiers.medium ?? {}) },
				strong: { ...DEFAULT_CONFIG.tiers.strong, ...(rawTiers.strong ?? {}) },
			},
		};
	} catch {
		return { ...DEFAULT_CONFIG, tiers: { ...DEFAULT_CONFIG.tiers } };
	}
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n\n[...truncated ${s.length - max} chars]`;
}

function resolveModel(ctx: ExtensionContext, spec: string | null) {
	if (!spec) return ctx.model;
	const slash = spec.indexOf("/");
	if (slash < 1) return ctx.model;
	try {
		return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) ?? ctx.model;
	} catch {
		return ctx.model;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const runtime = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(runtime) ? { command: "pi", args } : { command: process.execPath, args };
}

function readFiles(ctx: ExtensionContext, files: string[], budget: number) {
	const chunks: string[] = [];
	const warnings: string[] = [];
	const root = path.resolve(ctx.cwd);
	let used = 0;
	for (const rel of files) {
		const file = path.resolve(root, rel);
		if (file !== root && !file.startsWith(root + path.sep)) {
			warnings.push(`${rel}: outside cwd, refused`);
			continue;
		}
		if (used >= budget) {
			warnings.push(`${rel}: skipped; file budget exhausted`);
			continue;
		}
		try {
			const text = clip(fs.readFileSync(file, "utf8"), budget - used);
			used += text.length;
			chunks.push(`<file path="${rel}">\n${text}\n</file>`);
		} catch (e: any) {
			warnings.push(`${rel}: ${e?.message ?? "unreadable"}`);
		}
	}
	return { text: chunks.join("\n\n"), warnings };
}

interface TaskSpec {
	task: string;
	name?: string;
	tier?: Tier;
	mode?: Mode;
	input?: string;
	files?: string[];
	json?: boolean;
	maxTokens?: number;
	cwd?: string;
	write?: boolean;
	tools?: string[];
}

interface TaskResult {
	name: string;
	tier: Tier;
	mode: Mode;
	model: string | null;
	output: string;
	warnings: string[];
	/** Compact child activity trail: tool + safe argument summary, never tool output/thinking. */
	activity: string[];
	exitCode: number;
	stderr: string;
	usage: { input: number; output: number; cost: number; turns: number };
	ms: number;
}

function makeResult(spec: TaskSpec, index: number, tier: Tier, mode: Mode, model: string | null): TaskResult {
	return {
		name: spec.name ?? `task${index + 1}`,
		tier,
		mode,
		model,
		output: "",
		warnings: [],
		activity: [],
		exitCode: 0,
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		ms: 0,
	};
}

async function runText(
	ctx: ExtensionContext,
	cfg: Config,
	spec: TaskSpec,
	index: number,
	tier: Tier,
	modelSpec: string | null,
	signal: AbortSignal | undefined,
): Promise<TaskResult> {
	const started = Date.now();
	const model: any = resolveModel(ctx, modelSpec);
	const result = makeResult(spec, index, tier, "text", modelSpec);
	if (!model) throw new Error("subagent[text]: no model available");

	const sections = [`<task>\n${spec.task}\n</task>`];
	if (spec.files?.length) {
		const files = readFiles(ctx, spec.files, cfg.maxFileChars);
		if (files.text) sections.push(files.text);
		result.warnings.push(...files.warnings);
	}
	if (spec.input) sections.push(`<input>\n${clip(spec.input, cfg.maxFileChars)}\n</input>`);

	const system =
		"You are a fast worker handling a narrow delegated subtask. Answer only what was requested; " +
		"do not restate the task, add preamble, or offer more work." +
		(spec.json ? " Respond with one valid JSON object only, without markdown fences or prose." : "");
	const ctrl = new AbortController();
	const abort = () => ctrl.abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => ctrl.abort(new Error("subagent[text]: timed out")), cfg.timeoutMs);
	try {
		const response: any = await ctx.modelRegistry.complete(
			model,
			{
				messages: [{
					role: "user" as const,
					content: [{ type: "text" as const, text: `<instructions>\n${system}\n</instructions>\n\n${sections.join("\n\n")}` }],
					timestamp: Date.now(),
				}],
			},
			{ maxTokens: spec.maxTokens ?? 4096, signal: ctrl.signal, cacheRetention: "none" },
		);
		result.output = (response.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim() || "(empty response)";
		result.usage = {
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cost: response.usage?.cost?.total ?? 0,
			turns: 1,
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		result.ms = Date.now() - started;
	}
	return result;
}

function summarizeToolAction(tool: string, args: any): string {
	if (!args || typeof args !== "object") return tool;
	// Paths and a clipped command/pattern are useful oversight; never surface
	// file contents, tool results, or the child's hidden reasoning.
	const fields = ["path", "query", "pattern", "command", "cwd"]
		.filter((key) => args[key] !== undefined)
		.map((key) => `${key}=${JSON.stringify(String(args[key])).slice(0, 180)}`);
	return fields.length ? `${tool} ${fields.join(" ")}` : tool;
}

function runAgent(
	ctx: ExtensionContext,
	cfg: Config,
	spec: TaskSpec,
	index: number,
	tier: Tier,
	modelSpec: string | null,
	signal: AbortSignal | undefined,
	onProgress: (result: TaskResult) => void,
): Promise<TaskResult> {
	const started = Date.now();
	const result = makeResult(spec, index, tier, "agent", modelSpec);
	const tools = spec.tools?.length ? spec.tools : spec.write ? cfg.writeTools : cfg.tools;
	const args = ["--mode", "json", "-p", "--no-session", "--tools", tools.join(",")];
	if (modelSpec) args.push("--model", modelSpec);
	args.push(
		`Task: ${spec.task}\n\nYou are an isolated delegated agent. Do not ask questions; state any necessary assumption and continue. ` +
			"Return a concise report with paths/evidence for what you found or changed.",
	);

	return new Promise((resolve) => {
		const inv = getPiInvocation(args);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(inv.command, inv.args, {
				cwd: spec.cwd ? path.resolve(ctx.cwd, spec.cwd) : ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e: any) {
			result.exitCode = 1;
			result.stderr = String(e?.message ?? e);
			result.ms = Date.now() - started;
			resolve(result);
			return;
		}
		let buffer = "";
		const parse = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "tool_execution_start") {
					result.activity.push(summarizeToolAction(event.toolName ?? "tool", event.args));
					onProgress(result);
					return;
				}
				if (event.type === "tool_execution_end" && event.isError) {
					result.activity.push(`${event.toolName ?? "tool"} FAILED`);
					onProgress(result);
					return;
				}
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				const msg = event.message;
				result.usage.turns++;
				result.usage.input += msg.usage?.input || 0;
				result.usage.output += msg.usage?.output || 0;
				result.usage.cost += msg.usage?.cost?.total || 0;
				const text = (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
				if (text) {
					result.output = text;
					onProgress(result);
				}
			} catch {
				// Non-JSON stdout from a child is irrelevant to its final report.
			}
		};
		proc.stdout?.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) parse(line);
		});
		proc.stderr?.on("data", (d) => { result.stderr += d.toString(); });
		const timer = setTimeout(() => {
			result.stderr += `\n[timeout after ${cfg.timeoutMs}ms]`;
			proc.kill("SIGTERM");
		}, cfg.timeoutMs);
		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
		};
		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		proc.on("error", (e) => { result.stderr += String(e); result.exitCode = 1; });
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) parse(buffer);
			result.exitCode = code ?? 0;
			result.ms = Date.now() - started;
			resolve(result);
		});
	});
}

async function runAll(
	ctx: ExtensionContext,
	cfg: Config,
	specs: TaskSpec[],
	limit: number,
	signal: AbortSignal | undefined,
	onProgress: (result: TaskResult) => void,
): Promise<TaskResult[]> {
	const results = new Array<TaskResult>(specs.length);
	let next = 0;
	const worker = async () => {
		while (next < specs.length) {
			const index = next++;
			const spec = specs[index];
			const tier = spec.tier ?? cfg.defaultTier;
			const mode = spec.mode ?? (spec.input || spec.files?.length ? "text" : "agent");
			const models = cfg.tiers[tier];
			results[index] = mode === "text"
				? await runText(ctx, cfg, spec, index, tier, models.textModel, signal)
				: await runAgent(ctx, cfg, spec, index, tier, models.agentModel, signal, onProgress);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, specs.length)) }, worker));
	return results;
}

function render(results: TaskResult[], done: boolean): string {
	const total = results.reduce((a, r) => ({
		input: a.input + (r?.usage.input ?? 0), output: a.output + (r?.usage.output ?? 0), cost: a.cost + (r?.usage.cost ?? 0),
	}), { input: 0, output: 0, cost: 0 });
	const reports = results.filter(Boolean).map((r) => {
		const status = r.ms ? (r.exitCode === 0 ? `${(r.ms / 1000).toFixed(1)}s` : `FAILED (exit ${r.exitCode})`) : "running...";
		const model = r.model?.split("/").pop() ?? "session model";
		const warnings = r.warnings.length ? `\n\nWarnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "";
		const activity = r.activity.length
			? `\n\nActivity:\n${r.activity.slice(0, 12).map((a) => `- ${a}`).join("\n")}${r.activity.length > 12 ? `\n- … ${r.activity.length - 12} more action(s)` : ""}`
			: "";
		const stderr = r.exitCode !== 0 && r.stderr ? `\n\nstderr:\n\`\`\`\n${clip(r.stderr, 1500)}\n\`\`\`` : "";
		return `## ${r.name} [${r.tier}/${r.mode} · ${model}] — ${status}\n\n${r.output || "(no output yet)"}${activity}${warnings}${stderr}`;
	}).join("\n\n---\n\n");
	return reports + (done ? `\n\n---\nsubagent: ${results.length} task(s), ${total.input} in, ${total.output} out, $${total.cost.toFixed(4)}` : "");
}

function makeTool() {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate one or more self-contained tasks to isolated workers, in parallel. " +
			"mode='text' makes one tool-free model call for supplied input/files; mode='agent' spawns a read-only pi child to inspect the repo. " +
			"Choose tier='cheap' for lookup/mechanical work, 'medium' for ordinary work, or 'strong' for hard review/design reasoning. " +
			"Children see none of this conversation; write is disabled unless explicitly enabled.",
		promptSnippet: "Delegate tasks to cheap/medium/strong workers; parallelize independent work",
		promptGuidelines: [
			"Use subagent only when work can run in parallel with other independent tasks, or when it is a genuinely cheap offload: processing supplied text over ~50 lines with mode='text', or broad repo recon that would otherwise require multiple parent search/read calls with mode='agent'.",
			"Do not use subagent for one trivial action, a known-path read, or a single quick grep; do that directly. Do not delegate work that needs this conversation's context, subtle judgement by the parent, or a dependency on another task's result.",
			"When 2 or more tasks are independent, issue one subagent call with multiple tasks so they run in parallel; choose cheap for lookup/mechanical work, medium for ordinary work, and strong only for hard review/design critique.",
			"Set write:true only for a subagent task that must modify files. Give every delegated task a standalone brief with paths and acceptance criteria because the child sees none of this conversation.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				task: Type.String({ description: "Self-contained instruction; this worker sees no conversation history." }),
				name: Type.Optional(Type.String({ description: "Short report label, e.g. 'audit-auth'." })),
				tier: Type.Optional(StringEnum(["cheap", "medium", "strong"] as const, { description: "Model tier; default is configured medium." })),
				mode: Type.Optional(StringEnum(["text", "agent"] as const, { description: "text = direct no-tool completion; agent = isolated repo-inspecting pi child. Inferred from input/files when omitted." })),
				input: Type.Optional(Type.String({ description: "Inline material to process (text mode)." })),
				files: Type.Optional(Type.Array(Type.String(), { description: "Files relative to cwd to inline (text mode)." })),
				json: Type.Optional(Type.Boolean({ description: "Require one JSON object response (text mode)." })),
				maxTokens: Type.Optional(Type.Number({ description: "Response token cap for text mode; default 4096." })),
				cwd: Type.Optional(Type.String({ description: "Child working directory relative to cwd (agent mode)." })),
				write: Type.Optional(Type.Boolean({ description: "Allow edit/write/bash for this child; default false." })),
				tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit tool allowlist for this child (agent mode)." })),
			}), { description: "One task, or independent tasks to run in parallel." }),
			maxConcurrency: Type.Optional(Type.Number({ description: "Maximum concurrent workers; default configured as 2." })),
		}),
		async execute(_id, params: any, signal, onUpdate, ctx: any) {
			const specs: TaskSpec[] = params.tasks ?? [];
			if (!specs.length) throw new Error("subagent: no tasks given");
			const cfg = loadConfig();
			for (const spec of specs) {
				const tier = spec.tier ?? cfg.defaultTier;
				if (cfg.tiers[tier].enabled === false) throw new Error(`subagent: tier ${tier} is disabled`);
			}
			const progress = new Map<string, TaskResult>();
			const update = (r: TaskResult) => {
				progress.set(r.name, r);
				onUpdate?.({ content: [{ type: "text", text: render([...progress.values()], false) }] });
			};
			const results = await runAll(ctx, cfg, specs, params.maxConcurrency ?? cfg.maxConcurrency, signal, update);
			return {
				content: [{ type: "text" as const, text: render(results, true) }],
				details: { results: results.map((r) => ({ name: r.name, tier: r.tier, mode: r.mode, model: r.model, exitCode: r.exitCode, usage: r.usage, ms: r.ms })) },
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(makeTool());
	pi.registerCommand("subagents", {
		description: "Show subagent tier configuration",
		handler: async (_args: string, ctx: any) => {
			const cfg = loadConfig();
			const lines = [`subagent config: ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? "" : " (using defaults)"}`];
			for (const tier of ["cheap", "medium", "strong"] as Tier[]) {
				const t = cfg.tiers[tier];
				lines.push(t.enabled === false
					? `  ${tier}: disabled`
					: `  ${tier}: text=${t.textModel ?? "session model"}; agent=${t.agentModel ?? "session model"}`);
			}
			lines.push(`  maxConcurrency: ${cfg.maxConcurrency}; read tools: ${cfg.tools.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
