import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserFlow, FlowEdge, FlowNode, RunFailure } from "./types.ts";
import { makeArtifactDir } from "./storage.ts";

const OUTPUT_LIMIT = 50_000;
// A Windows Node process can inherit WSL_DISTRO_NAME, but it cannot use WSL's
// /mnt/c working directory. Only a native POSIX Node process should use it.
const IS_WSL_WITH_WINDOWS_DRIVE = process.platform !== "win32" && !!process.env.WSL_DISTRO_NAME && existsSync("/mnt/c/Windows");
const EXEC_CWD = IS_WSL_WITH_WINDOWS_DRIVE ? "/mnt/c" : process.cwd();
const configuredTimeout = Number(process.env.PI_BROWSER_COMMAND_TIMEOUT_MS ?? 60_000);
const DEFAULT_COMMAND_TIMEOUT = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 60_000;

export interface BrowserResult {
	code: number;
	stdout: string;
	stderr: string;
}

function clipped(value: string): string {
	return value.length <= OUTPUT_LIMIT ? value : `${value.slice(0, OUTPUT_LIMIT)}\n[truncated]`;
}

export class AgentBrowser {
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	async toWindowsPath(path: string): Promise<string> {
		if (!IS_WSL_WITH_WINDOWS_DRIVE) return path;
		const result = await this.pi.exec("wslpath", ["-w", path], { timeout: 5000 });
		if (result.code !== 0) throw new Error(result.stderr || "wslpath failed");
		return result.stdout.trim();
	}

	private async executeRaw(globalArgs: string[], args: string[], signal?: AbortSignal, timeout = DEFAULT_COMMAND_TIMEOUT): Promise<BrowserResult> {
		// npm's Windows `agent-browser` shim is a POSIX shell script in some
		// installations and cannot be spawned by Node directly. Invoke the CLI's
		// JavaScript entry point through this Node runtime instead.
		const windowsCli = process.env.AGENT_BROWSER_CLI_PATH || join(dirname(process.execPath), "node_modules", "agent-browser", "bin", "agent-browser.js");
		const useWindowsCli = process.platform === "win32" && existsSync(windowsCli);
		// Under WSL, /mnt/c avoids cmd.exe's UNC-cwd warning for a Windows CLI.
		// Native Linux/macOS/Windows runs from the Pi process cwd.
		const result = await this.pi.exec(useWindowsCli ? process.execPath : "agent-browser", useWindowsCli ? [windowsCli, ...globalArgs, ...args] : [...globalArgs, ...args], {
			cwd: EXEC_CWD,
			signal,
			timeout,
		});
		return {
			code: result.code ?? -1,
			stdout: clipped(result.stdout || ""),
			stderr: clipped(result.stderr || ""),
		};
	}

	async execute(globalArgs: string[], args: string[], signal?: AbortSignal, timeout = DEFAULT_COMMAND_TIMEOUT): Promise<BrowserResult> {
		const command = args[0]?.toLowerCase();
		if (command === "frame-click") {
			if (args.length !== 3) throw new Error("frame-click requires <frame-css> <element-css>");
			const [frameSelector, elementSelector] = args.slice(1);
			const script = `(() => { const frame = document.querySelector(${JSON.stringify(frameSelector)}); if (!(frame instanceof HTMLIFrameElement)) throw new Error("frame not found"); const doc = frame.contentDocument; if (!doc) throw new Error("frame is not same-origin or not ready"); const element = doc.querySelector(${JSON.stringify(elementSelector)}); if (!element || typeof element.click !== "function") throw new Error("frame element not found"); element.click(); return "clicked durable frame element"; })()`;
			return this.executeRaw(globalArgs, ["eval", script], signal, timeout);
		}
		if (command === "frame-select-text") {
			if (args.length !== 4) throw new Error("frame-select-text requires <frame-css> <select-css> <visible-option>");
			const [frameSelector, selectSelector, visibleOption] = args.slice(1);
			const script = `(() => { const frame = document.querySelector(${JSON.stringify(frameSelector)}); if (!(frame instanceof HTMLIFrameElement)) throw new Error("frame not found"); const doc = frame.contentDocument; if (!doc) throw new Error("frame is not same-origin or not ready"); const select = doc.querySelector(${JSON.stringify(selectSelector)}); if (!select || select.tagName !== "SELECT" || !("options" in select)) throw new Error("frame select not found"); const option = [...select.options].find((candidate) => candidate.text.trim() === ${JSON.stringify(visibleOption)}); if (!option) throw new Error("frame option not found"); select.value = option.value; select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true })); return "selected durable frame option"; })()`;
			return this.executeRaw(globalArgs, ["eval", script], signal, timeout);
		}
		if (command === "click-visible") {
			if (args.length !== 2) throw new Error("click-visible requires <element-css>");
			const script = `(() => { const element = [...document.querySelectorAll(${JSON.stringify(args[1])})].find((candidate) => candidate instanceof HTMLElement && candidate.getClientRects().length > 0); if (!(element instanceof HTMLElement)) throw new Error("visible element not found"); element.click(); return "clicked visible element"; })()`;
			return this.executeRaw(globalArgs, ["eval", script], signal, timeout);
		}
		if (command === "frame-assert-text") {
			if (args.length !== 3) throw new Error("frame-assert-text requires <frame-css> <visible-text>");
			const [frameSelector, visibleText] = args.slice(1);
			const condition = `(() => { const frame = document.querySelector(${JSON.stringify(frameSelector)}); return frame instanceof HTMLIFrameElement && !!frame.contentDocument?.body?.innerText.includes(${JSON.stringify(visibleText)}); })()`;
			return this.executeRaw(globalArgs, ["wait", "--fn", condition], signal, timeout);
		}
		if (command === "tab-switch-url") {
			if (args.length !== 2) throw new Error("tab-switch-url requires <url-glob>");
			const requestedGlob = args[1];
			let listing: BrowserResult | undefined;
			for (let attempt = 0; attempt < 10; attempt += 1) {
				listing = await this.executeRaw(globalArgs, ["tab"], signal, timeout);
				if (listing.code !== 0) return listing;
				const matches = listing.stdout.split("\n").flatMap((line) => {
					const match = line.match(/\[([^\]]+)] .* - (https?:\/\/\S+)\s*$/);
					return match && globMatches(match[2], requestedGlob) ? [match[1]] : [];
				});
				if (matches.length > 1) return { code: 1, stdout: listing.stdout, stderr: `Multiple tabs match ${requestedGlob}` };
				if (matches.length === 1) return this.executeRaw(globalArgs, ["tab", matches[0]], signal, timeout);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return { code: 1, stdout: listing?.stdout ?? "", stderr: `No tab matches ${requestedGlob}` };
		}
		return this.executeRaw(globalArgs, args, signal, timeout);
	}
}

function globMatches(value: string, glob: string): boolean {
	// URL globs intentionally let both * and ** cross slashes. Escape every regex
	// metacharacter first, using a sentinel to preserve stars as wildcards.
	const escaped = glob
		.replaceAll("**", "\u0000")
		.replaceAll("*", "\u0001")
		.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
		.replaceAll("\u0000", ".*")
		.replaceAll("\u0001", ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

function resolveGoal(flow: BrowserFlow, target?: string): string | undefined {
	if (!target) return undefined;
	if (Object.hasOwn(flow.nodes, target)) return target;
	const matches = Object.values(flow.nodes).filter((node) => node.checkpoint === target);
	if (matches.length === 0) throw new Error(`Target/checkpoint not found in ${flow.name}: ${target}`);
	if (matches.length > 1) throw new Error(`Checkpoint is ambiguous in ${flow.name}: ${target}`);
	return matches[0].id;
}

function canReach(flow: BrowserFlow, start: string, goal: string): boolean {
	const pending = [start];
	const seen = new Set<string>();
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (id === goal) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const node = Object.hasOwn(flow.nodes, id) ? flow.nodes[id] : undefined;
		for (const edge of node?.edges ?? []) if (!seen.has(edge.to)) pending.push(edge.to);
	}
	return false;
}

async function pickEdge(
	browser: AgentBrowser,
	flow: BrowserFlow,
	node: FlowNode,
	target: string | undefined,
	goal: string | undefined,
	signal?: AbortSignal,
): Promise<FlowEdge | undefined> {
	let candidates = node.edges.filter((edge) => Object.hasOwn(flow.nodes, edge.to));
	if (goal) candidates = candidates.filter((edge) => canReach(flow, edge.to, goal));
	if (candidates.length === 0) return undefined;

	const targetMatch = candidates.find((edge) => {
		if (edge.when?.type !== "target") return false;
		if (edge.when.equals === target || edge.when.equals === goal) return true;
		try { return resolveGoal(flow, edge.when.equals) === goal; } catch { return false; }
	});
	if (targetMatch) return targetMatch;

	const urlEdges = candidates.filter((edge) => edge.when?.type === "url");
	if (urlEdges.length > 0) {
		const current = await browser.execute(flow.browserArgs, ["get", "url"], signal);
		if (current.code === 0) {
			const url = current.stdout.trim();
			const match = urlEdges.find((edge) => edge.when?.type === "url" && globMatches(url, edge.when.glob));
			if (match) return match;
		}
	}

	const unconditional = candidates.filter((edge) => !edge.when || edge.when.type === "always");
	return unconditional.length === 1 ? unconditional[0] : undefined;
}

async function verifyNode(browser: AgentBrowser, flow: BrowserFlow, node: FlowNode, signal?: AbortSignal): Promise<BrowserResult | undefined> {
	if (node.expect?.urlGlob) {
		const result = await browser.execute(flow.browserArgs, ["get", "url"], signal);
		if (result.code !== 0 || !globMatches(result.stdout.trim(), node.expect.urlGlob)) {
			return {
				...result,
				code: result.code || 1,
				stderr: `Expected URL ${node.expect.urlGlob}; got ${result.stdout.trim() || result.stderr.trim()}`,
			};
		}
	}
	if (node.expect?.visibleText) {
		const result = await browser.execute(flow.browserArgs, ["wait", "--text", node.expect.visibleText], signal);
		if (result.code !== 0) return result;
	}
	return undefined;
}

async function captureFailure(
	browser: AgentBrowser,
	flow: BrowserFlow,
	node: FlowNode,
	message: string,
	result: BrowserResult,
	signal?: AbortSignal,
): Promise<RunFailure> {
	const artifactDir = await makeArtifactDir(flow.name);
	const snapshotPath = join(artifactDir, "snapshot.txt");
	const screenshotPath = join(artifactDir, "screenshot.png");
	// Keep these sequential: agent-browser commands share one stateful session.
	const url = await browser.execute(flow.browserArgs, ["get", "url"], signal).catch(() => undefined);
	const snapshot = await browser.execute(flow.browserArgs, ["snapshot", "-i", "--json"], signal).catch(() => undefined);
	const windowsScreenshotPath = await browser.toWindowsPath(screenshotPath).catch(() => screenshotPath);
	const screenshot = await browser.execute(flow.browserArgs, ["screenshot", windowsScreenshotPath], signal).catch(() => undefined);
	if (snapshot?.code === 0) await writeFile(snapshotPath, snapshot.stdout, { mode: 0o600 });
	const currentUrl = url?.code === 0 ? url.stdout.trim() : undefined;
	const applicableMemos = (flow.memos ?? []).filter((memo) => !memo.urlGlob || (!!currentUrl && globMatches(currentUrl, memo.urlGlob)));
	const formatDocs = (docs: typeof node.documentation, scope: string) => docs ? [
		`${scope} purpose: ${docs.purpose}`,
		docs.useWhen ? `Use when: ${docs.useWhen}` : undefined,
		docs.prerequisites?.length ? `Prerequisites: ${docs.prerequisites.join("; ")}` : undefined,
		docs.outcome ? `Expected outcome: ${docs.outcome}` : undefined,
		docs.details,
	].filter(Boolean).join("\n") : undefined;
	const notes = [
		formatDocs(flow.documentation, "Flow"),
		formatDocs(node.documentation, "Path"),
		node.note,
		...applicableMemos.map((memo) => memo.text),
	].filter(Boolean);
	const failure: RunFailure = {
		flow: flow.name,
		node: node.id,
		message,
		note: notes.length ? notes.join("\n") : undefined,
		stdout: result.stdout.trim() || undefined,
		stderr: result.stderr.trim() || undefined,
		url: currentUrl,
		artifactDir,
		snapshotPath: snapshot?.code === 0 ? snapshotPath : undefined,
		screenshotPath: screenshot?.code === 0 ? screenshotPath : undefined,
	};
	await writeFile(join(artifactDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
	return failure;
}

export type FlowRunResult =
	| { ok: true; flow: string; target?: string; finalNode: string; steps: number; durationMs: number }
	| { ok: false; failure: RunFailure; steps: number; durationMs: number };

export async function runFlow(
	browser: AgentBrowser,
	flow: BrowserFlow,
	options: { target?: string; allowIrreversible?: boolean; signal?: AbortSignal },
): Promise<FlowRunResult> {
	if (!flow.entry || !Object.hasOwn(flow.nodes, flow.entry)) throw new Error(`Flow ${flow.name} has no valid entry node`);
	const started = Date.now();
	const goal = resolveGoal(flow, options.target);
	if (goal && !canReach(flow, flow.entry, goal)) throw new Error(`Target ${options.target} is unreachable from the entry of ${flow.name}`);
	let current = flow.entry;
	let steps = 0;
	const visits = new Map<string, number>();

	while (true) {
		options.signal?.throwIfAborted();
		const node = Object.hasOwn(flow.nodes, current) ? flow.nodes[current] : undefined;
		if (!node) throw new Error(`Flow ${flow.name} points to missing node: ${current}`);
		const count = (visits.get(current) ?? 0) + 1;
		visits.set(current, count);
		if (count > 2 || steps > Math.max(100, Object.keys(flow.nodes).length * 3)) {
			throw new Error(`Flow ${flow.name} appears to contain a non-terminating cycle at ${current}`);
		}

		if (node.sideEffect === "irreversible" && !options.allowIrreversible) {
			const failure = await captureFailure(browser, flow, node, "Irreversible step requires explicit approval", { code: 1, stdout: "", stderr: "Set allowIrreversible=true to run this step" }, options.signal);
			return { ok: false, failure, steps, durationMs: Date.now() - started };
		}

		if (node.args.length > 0) {
			const result = await browser.execute(flow.browserArgs, node.args, options.signal);
			steps += 1;
			if (result.code !== 0 && !node.optional) {
				const failure = await captureFailure(browser, flow, node, `agent-browser exited ${result.code}`, result, options.signal);
				return { ok: false, failure, steps, durationMs: Date.now() - started };
			}
		}

		const verification = await verifyNode(browser, flow, node, options.signal);
		if (verification && !node.optional) {
			const failure = await captureFailure(browser, flow, node, "Post-step verification failed", verification, options.signal);
			return { ok: false, failure, steps, durationMs: Date.now() - started };
		}

		if (current === goal || (!goal && node.edges.length === 0)) {
			return { ok: true, flow: flow.name, target: options.target, finalNode: current, steps, durationMs: Date.now() - started };
		}
		const edge = await pickEdge(browser, flow, node, options.target, goal, options.signal);
		if (!edge) {
			const failure = await captureFailure(browser, flow, node, goal ? `No valid path from ${current} to ${goal}` : `No matching branch after ${current}`, { code: 1, stdout: "", stderr: "No edge condition matched" }, options.signal);
			return { ok: false, failure, steps, durationMs: Date.now() - started };
		}
		current = edge.to;
	}
}
