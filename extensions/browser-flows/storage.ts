import { mkdir, readFile, readdir, rename, copyFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserFlow, RecordingState } from "./types.ts";

export const FLOW_HOME = process.env.PI_BROWSER_FLOWS_HOME || join(homedir(), ".pi", "agent", "browser-flows");
export const REVISION_HOME = join(FLOW_HOME, "revisions");
export const ARTIFACT_HOME = join(FLOW_HOME, "artifacts");
const RECORDING_PATH = join(FLOW_HOME, ".recording.json");

export function validateName(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
		throw new Error("Flow names must use 1-63 lowercase letters, numbers, or hyphens");
	}
	return normalized;
}

export function flowPath(name: string): string {
	return join(FLOW_HOME, `${validateName(name)}.json`);
}

export async function ensureHomes(): Promise<void> {
	await Promise.all([
		mkdir(FLOW_HOME, { recursive: true, mode: 0o700 }),
		mkdir(REVISION_HOME, { recursive: true, mode: 0o700 }),
		mkdir(ARTIFACT_HOME, { recursive: true, mode: 0o700 }),
	]);
}

export async function listFlows(): Promise<Array<{
	name: string;
	description?: string;
	purpose?: string;
	useWhen?: string;
	revision: number;
	nodes: number;
	targets: Array<{ checkpoint: string; purpose?: string; outcome?: string; tags?: string[] }>;
}>> {
	await ensureHomes();
	const files = (await readdir(FLOW_HOME)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
	const result = [];
	for (const file of files) {
		try {
			const flow = JSON.parse(await readFile(join(FLOW_HOME, file), "utf8")) as BrowserFlow;
			result.push({
				name: flow.name,
				description: flow.description,
				purpose: flow.documentation?.purpose,
				useWhen: flow.documentation?.useWhen,
				revision: flow.revision,
				nodes: Object.keys(flow.nodes).length,
				targets: Object.values(flow.nodes).flatMap((node) => node.checkpoint ? [{
					checkpoint: node.checkpoint,
					purpose: node.documentation?.purpose,
					outcome: node.documentation?.outcome,
					tags: node.documentation?.tags,
				}] : []),
			});
		} catch {
			// Ignore unrelated or partially-written files. Atomic saves prevent this normally.
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFlow(raw: string, expectedName?: string): BrowserFlow {
	let flow: BrowserFlow;
	try {
		flow = JSON.parse(raw) as BrowserFlow;
	} catch (error) {
		throw new Error(`Invalid browser flow JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const displayName = expectedName ?? flow?.name ?? "<unknown>";
	if (flow?.schemaVersion !== 1 || !flow.nodes || typeof flow.nodes !== "object" || Array.isArray(flow.nodes)) {
		throw new Error(`Unsupported or invalid browser flow: ${displayName}`);
	}
	flow.name = validateName(expectedName ?? flow.name);
	const safeNodes: BrowserFlow["nodes"] = Object.create(null);
	for (const [id, node] of Object.entries(flow.nodes)) {
		if (!node || node.id !== id || !Array.isArray(node.args) || !node.args.every((arg) => typeof arg === "string") || !Array.isArray(node.edges)) {
			throw new Error(`Invalid node ${id} in browser flow ${displayName}`);
		}
		if (node.args.length > 0 && node.sideEffect === undefined) {
			throw new Error(`Missing sideEffect classification in executable node ${id} of browser flow ${displayName}`);
		}
		if (node.sideEffect !== undefined && !["none", "mutation", "irreversible"].includes(node.sideEffect)) {
			throw new Error(`Invalid sideEffect in node ${id} of browser flow ${displayName}`);
		}
		if (node.optional !== undefined && typeof node.optional !== "boolean") throw new Error(`Invalid optional flag in node ${id}`);
		if (node.optional && node.sideEffect && node.sideEffect !== "none") throw new Error(`Side-effecting node ${id} cannot be optional`);
		if (node.expect !== undefined && (
			typeof node.expect !== "object" ||
			(node.expect.urlGlob !== undefined && typeof node.expect.urlGlob !== "string") ||
			(node.expect.visibleText !== undefined && typeof node.expect.visibleText !== "string")
		)) throw new Error(`Invalid expectation in node ${id} of browser flow ${displayName}`);
		for (const edge of node.edges) {
			if (!edge || typeof edge.to !== "string") throw new Error(`Invalid edge in node ${id} of browser flow ${displayName}`);
			if (edge.when !== undefined) {
				if (edge.when.type === "url" && typeof edge.when.glob !== "string") throw new Error(`Invalid URL edge in node ${id}`);
				if (edge.when.type === "target" && typeof edge.when.equals !== "string") throw new Error(`Invalid target edge in node ${id}`);
				if (!["always", "url", "target"].includes(edge.when.type)) throw new Error(`Invalid edge condition in node ${id}`);
			}
		}
		safeNodes[id] = node;
	}
	flow.nodes = safeNodes;
	for (const node of Object.values(flow.nodes)) {
		for (const edge of node.edges) if (!Object.hasOwn(flow.nodes, edge.to)) {
			throw new Error(`Edge from ${node.id} points to missing node ${edge.to} in browser flow ${displayName}`);
		}
	}
	if (!Array.isArray(flow.browserArgs) || !flow.browserArgs.every((arg) => typeof arg === "string")) {
		throw new Error(`Invalid browserArgs in browser flow ${displayName}`);
	}
	if (flow.entry !== undefined && (typeof flow.entry !== "string" || !Object.hasOwn(flow.nodes, flow.entry))) {
		throw new Error(`Invalid entry node in browser flow ${displayName}`);
	}
	return flow;
}

export async function loadFlow(name: string): Promise<BrowserFlow> {
	const path = flowPath(name);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error(`Browser flow not found: ${validateName(name)}`);
	}
	return parseFlow(raw, name);
}

export function createFlow(name: string, description?: string, browserArgs: string[] = []): BrowserFlow {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		name: validateName(name),
		description: description?.trim() || undefined,
		createdAt: now,
		updatedAt: now,
		revision: 0,
		browserArgs,
		nodes: {},
	};
}

export async function saveFlow(flow: BrowserFlow, preserveRevision = true): Promise<void> {
	await ensureHomes();
	const path = flowPath(flow.name);
	if (existsSync(path)) {
		const old = await loadFlow(flow.name);
		if (old.revision !== flow.revision) {
			throw new Error(`Browser flow ${flow.name} changed concurrently (loaded revision ${flow.revision}, current ${old.revision})`);
		}
		if (preserveRevision) {
			const revDir = join(REVISION_HOME, flow.name);
			await mkdir(revDir, { recursive: true, mode: 0o700 });
			const stamp = new Date().toISOString().replaceAll(":", "-");
			await copyFile(path, join(revDir, `${String(old.revision).padStart(4, "0")}-${stamp}.json`));
		}
	}
	flow.revision += 1;
	flow.updatedAt = new Date().toISOString();
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temp, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

export async function makeArtifactDir(flowName: string): Promise<string> {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	const dir = join(ARTIFACT_HOME, validateName(flowName), stamp);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export async function loadRecording(): Promise<RecordingState | undefined> {
	try {
		return JSON.parse(await readFile(RECORDING_PATH, "utf8")) as RecordingState;
	} catch {
		return undefined;
	}
}

export async function saveRecording(state: RecordingState | undefined): Promise<void> {
	await ensureHomes();
	if (!state) {
		await unlink(RECORDING_PATH).catch(() => undefined);
		return;
	}
	const temp = `${RECORDING_PATH}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, RECORDING_PATH);
}
