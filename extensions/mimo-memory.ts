/**
 * mimo-memory — /dream and /distill for pi, after Xiaomi MiMo Code's
 * Evolution theme (session-scan → memory consolidation and skill distillation).
 *
 *   /dream [days]            consolidate recent session traces into MEMORY.md
 *   /distill [days]          mine repeated workflows → staged candidate skills
 *   /distill list            show staged candidates
 *   /distill install <name>  move a staged skill into .pi/skills (or global)
 *
 * MEMORY.md (project-local when trusted, else ~/.pi/agent/memory/) is injected
 * into the system prompt every turn. Flat single file per repo convention.
 * Detailed docs: README.md § mimo-memory.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * llm.ts — model resolution + complete() wrapper for dream/distill pipelines.
 *
 * MiMo principle: the distiller should be able to run on a *different* model
 * than the one that produced the traces (verifier independent of worker).
 * Config strings like "google/gemini-2.5-flash" pick the model; falls back
 * to the active session model when unset or not found.
 */


export interface CallOpts {
	purpose: string;
	modelSpec?: string | null;
	system?: string;
	user: string;
	maxTokens?: number;
	requireJson?: boolean;
	timeoutMs?: number;
}

export function resolveModel(ctx: ExtensionContext, spec?: string | null) {
	if (!spec) return ctx.model;
	const slash = spec.indexOf("/");
	if (slash < 0) return ctx.model;
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	try {
		return ctx.modelRegistry.find(provider, id) ?? ctx.model;
	} catch {
		return ctx.model;
	}
}

export async function callModel(ctx: ExtensionContext, opts: CallOpts): Promise<string> {
	const model = resolveModel(ctx, opts.modelSpec);
	if (!model) throw new Error(`[${opts.purpose}] no model available`);

	const system = (opts.system?.trim() ?? "") + (opts.requireJson ? "\n\nRespond with a single valid JSON object only. No markdown fences, no prose before or after." : "");

	const userText = system ? `<instructions>\n${system}\n</instructions>\n\n${opts.user}` : opts.user;

	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: userText }],
			timestamp: Date.now(),
		},
	];

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`${opts.purpose}: timed out`)), opts.timeoutMs ?? 10 * 60_000);

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages },
			{
				maxTokens: opts.maxTokens ?? 4096,
				signal: ctrl.signal,
				cacheRetention: "none",
			},
		);

		const text = response.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();

		if (!text) throw new Error(`${opts.purpose}: empty model response`);
		return text;
	} finally {
		clearTimeout(timer);
	}
}

/** Best-effort JSON extraction from a model response. Returns null on failure. */
export function parseJsonLoose(raw: string): any | null {
	if (!raw) return null;
	let s = raw.trim();
	// strip code fences
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) s = fence[1].trim();
	// slice from first { to last }
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	s = s.slice(start, end + 1);
	try {
		return JSON.parse(s);
	} catch {
		// last-ditch: remove trailing commas
		try {
			return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
		} catch {
			return null;
		}
	}
}

/**
 * corpus.ts — shared substrate for /dream and /distill:
 *   - path resolution (project-local when trusted, global fallback)
 *   - session discovery + transcript building from session JSONL traces
 *   - per-session extract cache (keyed by session mtime) so dream's 7-day
 *     scan is reused by distill's 30-day scan
 *   - config + state + dream-log persistence
 */


// ---------- paths ----------

export function isTrusted(ctx: ExtensionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}

export function memoryDir(ctx: ExtensionContext): string {
	if (isTrusted(ctx)) return path.join(ctx.cwd, ".pi", "memory");
	return path.join(os.homedir(), ".pi", "agent", "memory");
}

export function memoryFile(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "MEMORY.md");
}

export function extractsDir(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "extracts");
}

export function stagingDir(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "distill-staging");
}

export function skillsInstallDir(ctx: ExtensionContext): string {
	if (isTrusted(ctx)) return path.join(ctx.cwd, ".pi", "skills");
	return path.join(os.homedir(), ".pi", "agent", "skills");
}

function stateFile(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "state.json");
}

function dreamLogFile(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "dream-log.jsonl");
}

export function changelogFile(ctx: ExtensionContext): string {
	return path.join(memoryDir(ctx), "dream-changelog-latest.md");
}

// ---------- config / state ----------

export interface MimoConfig {
	dreamDays: number;
	distillDays: number;
	mapModel: string | null; // e.g. "google/gemini-2.5-flash" — cheap extractor
	reduceModel: string | null; // strong consolidator; null = active model
	minOccurrences: number; // distill gate: sessions a workflow must appear in
	maxSessions: number;
	maxTranscriptChars: number;
	maxMemoryLines: number;
}

const DEFAULT_CONFIG: MimoConfig = {
	dreamDays: 7,
	distillDays: 30,
	mapModel: null,
	reduceModel: null,
	minOccurrences: 2,
	maxSessions: 40,
	maxTranscriptChars: 24000,
	maxMemoryLines: 150,
};

export async function loadConfig(ctx: ExtensionContext): Promise<MimoConfig> {
	const file = path.join(memoryDir(ctx), "config.json");
	try {
		const raw = JSON.parse(await fs.readFile(file, "utf8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export interface MimoState {
	dreamLastRun?: number;
	distillLastRun?: number;
	lastNag?: number;
}

export async function loadState(ctx: ExtensionContext): Promise<MimoState> {
	try {
		return JSON.parse(await fs.readFile(stateFile(ctx), "utf8"));
	} catch {
		return {};
	}
}

export async function saveState(ctx: ExtensionContext, state: MimoState): Promise<void> {
	await fs.mkdir(memoryDir(ctx), { recursive: true });
	await fs.writeFile(stateFile(ctx), JSON.stringify(state, null, "\t"));
}

export async function appendDreamLog(ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> {
	await fs.mkdir(memoryDir(ctx), { recursive: true });
	await fs.appendFile(dreamLogFile(ctx), JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ---------- session discovery ----------

export interface SessionInfo {
	file: string;
	id: string;
	mtimeMs: number;
}

export async function listRecentSessions(ctx: ExtensionContext, days: number, maxSessions: number): Promise<SessionInfo[]> {
	const all = await SessionManager.list(ctx.cwd);
	if (!Array.isArray(all)) return [];
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const out: SessionInfo[] = [];
	for (const s of all) {
		// NOTE: actual shape is {path, id, cwd, name, created, modified, messageCount, ...}
		// (docs examples show .file — stale). Accept both, trust neither.
		const file = (s as any).path ?? (s as any).file;
		if (typeof file !== "string") continue;
		try {
			const st = await fs.stat(file);
			if (st.mtimeMs >= cutoff) {
				out.push({ file, id: path.basename(file).replace(/\.jsonl$/, ""), mtimeMs: st.mtimeMs });
			}
		} catch {
			// unreadable/vanished session file — skip
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out.slice(0, maxSessions);
}

// ---------- transcript building ----------

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + ` …[+${s.length - max} chars]`;
}

function summarizeToolArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return truncate(JSON.stringify(args ?? {}), 120);
	if (name === "bash" && typeof args.command === "string") {
		return truncate(args.command.split("\n")[0], 160);
	}
	if (typeof args.path === "string") return args.path;
	if (typeof args.command === "string") return truncate(args.command, 120);
	return truncate(JSON.stringify(args), 120);
}

function userText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

/**
 * Build a readable, token-lean transcript from a session JSONL.
 * Includes user/assistant text, tool calls (one-liners), tool results
 * (errors kept — they're gold for gotcha extraction), user `!` bash lines,
 * compaction summaries and extension custom messages.
 * Keeps head + tail so goals and latest state both survive truncation.
 */
export async function buildTranscript(file: string, maxChars: number): Promise<string> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		return "";
	}
	const lines: string[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let entry: any;
		try {
			entry = JSON.parse(t);
		} catch {
			continue;
		}
		if (entry.type === "compaction") {
			lines.push(`[SESSION COMPACTED — summary] ${truncate(String(entry.summary ?? ""), 2000)}`);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		switch (msg.role) {
			case "user": {
				const text = userText(msg.content).trim();
				if (text) lines.push(`USER: ${truncate(text, 1500)}`);
				break;
			}
			case "assistant": {
				if (!Array.isArray(msg.content)) break;
				for (const part of msg.content) {
					if (part.type === "text" && part.text?.trim()) {
						lines.push(`ASSISTANT: ${truncate(part.text.trim(), 1500)}`);
					} else if (part.type === "toolCall") {
						lines.push(`TOOL_CALL ${part.name}(${summarizeToolArgs(part.name, part.arguments)})`);
					}
					// thinking parts skipped — too verbose, rarely durable
				}
				break;
			}
			case "toolResult": {
				const text = userText(msg.content).trim();
				const flag = msg.isError ? " (ERROR)" : "";
				// errors in full (up to 600), successes briefly
				lines.push(`TOOL_RESULT ${msg.toolName}${flag}: ${truncate(text, msg.isError ? 600 : 200)}`);
				break;
			}
			case "bashExecution": {
				const text = userText(msg.content).trim();
				if (text) lines.push(`USER_BASH: ${truncate(text, 300)}`);
				break;
			}
			case "custom": {
				const text = userText(msg.content).trim();
				if (text) lines.push(`NOTE: ${truncate(text, 300)}`);
				break;
			}
			default:
				break;
		}
	}
	let transcript = lines.join("\n");
	if (transcript.length > maxChars) {
		const head = Math.floor(maxChars * 0.35);
		const tail = maxChars - head;
		transcript = transcript.slice(0, head) + "\n…[transcript truncated]…\n" + transcript.slice(-tail);
	}
	return transcript;
}

// ---------- per-session extract cache ----------

export interface CacheEntry {
	mtimeMs: number;
	facts?: any;
	workflows?: any;
}

function cachePath(ctx: ExtensionContext, sessionId: string): string {
	return path.join(extractsDir(ctx), `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export async function getCached(ctx: ExtensionContext, session: SessionInfo): Promise<CacheEntry | null> {
	try {
		const entry: CacheEntry = JSON.parse(await fs.readFile(cachePath(ctx, session.id), "utf8"));
		if (entry.mtimeMs === session.mtimeMs) return entry;
		return null; // stale
	} catch {
		return null;
	}
}

export async function putCached(ctx: ExtensionContext, session: SessionInfo, patch: Partial<CacheEntry>): Promise<void> {
	const p = cachePath(ctx, session.id);
	let entry: CacheEntry = { mtimeMs: session.mtimeMs };
	try {
		entry = { ...JSON.parse(await fs.readFile(p, "utf8")), ...patch, mtimeMs: session.mtimeMs };
	} catch {
		entry = { mtimeMs: session.mtimeMs, ...patch };
	}
	await fs.mkdir(extractsDir(ctx), { recursive: true });
	await fs.writeFile(p, JSON.stringify(entry));
}

// ---------- path validation (code-level, not LLM-level) ----------

/** Strip :line and #anchor suffixes, resolve against cwd, check existence. */
export function isValidPathRef(p: string, cwd: string): boolean {
	if (!p || typeof p !== "string" || p.length > 300) return false;
	const cleaned = p.replace(/[:#].*$/, "").replace(/[`]|\*$/g, "").trim();
	if (!cleaned || cleaned.startsWith("<")) return false;
	const abs = path.resolve(cwd, cleaned);
	return existsSync(abs) || existsSync(cleaned);
}

// ---------- small fs helpers ----------

export async function readTextIfExists(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

/**
 * dream.ts — /dream: scan recent session traces, extract durable knowledge,
 * merge/dedup/prune into MEMORY.md with a reviewable changelog.
 *
 * Pipeline: map (per-session fact extraction, cheap model, cached)
 *         → reduce (consolidate against current MEMORY.md, strong model)
 *         → path-validation (code, not LLM)
 *         → review gate (user confirms changelog)
 *         → apply + snapshot + audit log
 */


interface Fact {
	kind: string;
	text: string;
	paths?: string[];
}

const FACT_KINDS = new Set(["convention", "decision", "gotcha", "vocabulary", "thread"]);

function sanitizeFacts(raw: any, cwd: string): Fact[] {
	const facts: Fact[] = [];
	if (!raw || !Array.isArray(raw.facts)) return facts;
	for (const f of raw.facts) {
		if (!f || typeof f.text !== "string" || !f.text.trim()) continue;
		const kind = FACT_KINDS.has(f.kind) ? f.kind : "convention";
		const paths = Array.isArray(f.paths)
			? f.paths.filter((p: any) => typeof p === "string" && isValidPathRef(p, cwd)).slice(0, 5)
			: [];
		facts.push({ kind, text: f.text.trim().slice(0, 500), paths });
	}
	return facts.slice(0, 12);
}

async function dreamMapSession(ctx: ExtensionContext, session: SessionInfo, cfg: any): Promise<Fact[]> {
	const cached = await getCached(ctx, session);
	if (cached?.facts) return cached.facts as Fact[];

	const transcript = await buildTranscript(session.file, cfg.maxTranscriptChars);
	if (!transcript.trim()) return [];

	const out = await callModel(ctx, {
		purpose: "dream/map",
		modelSpec: cfg.mapModel,
		requireJson: true,
		maxTokens: 2048,
		system:
			"You extract durable project knowledge from coding-agent session transcripts. " +
			"You are ruthless about skipping anything that is only meaningful inside this one session.",
		user: `Project directory: ${ctx.cwd}

Transcript of one session (tools abbreviated, errors kept):

<transcript>
${transcript}
</transcript>

Extract facts worth remembering ACROSS sessions, each as:
- kind: one of "convention" (how things are done here), "decision" (what was chosen and why), "gotcha" (error/trap + the fix), "vocabulary" (domain term the team uses), "thread" (unfinished work worth resuming)
- text: at most 2 sentences, fully self-contained (readable months later without this session)
- paths: relevant file paths that exist in the project (max 5), [] if none

Rules:
- NEVER include secrets, tokens, passwords, personal data
- Skip one-off bugs, trivial queries, and anything true only within this session
- Prefer facts that would change how an agent works in this repo tomorrow
- Max 12 facts

JSON: {"facts":[{"kind":"...","text":"...","paths":["..."]}]}`,
	});

	const facts = sanitizeFacts(parseJsonLoose(out), ctx.cwd);
	await putCached(ctx, session, { facts });
	return facts;
}

export async function runDream(pi: ExtensionAPI, ctx: ExtensionContext, argsStr: string): Promise<void> {
	const cfg = await loadConfig(ctx);
	const argDays = parseInt(argsStr.trim(), 10);
	const days = Number.isFinite(argDays) && argDays > 0 ? argDays : cfg.dreamDays;

	const sessions = await listRecentSessions(ctx, days, cfg.maxSessions);
	if (ctx.hasUI) ctx.ui.setStatus("dream", `dream: ${sessions.length} sessions in ${days}d`);
	console.error(`[dream] ${sessions.length} session(s) in last ${days}d for ${ctx.cwd}`);
	if (sessions.length === 0) {
		if (ctx.hasUI) ctx.ui.notify(`dream: no sessions in the last ${days}d for this directory`, "info");
		return;
	}

	// ---- map ----
	const allFacts: Fact[] = [];
	for (let i = 0; i < sessions.length; i++) {
		if (ctx.hasUI) ctx.ui.setStatus("dream", `dream: extracting ${i + 1}/${sessions.length} sessions…`);
		try {
			allFacts.push(...(await dreamMapSession(ctx, sessions[i], cfg)));
		} catch (err: any) {
			if (ctx.hasUI) ctx.ui.notify(`dream: skipping one session (${err?.message ?? err})`, "warning");
		}
	}

	if (allFacts.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("dream: nothing extractable found in recent sessions", "info");
		return;
	}

	// ---- reduce ----
	if (ctx.hasUI) ctx.ui.setStatus("dream", `dream: consolidating ${allFacts.length} facts…`);
	const currentMemory = (await readTextIfExists(memoryFile(ctx))) ?? "(empty — first dream run)";

	const reduceOut = await callModel(ctx, {
		purpose: "dream/reduce",
		modelSpec: cfg.reduceModel,
		requireJson: true,
		maxTokens: 8192,
		system:
			"You maintain the project MEMORY.md for a coding agent. Memory must be reviewable, compact, and current — " +
			"the user reads and edits this file by hand.",
		user: `Project directory: ${ctx.cwd}

Current MEMORY.md:
<memory>
${currentMemory}
</memory>

Facts freshly extracted from the last ${days} days of sessions (may duplicate each other and the memory):
<facts>
${JSON.stringify(allFacts, null, 1)}
</facts>

Produce the NEW MEMORY.md:
- Merge: deduplicate semantically-identical facts (newest wins), absorb them into existing sections
- Prune: remove entries made obsolete/contradicted by newer facts; remove entries about work that is now finished
- Sections (only non-empty ones): ## Conventions, ## Decisions, ## Gotchas, ## Vocabulary, ## Open threads
- One bullet per fact, keep file paths inline, no preamble or meta-commentary
- Max ${cfg.maxMemoryLines} lines total

Also emit an honest changelog of what you did.

JSON: {"memory":"<full new MEMORY.md markdown>","changelog":[{"action":"added|merged|removed|kept","detail":"...","reason":"..."}]}`,
	});

	const parsed = parseJsonLoose(reduceOut);
	if (!parsed || typeof parsed.memory !== "string" || !parsed.memory.trim()) {
		await fs.mkdir(memoryDir(ctx), { recursive: true });
		await fs.writeFile(path.join(memoryDir(ctx), "last-dream-raw.txt"), reduceOut);
		if (ctx.hasUI)
			ctx.ui.notify("dream: could not parse reduce output — raw response saved to last-dream-raw.txt", "error");
		return;
	}
	const changelog: Array<{ action: string; detail: string; reason: string }> = Array.isArray(parsed.changelog)
		? parsed.changelog.slice(0, 60)
		: [];

	// ---- review gate ----
	const counts = changelog.reduce<Record<string, number>>((acc, c) => {
		acc[c.action] = (acc[c.action] ?? 0) + 1;
		return acc;
	}, {});
	const preview =
		changelog
			.slice(0, 25)
			.map((c) => `• ${c.action}: ${ellipsize(c.detail, 90)}`)
			.join("\n") + (changelog.length > 25 ? `\n• … +${changelog.length - 25} more` : "");

	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			`dream: apply new MEMORY.md?`,
			`${sessions.length} sessions scanned, ${allFacts.length} facts extracted.\n` +
				`Changes: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}\n\n` +
				(preview || "(no changelog entries)") +
				`\n\nFull proposal will be saved to ${changelogFile(ctx)} either way.`,
		);
		if (!ok) {
			await fs.mkdir(memoryDir(ctx), { recursive: true });
			await fs.writeFile(
				changelogFile(ctx),
				`# dream proposal (NOT applied) — ${new Date().toISOString()}\n\n# Proposed MEMORY.md\n\n${parsed.memory}\n\n# Changelog\n\n${changelog.map((c) => `- ${c.action}: ${c.detail} (${c.reason})`).join("\n")}\n`,
			);
			ctx.ui.notify("dream: proposal saved, nothing applied", "info");
			return;
		}
	}

	// ---- apply ----
	await fs.mkdir(memoryDir(ctx), { recursive: true });
	const dir = memoryDir(ctx);
	const prev = await readTextIfExists(memoryFile(ctx));
	if (prev) {
		const snapDir = path.join(dir, "snapshots");
		await fs.mkdir(snapDir, { recursive: true });
		await fs.writeFile(path.join(snapDir, `${Date.now()}.md`), prev);
	}
	await fs.writeFile(memoryFile(ctx), parsed.memory.trim() + "\n");
	await fs.writeFile(
		changelogFile(ctx),
		`# dream applied — ${new Date().toISOString()}\n\n# Changelog\n\n${changelog.map((c) => `- ${c.action}: ${c.detail} (${c.reason})`).join("\n")}\n`,
	);
	await appendDreamLog(ctx, {
		days,
		sessions: sessions.length,
		facts: allFacts.length,
		counts,
		lines: parsed.memory.split("\n").length,
	});
	const state = await loadState(ctx);
	state.dreamLastRun = Date.now();
	await saveState(ctx, state);

	if (ctx.hasUI) {
		const lineCount = parsed.memory.split("\n").length;
		ctx.ui.notify(
			`dream: MEMORY.md updated (${lineCount} lines, was ${prev ? prev.split("\n").length : 0}) — ${memoryFile(ctx)}`,
			"info",
		);
	}
}

function ellipsize(s: string, max: number): string {
	s = String(s ?? "");
	return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * distill.ts — /distill: mine repeated workflows from session traces,
 * gate by confidence (frequency × safety), stage candidate skills for
 * review, install on explicit approval.
 *
 * Pipeline: map (per-session workflow mining, cached — shares the cache
 * file with dream) → merge (LLM unifies names/steps across sessions)
 * → aggregate (occurrence counting in CODE, not in the LLM)
 * → gate (min occurrences + safety scan)
 * → stage to distill-staging/ (NOT auto-registered as skills)
 * → /distill install <name> moves an approved skill into place
 */


interface Workflow {
	name: string;
	trigger: string;
	steps: string[];
	paths?: string[];
	aliases?: string[];
}

const UNSAFE_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/, label: "recursive force delete" },
	{ re: /\bsudo\b/, label: "sudo" },
	{ re: /\b(curl|wget)\b[^|;\n]*\|\s*(ba)?sh/, label: "pipe-to-shell download" },
	{ re: /\bchmod\s+777\b/, label: "chmod 777" },
	{ re: /\b(mkfs|dd\s+if=)/, label: "destructive disk tool" },
	{ re: /(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i, label: "hardcoded credential" },
];

function safetyScan(w: { name: string; trigger: string; steps: string[] }): string[] {
	const blob = `${w.name}\n${w.trigger}\n${w.steps.join("\n")}`;
	return UNSAFE_PATTERNS.filter((p) => p.re.test(blob)).map((p) => p.label);
}

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

async function distillMapSession(ctx: ExtensionContext, session: SessionInfo, cfg: any): Promise<Workflow[]> {
	const cached = await getCached(ctx, session);
	if (cached?.workflows) return cached.workflows as Workflow[];

	const transcript = await buildTranscript(session.file, cfg.maxTranscriptChars);
	if (!transcript.trim()) return [];

	const out = await callModel(ctx, {
		purpose: "distill/map",
		modelSpec: cfg.mapModel,
		requireJson: true,
		maxTokens: 3072,
		system:
			"You mine coding-agent session transcripts for REPEATED manual workflows — procedures the agent " +
			"re-derived from scratch, or that follow a stable multi-step recipe. One-off tasks are worthless here.",
		user: `Project directory: ${ctx.cwd}

Transcript of one session:

<transcript>
${transcript}
</transcript>

Identify multi-step workflows performed (or clearly requested by the user) in this session that could recur later, e.g.:
- environment/setup rituals (install, configure, env vars)
- recurring fix patterns (lint errors, migration steps, flaky test triage)
- review/release procedures (PR checklist, version bump, deploy)
- repeated multi-tool investigations

For each:
- name: kebab-case slug
- trigger: one sentence — when this workflow applies
- steps: ordered, concrete, mention the real commands/paths used
- paths: files involved, [] if none

Skip anything trivially single-step. Max 5 workflows.
If no genuine multi-step workflow occurred in this session, return an empty list — mining nothing is a valid, expected result. Never invent a workflow to justify the scan.

JSON: {"workflows":[{"name":"...","trigger":"...","steps":["..."],"paths":["..."]}]}`,
	});

	const parsed = parseJsonLoose(out);
	const workflows: Workflow[] = [];
	if (parsed && Array.isArray(parsed.workflows)) {
		for (const w of parsed.workflows) {
			if (!w || typeof w.name !== "string" || !Array.isArray(w.steps) || w.steps.length === 0) continue;
			workflows.push({
				name: slug(w.name),
				trigger: String(w.trigger ?? "").slice(0, 300),
				steps: w.steps.slice(0, 15).map((s: any) => String(s).slice(0, 400)),
				paths: Array.isArray(w.paths) ? w.paths.slice(0, 5).map(String) : [],
			});
		}
	}
	await putCached(ctx, session, { workflows });
	return workflows;
}

/** Inventory of already-available skills (project + global + staged) so distill extends instead of duplicating (MiMo discipline). */
async function listExistingSkills(ctx: ExtensionContext): Promise<Array<{ name: string; description: string }>> {
	const dirs = [skillsInstallDir(ctx), path.join(os.homedir(), ".pi", "agent", "skills"), stagingDir(ctx)];
	const seen = new Set<string>();
	const out: Array<{ name: string; description: string }> = [];
	for (const dir of dirs) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (seen.has(entry)) continue;
			seen.add(entry);
			try {
				const md = await fs.readFile(path.join(dir, entry, "SKILL.md"), "utf8");
				const name = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry;
				const description = md.match(/^description:\s*(.+)$/m)?.[1]?.trim().slice(0, 160) ?? "";
				out.push({ name, description });
			} catch {
				// not a skill directory — skip
			}
		}
	}
	return out;
}

export async function runDistill(pi: ExtensionAPI, ctx: ExtensionContext, argsStr: string): Promise<void> {
	const args = argsStr.trim();
	if (args.startsWith("install ")) {
		await installStaged(ctx, args.slice(8).trim());
		return;
	}
	if (args === "list") {
		await listStaged(ctx);
		return;
	}

	const cfg = await loadConfig(ctx);
	const argDays = parseInt(args, 10);
	const days = Number.isFinite(argDays) && argDays > 0 ? argDays : cfg.distillDays;

	const sessions = await listRecentSessions(ctx, days, cfg.maxSessions);
	if (sessions.length === 0) {
		if (ctx.hasUI) ctx.ui.notify(`distill: no sessions in the last ${days}d for this directory`, "info");
		return;
	}

	// ---- map ----
	const perSession: Array<{ session: SessionInfo; workflows: Workflow[] }> = [];
	for (let i = 0; i < sessions.length; i++) {
		if (ctx.hasUI) ctx.ui.setStatus("distill", `distill: mining ${i + 1}/${sessions.length} sessions…`);
		try {
			perSession.push({ session: sessions[i], workflows: await distillMapSession(ctx, sessions[i], cfg) });
		} catch (err: any) {
			if (ctx.hasUI) ctx.ui.notify(`distill: skipping one session (${err?.message ?? err})`, "warning");
		}
	}

	// ---- aggregate in code (LLMs can't be trusted with counting) ----
	const agg = new Map<string, { workflow: Workflow; sessions: Set<string>; days: Set<string> }>();
	for (const { session, workflows } of perSession) {
		for (const w of workflows) {
			if (!w.name) continue;
			const existing = agg.get(w.name);
			const day = new Date(session.mtimeMs).toISOString().slice(0, 10);
			if (existing) {
				existing.sessions.add(session.id);
				existing.days.add(day);
				if (w.steps.length > existing.workflow.steps.length) existing.workflow = w; // keep richest version
			} else {
				agg.set(w.name, { workflow: w, sessions: new Set([session.id]), days: new Set([day]) });
			}
		}
	}
	if (agg.size === 0) {
		if (ctx.hasUI) ctx.ui.notify("distill: no recurring workflows found", "info");
		return;
	}

	// ---- merge pass: unify near-duplicates, check against existing inventory ----
	if (ctx.hasUI) ctx.ui.setStatus("distill", "distill: merging candidates…");
	const existingSkills = await listExistingSkills(ctx);
	const mergeOut = await callModel(ctx, {
		purpose: "distill/merge",
		modelSpec: cfg.reduceModel,
		requireJson: true,
		maxTokens: 8192,
		system: "You consolidate mined workflow candidates. Occurrence counts are computed elsewhere — never invent them.",
		user: `Project directory: ${ctx.cwd}

Candidates mined from sessions (names already slug-collapsed, but semantic duplicates may remain):
<candidates>
${JSON.stringify([...agg.values()].map((a) => a.workflow), null, 1)}
</candidates>

Skills that ALREADY EXIST for this project/user:
<existing>
${existingSkills.length ? JSON.stringify(existingSkills, null, 1) : "(none)"}
</existing>

Rules:
- Do NOT propose a new skill that duplicates an existing one. If a candidate is already covered by an existing skill, set "covered_by" to that skill's name and keep steps empty — it will be skipped.
- Packaging nothing is a valid, expected outcome when evidence is weak. Do not manufacture candidates to justify the run.
- Otherwise, for each DISTINCT workflow (merge semantic duplicates; when merging, keep the richest steps and union the paths, and list merged names in "aliases"):
  produce a complete SKILL.md body.

JSON: {"merged":[{"name":"...","aliases":["..."],"covered_by":null,"trigger":"...","steps":["..."],"paths":["..."],"skill_md":"<full SKILL.md file content, starting with --- frontmatter with name and description>"}]}`,
	});
	const merged = parseJsonLoose(mergeOut);
	interface Merged extends Workflow {
		skill_md?: string;
		covered_by?: string | null;
	}
	const mergedList: Merged[] =
		merged && Array.isArray(merged.merged)
			? merged.merged.filter((m: any) => m && typeof m.name === "string")
			: [];

	// re-aggregate with aliases folded in
	const countsFor = (m: Merged): { occ: number; days: Set<string> } => {
		const names = new Set([slug(m.name), ...(m.aliases ?? []).map(slug)]);
		const sessionsHit = new Set<string>();
		const daysHit = new Set<string>();
		for (const { session, workflows } of perSession) {
			if (workflows.some((w) => names.has(w.name))) {
				sessionsHit.add(session.id);
				daysHit.add(new Date(session.mtimeMs).toISOString().slice(0, 10));
			}
		}
		return { occ: sessionsHit.size, days: daysHit };
	};

	// ---- gate: confidence = frequency + safety ----
	const qualified: Array<{ m: Merged; occ: number; dayCount: number; score: number }> = [];
	const rejected: Array<{ name: string; reason: string }> = [];
	for (const m of mergedList) {
		m.name = slug(m.name);
		if (!m.name) continue;
		const { occ, days } = countsFor(m);
		const unsafe = safetyScan(m as Workflow);
		if (unsafe.length > 0) {
			rejected.push({ name: m.name, reason: `unsafe: ${unsafe.join(", ")}` });
			continue;
		}
		if (m.covered_by || existingSkills.some((s) => s.name === m.name)) {
			rejected.push({ name: m.name, reason: `already covered by existing skill "${m.covered_by ?? m.name}"` });
			continue;
		}
		if (occ < cfg.minOccurrences) {
			rejected.push({ name: m.name, reason: `only ${occ} session${occ === 1 ? "" : "s"} (< ${cfg.minOccurrences})` });
			continue;
		}
		qualified.push({ m, occ, dayCount: days.size, score: occ + days.size * 0.5 });
	}
	qualified.sort((a, b) => b.score - a.score);

	if (qualified.length === 0) {
		// MiMo discipline: "Created nothing — no repeated workflow worth packaging" is a successful outcome.
		const detail =
			rejected.length > 0
				? ` (${rejected.length} candidate(s) considered and rejected: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")})`
				: "";
		if (ctx.hasUI) ctx.ui.notify(`distill: nothing met the bar — staged nothing, and that is a valid result${detail}`, "info");
		console.error(`[distill] staged nothing (valid outcome)${detail}`);
		return;
	}

	// ---- stage (nothing auto-registered) ----
	await fs.mkdir(stagingDir(ctx), { recursive: true });
	const stagedNames: string[] = [];
	for (const q of qualified) {
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				`distill: stage skill "${q.m.name}"?`,
				`score ${q.score.toFixed(1)} — seen in ${q.occ} session(s) across ${q.dayCount} day(s)\n` +
					`trigger: ${q.m.trigger}\n\n${q.m.steps.slice(0, 5).map((s, i) => `${i + 1}. ${s.slice(0, 100)}`).join("\n")}`,
			);
			if (!ok) continue;
		}
		const dir = path.join(stagingDir(ctx), q.m.name);
		await fs.mkdir(dir, { recursive: true });
		const skillMd =
			q.m.skill_md && q.m.skill_md.includes("name:")
				? q.m.skill_md
				: fallbackSkillMd(q.m.name, q.m.trigger, q.m.steps, q.m.paths ?? []);
		await fs.writeFile(path.join(dir, "SKILL.md"), skillMd.trim() + "\n");
		await fs.writeFile(
			path.join(dir, "meta.json"),
			JSON.stringify(
				{ name: q.m.name, score: q.score, occurrences: q.occ, distinct_days: q.dayCount, created: Date.now(), installed: false },
				null,
				"\t",
			),
		);
		stagedNames.push(q.m.name);
	}

	const state = await loadState(ctx);
	state.distillLastRun = Date.now();
	await saveState(ctx, state);

	if (ctx.hasUI) {
		if (stagedNames.length > 0) {
			ctx.ui.notify(
				`distill: staged ${stagedNames.length} skill(s): ${stagedNames.join(", ")}\n` +
					`Review at ${stagingDir(ctx)} — install with /distill install <name>${rejected.length ? ` (${rejected.length} rejected)` : ""}`,
				"info",
			);
		} else {
			ctx.ui.notify("distill: nothing staged", "info");
		}
	}
}

function fallbackSkillMd(name: string, trigger: string, steps: string[], paths: string[]): string {
	return `---
name: ${name}
description: ${trigger.replace(/\n/g, " ")}
---

# ${name}

## When to use

${trigger}

## Steps

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

${paths.length ? `## Files involved\n\n${paths.map((p) => `- ${p}`).join("\n")}\n` : ""}
## Guardrails

- Distilled automatically by /distill from session history — verify steps still match reality before relying on them.
- Never adapt this workflow to run destructive commands without explicit user confirmation.
`;
}

async function listStaged(ctx: ExtensionContext): Promise<void> {
	const dir = stagingDir(ctx);
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	if (entries.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("distill: staging area is empty", "info");
		return;
	}
	const lines: string[] = [];
	for (const name of entries) {
		try {
			const m = JSON.parse(await fs.readFile(path.join(dir, name, "meta.json"), "utf8"));
			lines.push(`${name} — score ${typeof m.score === "number" ? m.score.toFixed(1) : "?"}, ${m.occurrences} session(s)${m.installed ? " [installed]" : ""}`);
		} catch {
			lines.push(`${name} — (no meta)`);
		}
	}
	if (ctx.hasUI) ctx.ui.notify(`distill staged:\n${lines.join("\n")}\n\ninstall: /distill install <name>`, "info");
}

async function installStaged(ctx: ExtensionContext, rawName: string): Promise<void> {
	const name = slug(rawName);
	if (!name) {
		if (ctx.hasUI) ctx.ui.notify("distill install: missing skill name", "error");
		return;
	}
	const src = path.join(stagingDir(ctx), name, "SKILL.md");
	const skill = await readTextIfExists(src);
	if (!skill) {
		if (ctx.hasUI) ctx.ui.notify(`distill install: "${name}" is not staged (see /distill list)`, "error");
		return;
	}
	const destDir = path.join(skillsInstallDir(ctx), name);
	await fs.mkdir(destDir, { recursive: true });
	await fs.writeFile(path.join(destDir, "SKILL.md"), skill);
	try {
		const metaPath = path.join(stagingDir(ctx), name, "meta.json");
		const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
		meta.installed = true;
		await fs.writeFile(metaPath, JSON.stringify(meta, null, "\t"));
	} catch {
		// meta is advisory
	}
	if (ctx.hasUI)
		ctx.ui.notify(`distill: installed "${name}" → ${destDir}\nRun /reload to register it, then invoke with /skill:${name}`, "info");
}

/**
 * mimo-memory — /dream and /distill for pi, after Xiaomi MiMo Code's
 * Evolution theme (session-scan → memory consolidation and skill distillation).
 *
 * What it adds:
 *   /dream [days]            consolidate recent session traces into MEMORY.md
 *   /distill [days]          mine repeated workflows → staged candidate skills
 *   /distill list            show staged candidates
 *   /distill install <name>  move a staged skill into .pi/skills (or global)
 *
 * MEMORY.md (project-local when trusted, else ~/.pi/agent/memory/) is injected
 * into the system prompt on every turn, so dream output actually reaches the
 * agent. Dream/distill also nag once when overdue (they never auto-run).
 */


const MAX_INJECT_CHARS = 4000;

export default function (pi: ExtensionAPI) {
	// ---- memory injection: what dream produces, the agent sees ----
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const mem = await readTextIfExists(memoryFile(ctx));
			if (!mem || !mem.trim()) return;
			const body = mem.length > MAX_INJECT_CHARS ? mem.slice(0, MAX_INJECT_CHARS) + "\n…(truncated — run /dream to compact)" : mem;
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n# Project memory (maintained by /dream; the user can edit or delete this file directly)\n${body}`,
			};
		} catch {
			return;
		}
	});

	// ---- cadence nag: overdue + new sessions → one notify, max once per day ----
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (!ctx.hasUI) return;
			const [cfg, state] = await Promise.all([loadConfig(ctx), loadState(ctx)]);
			const now = Date.now();
			if (state.lastNag && now - state.lastNag < 24 * 60 * 60 * 1000) return;

			const nags: string[] = [];
			const dreamOverdue = !state.dreamLastRun || now - state.dreamLastRun > cfg.dreamDays * 24 * 60 * 60 * 1000;
			const distillOverdue = !state.distillLastRun || now - state.distillLastRun > cfg.distillDays * 24 * 60 * 60 * 1000;
			if (dreamOverdue) nags.push(`/dream (memory >${cfg.dreamDays}d stale or never run)`);
			if (distillOverdue) nags.push(`/distill (skills >${cfg.distillDays}d stale or never run)`);
			if (nags.length === 0) return;

			state.lastNag = now;
			await saveState(ctx, state);
			ctx.ui.notify(`mimo-memory: consider running ${nags.join(" and ")}`, "info");
		} catch {
			// never block startup on nag bookkeeping
		}
	});

	// ---- commands ----
	pi.registerCommand("dream", {
		description: "Consolidate recent sessions into MEMORY.md (MiMo dream)",
		handler: async (args, ctx) => {
			try {
				await runDream(pi, ctx, args ?? "");
			} catch (err: any) {
				console.error(`[dream] failed: ${err?.stack ?? err}`);
				if (ctx.hasUI) ctx.ui.notify(`dream failed: ${err?.message ?? err}`, "error");
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("dream", "");
			}
		},
	});

	pi.registerCommand("distill", {
		description: "Mine repeated workflows → staged skills (MiMo distill); 'install <name>' to activate",
		handler: async (args, ctx) => {
			try {
				await runDistill(pi, ctx, args ?? "");
			} catch (err: any) {
				console.error(`[distill] failed: ${err?.stack ?? err}`);
				if (ctx.hasUI) ctx.ui.notify(`distill failed: ${err?.message ?? err}`, "error");
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("distill", "");
			}
		},
	});
}
