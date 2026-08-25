import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BrowserFlow, EdgeCondition, Expectation, FlowNode, PathDocumentation, RecordingState, SideEffect } from "./types.ts";
import { AgentBrowser, runFlow } from "./runner.ts";
import { createFlow, FLOW_HOME, flowPath, listFlows, loadFlow, loadRecording, saveFlow, saveRecording, validateName } from "./storage.ts";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

let recording: RecordingState | undefined;
let browserQueue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
	const next = browserQueue.then(work, work);
	browserQueue = next.then(() => undefined, () => undefined);
	return next;
}

function resolveNode(flow: BrowserFlow, idOrCheckpoint: string): string {
	if (Object.hasOwn(flow.nodes, idOrCheckpoint)) return idOrCheckpoint;
	const matches = Object.values(flow.nodes).filter((node) => node.checkpoint === idOrCheckpoint);
	if (matches.length !== 1) throw new Error(`Node/checkpoint not found or ambiguous: ${idOrCheckpoint}`);
	return matches[0].id;
}

function assertCheckpointAvailable(flow: BrowserFlow, checkpoint: string, exceptNode?: string): void {
	const duplicate = Object.values(flow.nodes).find((node) => node.checkpoint === checkpoint && node.id !== exceptNode);
	if (duplicate) throw new Error(`Checkpoint ${checkpoint} already belongs to ${duplicate.id}`);
}

function nextNodeId(flow: BrowserFlow): string {
	let n = Object.keys(flow.nodes).length + 1;
	while (flow.nodes[`step-${String(n).padStart(3, "0")}`]) n += 1;
	return `step-${String(n).padStart(3, "0")}`;
}

function conciseFlow(flow: BrowserFlow): object {
	return {
		name: flow.name,
		description: flow.description,
		documentation: flow.documentation,
		revision: flow.revision,
		entry: flow.entry,
		browserArgs: flow.browserArgs,
		memos: flow.memos ?? [],
		nodes: Object.values(flow.nodes).map((node) => ({
			id: node.id,
			label: node.label,
			documentation: node.documentation,
			note: node.note,
			args: node.args,
			checkpoint: node.checkpoint,
			sideEffect: node.sideEffect,
			optional: node.optional,
			unstable: node.unstable,
			expect: node.expect,
			edges: node.edges,
		})),
	};
}

async function startRecording(
	name: string,
	options: { description?: string; from?: string; browserArgs?: string[]; overwrite?: boolean; branchTarget?: string },
): Promise<BrowserFlow> {
	name = validateName(name);
	let flow: BrowserFlow;
	if (existsSync(flowPath(name))) {
		const old = await loadFlow(name);
		if (!options.overwrite && old.entry && !options.from) {
			throw new Error(`Flow ${name} already has an entry; provide from=<node or checkpoint> to add a branch, or overwrite=true to replace it`);
		}
		if (options.overwrite) {
			flow = createFlow(name, options.description, options.browserArgs ?? old.browserArgs);
			flow.revision = old.revision;
			flow.createdAt = old.createdAt;
		} else {
			flow = old;
			if (options.description) flow.description = options.description;
			if (options.browserArgs) flow.browserArgs = options.browserArgs;
		}
	} else {
		flow = createFlow(name, options.description, options.browserArgs);
	}
	const lastNode = options.from ? resolveNode(flow, options.from) : undefined;
	if (lastNode && flow.nodes[lastNode].edges.length > 0 && !options.branchTarget) {
		throw new Error(`Node ${lastNode} already has an outgoing path; provide branchTarget when recording another branch`);
	}
	await saveFlow(flow, true);
	recording = { flowName: name, lastNode, initialLastNode: lastNode, branchTarget: options.branchTarget, startedAt: new Date().toISOString() };
	await saveRecording(recording);
	return flow;
}

async function stopRecording(checkpoint?: string): Promise<BrowserFlow> {
	if (!recording) throw new Error("No browser flow recording is active");
	const flow = await loadFlow(recording.flowName);
	if (checkpoint) {
		if (!recording.lastNode || recording.lastNode === recording.initialLastNode) throw new Error("Cannot add a checkpoint before recording a new action");
		if (!Object.hasOwn(flow.nodes, recording.lastNode)) throw new Error(`Recording tail no longer exists: ${recording.lastNode}`);
		assertCheckpointAvailable(flow, checkpoint.trim(), recording.lastNode);
		flow.nodes[recording.lastNode].checkpoint = checkpoint.trim();
	}
	await saveFlow(flow, false);
	recording = undefined;
	await saveRecording(undefined);
	return flow;
}

async function recordAction(
	args: string[],
	options: { label?: string; note?: string; checkpoint?: string; expect?: Expectation; sideEffect?: SideEffect; optional?: boolean },
): Promise<{ flow: BrowserFlow; node: FlowNode } | undefined> {
	if (!recording) return undefined;
	const flow = await loadFlow(recording.flowName);
	const id = nextNodeId(flow);
	if (options.checkpoint) assertCheckpointAvailable(flow, options.checkpoint);
	if (options.optional && options.sideEffect && options.sideEffect !== "none") {
		throw new Error("Side-effecting nodes cannot be optional");
	}
	const node: FlowNode = {
		id,
		label: options.label,
		note: options.note?.trim() || undefined,
		args: [...args],
		expect: options.expect,
		checkpoint: options.checkpoint,
		sideEffect: options.sideEffect ?? "none",
		optional: options.optional,
		unstable: args.some((arg) => /^@e\d+$/.test(arg)),
		edges: [],
	};
	flow.nodes[id] = node;
	if (recording.lastNode) {
		const previous = Object.hasOwn(flow.nodes, recording.lastNode) ? flow.nodes[recording.lastNode] : undefined;
		if (!previous) throw new Error(`Recording tail no longer exists: ${recording.lastNode}`);
		const firstNewNode = recording.lastNode === recording.initialLastNode;
		const when: EdgeCondition = firstNewNode && recording.branchTarget
			? { type: "target", equals: recording.branchTarget }
			: { type: "always" };
		if (!previous.edges.some((edge) => edge.to === id)) previous.edges.push({ to: id, when });
	} else if (!flow.entry) {
		flow.entry = id;
	} else {
		throw new Error(`Flow ${flow.name} already has an entry; start recording with from=<node or checkpoint> to add a branch`);
	}
	recording.lastNode = id;
	await saveFlow(flow, false);
	await saveRecording(recording);
	return { flow, node };
}

function documentationFrom(params: {
	docPurpose?: string;
	docUseWhen?: string;
	docPrerequisites?: string[];
	docOutcome?: string;
	docDetails?: string;
	docTags?: string[];
}, existing?: PathDocumentation): PathDocumentation {
	const purpose = params.docPurpose?.trim() || existing?.purpose;
	if (!purpose) throw new Error("document requires docPurpose when no documentation exists yet");
	return {
		purpose,
		useWhen: params.docUseWhen !== undefined ? params.docUseWhen.trim() || undefined : existing?.useWhen,
		prerequisites: params.docPrerequisites !== undefined
			? params.docPrerequisites.map((value) => value.trim()).filter(Boolean)
			: existing?.prerequisites,
		outcome: params.docOutcome !== undefined ? params.docOutcome.trim() || undefined : existing?.outcome,
		details: params.docDetails !== undefined ? params.docDetails.trim() || undefined : existing?.details,
		tags: params.docTags !== undefined
			? params.docTags.map((value) => value.trim().toLowerCase()).filter(Boolean)
			: existing?.tags,
	};
}

function recordingRisk(args: string[]): { blocked: boolean; optIn: boolean; reason?: string } {
	const command = args[0]?.toLowerCase();
	if (!command) return { blocked: true, optIn: false, reason: "empty command" };
	if (["auth", "cookies", "storage", "state", "eval", "clipboard"].includes(command)) {
		return { blocked: true, optIn: false, reason: `${command} commands may contain credentials or private page data` };
	}
	if (args.some((arg) => /password|passwd|cookie|token|secret|authorization|session[_-]?id/i.test(arg))) {
		return { blocked: true, optIn: false, reason: "the command appears to contain sensitive data" };
	}
	for (const arg of args) {
		if (!/^https?:\/\//i.test(arg)) continue;
		try {
			const url = new URL(arg);
			if (url.username || url.password) return { blocked: true, optIn: false, reason: "URL contains credentials" };
			for (const key of url.searchParams.keys()) {
				if (/token|sig|signature|auth|key|code|password|secret|session/i.test(key)) {
					return { blocked: true, optIn: false, reason: `URL contains sensitive query parameter ${key}` };
				}
			}
			if (url.search || url.hash.includes("?")) return { blocked: false, optIn: true, reason: "URL query values may contain personal data" };
		} catch {
			return { blocked: true, optIn: false, reason: "invalid URL" };
		}
	}
	const entersValue = args.includes("fill") || args.includes("type") || args.includes("inserttext");
	if (entersValue) return { blocked: false, optIn: true, reason: "value-entry recording is opt-in" };
	if (["upload", "download", "screenshot", "pdf"].includes(command)) {
		return { blocked: false, optIn: true, reason: "local file paths may identify a user or machine" };
	}
	return { blocked: false, optIn: false };
}

function textResult(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function browserFlowsExtension(pi: ExtensionAPI) {
	const browser = new AgentBrowser(pi);

	pi.registerTool({
		name: "browser_action",
		label: "Browser Action",
		description: "Run one agent-browser CLI command. When flow recording is active, successful commands are appended to the graph. Prefer semantic find role/text/label commands over temporary @e refs.",
		promptSnippet: "Drive agent-browser while optionally recording durable browser-flow graph nodes",
		promptGuidelines: [
			"Use browser_action instead of bash for agent-browser commands so successful actions can be recorded and outputs stay bounded.",
			"While recording browser flows, prefer semantic agent-browser locators and do not record temporary @e refs, passwords, cookies, or tokens.",
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), { minItems: 1, description: "agent-browser argv, excluding the executable and flow-level profile/session args" }),
			record: Type.Optional(Type.Boolean({ description: "Set false for observations, secrets, and one-off actions" })),
			label: Type.Optional(Type.String()),
			note: Type.Optional(Type.String({ description: "Prerequisite, quirk, or repair hint associated with this recorded step" })),
			checkpoint: Type.Optional(Type.String()),
			sideEffect: Type.Optional(StringEnum(["none", "mutation", "irreversible"] as const)),
			optional: Type.Optional(Type.Boolean()),
			expectUrl: Type.Optional(Type.String({ description: "URL glob to verify after the action" })),
			expectText: Type.Optional(Type.String({ description: "Visible text to wait for after the action" })),
		}),
		async execute(_id, params, signal) {
			return serial(async () => {
				const flow = recording ? await loadFlow(recording.flowName) : undefined;
				const result = await browser.execute(flow?.browserArgs ?? [], params.args, signal);
				if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `agent-browser exited ${result.code}`);
				const risk = recordingRisk(params.args);
				// Sensitive commands are never recorded. Commands that may carry personal
				// values or local paths require explicit record=true.
				const shouldRecord = !!recording && params.record !== false && !risk.blocked && (!risk.optIn || params.record === true);
				const saved = shouldRecord ? await recordAction(params.args, {
					label: params.label,
					note: params.note,
					checkpoint: params.checkpoint,
					sideEffect: params.sideEffect,
					optional: params.optional,
					expect: params.expectUrl || params.expectText ? { urlGlob: params.expectUrl, visibleText: params.expectText } : undefined,
				}) : undefined;
				const suffix = saved ? `\nRecorded ${saved.flow.name}:${saved.node.id}${saved.node.unstable ? " (unstable @ref; repair to a semantic locator before replay)" : ""}` :
					(recording && (risk.blocked || (risk.optIn && params.record !== true)) ? `\nNot recorded: ${risk.reason}.` : "");
				const output = result.stdout.trim() || "ok";
				const compactOutput = output.length > 12_000 ? `${output.slice(0, 12_000)}\n[output truncated; use record=false with a narrower observation]` : output;
				return textResult(`${compactOutput}${suffix}`, { code: result.code, recordedNode: saved?.node.id, unstable: saved?.node.unstable });
			});
		},
	});

	pi.registerTool({
		name: "browser_flow",
		label: "Browser Flow",
		description: "Create, document, discover, inspect, edit, or replay saved agent-browser workflow graphs. Structured documentation explains each flow/path's purpose, usage, prerequisites, and outcome. Replays return a compact result; failures save targeted repair artifacts.",
		promptSnippet: "Reuse and repair saved agent-browser workflow graphs",
		promptGuidelines: [
			"Before exploring a browser task, use browser_flow list to discover documented flows and checkpoints by purpose/tags, then replay an existing matching target when available.",
			"Use browser_flow update_node and add_edge to repair only the failed graph step, then replay from the graph entry for verification.",
			"Do not set allowIrreversible unless the user explicitly approved the side effect.",
		],
		parameters: Type.Object({
			operation: StringEnum(["list", "show", "start_recording", "stop_recording", "cancel_recording", "run", "update_node", "add_edge", "remove_edge", "document", "remove_document", "add_note", "remove_note", "set_entry"] as const),
			name: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			from: Type.Optional(Type.String({ description: "Existing node ID or checkpoint from which to add a branch" })),
			branchTarget: Type.Optional(Type.String({ description: "Required when adding another branch from a node that already has an outgoing path; used as the first edge's target guard" })),
			target: Type.Optional(Type.String({ description: "Node ID or checkpoint at which replay should stop" })),
			checkpoint: Type.Optional(Type.String()),
			browserArgs: Type.Optional(Type.Array(Type.String())),
			overwrite: Type.Optional(Type.Boolean()),
			allowIrreversible: Type.Optional(Type.Boolean()),
			node: Type.Optional(Type.String({ description: "Node ID or checkpoint to update, link, or set as entry" })),
			to: Type.Optional(Type.String({ description: "Destination node ID or checkpoint for add_edge" })),
			args: Type.Optional(Type.Array(Type.String())),
			label: Type.Optional(Type.String()),
			note: Type.Optional(Type.String({ description: "Memo text for add_note, or node guidance for update_node" })),
			noteId: Type.Optional(Type.String({ description: "Site memo ID for remove_note" })),
			noteUrl: Type.Optional(Type.String({ description: "Optional URL glob limiting a legacy site-level memo" })),
			docPurpose: Type.Optional(Type.String({ description: "What this flow or checkpoint path is used to accomplish" })),
			docUseWhen: Type.Optional(Type.String({ description: "User intents or situations for which an agent should choose this path" })),
			docPrerequisites: Type.Optional(Type.Array(Type.String(), { description: "Required state, selections, permissions, or prior setup" })),
			docOutcome: Type.Optional(Type.String({ description: "Expected state after reaching this flow or checkpoint" })),
			docDetails: Type.Optional(Type.String({ description: "Additional domain knowledge or operational documentation" })),
			docTags: Type.Optional(Type.Array(Type.String(), { description: "Discovery keywords" })),
			expectUrl: Type.Optional(Type.String()),
			expectText: Type.Optional(Type.String()),
			sideEffect: Type.Optional(StringEnum(["none", "mutation", "irreversible"] as const)),
			optional: Type.Optional(Type.Boolean()),
			condition: Type.Optional(StringEnum(["always", "url", "target"] as const)),
			conditionValue: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal) {
			return serial(async () => {
				switch (params.operation) {
					case "list": {
						const flows = await listFlows();
						return textResult(flows.length ? JSON.stringify(flows, null, 2) : `No browser flows in ${FLOW_HOME}`, { flows });
					}
					case "show": {
						if (!params.name) throw new Error("show requires name");
						const flow = await loadFlow(params.name);
						return textResult(JSON.stringify(conciseFlow(flow), null, 2), { flow: conciseFlow(flow) });
					}
					case "start_recording": {
						if (!params.name) throw new Error("start_recording requires name");
						const flow = await startRecording(params.name, params);
						return textResult(`Recording ${flow.name}${recording?.lastNode ? ` from ${recording.lastNode}` : ""}. Use browser_action for each command, then stop_recording.`, { recording });
					}
					case "stop_recording": {
						const flow = await stopRecording(params.checkpoint);
						return textResult(`Saved ${flow.name}: ${Object.keys(flow.nodes).length} nodes, revision ${flow.revision}.`, { flow: conciseFlow(flow) });
					}
					case "cancel_recording": {
						const cancelled = recording;
						recording = undefined;
						await saveRecording(undefined);
						return textResult(cancelled ? `Cancelled recording ${cancelled.flowName}. Existing saved nodes were kept.` : "No browser flow recording was active.", { cancelled });
					}
					case "run": {
						if (!params.name) throw new Error("run requires name");
						const flow = await loadFlow(params.name);
						const result = await runFlow(browser, flow, { target: params.target, allowIrreversible: params.allowIrreversible, signal });
						if (result.ok) return textResult(`Flow ${flow.name}${params.target ? ` reached ${params.target}` : " completed"}: ${result.steps} browser commands in ${(result.durationMs / 1000).toFixed(1)}s.`, result);
						return textResult(`Flow ${flow.name} failed at ${result.failure.node}: ${result.failure.message}\nURL: ${result.failure.url ?? "unknown"}${result.failure.note ? `\nMemo: ${result.failure.note}` : ""}\nSnapshot: ${result.failure.snapshotPath ?? "unavailable"}\nScreenshot: ${result.failure.screenshotPath ?? "unavailable"}\nRepair this node with update_node/add_edge, then replay.`, result);
					}
					case "update_node": {
						if (!params.name || !params.node) throw new Error("update_node requires name and node");
						const flow = await loadFlow(params.name);
						const id = resolveNode(flow, params.node);
						const node = flow.nodes[id];
						if (params.args) { node.args = params.args; node.unstable = params.args.some((arg) => /^@e\d+$/.test(arg)); }
						if (params.label !== undefined) node.label = params.label;
						if (params.note !== undefined) node.note = params.note.trim() || undefined;
						if (params.checkpoint !== undefined) {
							assertCheckpointAvailable(flow, params.checkpoint, id);
							node.checkpoint = params.checkpoint;
						}
						if (params.sideEffect !== undefined) node.sideEffect = params.sideEffect;
						if (params.optional !== undefined) {
							if (params.optional && (params.sideEffect ?? node.sideEffect ?? "none") !== "none") throw new Error("Side-effecting nodes cannot be optional");
							node.optional = params.optional;
						}
						if (node.optional && node.sideEffect && node.sideEffect !== "none") throw new Error("Side-effecting nodes cannot be optional");
						if (params.expectUrl !== undefined || params.expectText !== undefined) node.expect = {
							...node.expect,
							...(params.expectUrl !== undefined ? { urlGlob: params.expectUrl } : {}),
							...(params.expectText !== undefined ? { visibleText: params.expectText } : {}),
						};
						await saveFlow(flow, true);
						return textResult(`Updated ${flow.name}:${id} (revision ${flow.revision}).`, { node });
					}
					case "add_edge": {
						if (!params.name || !params.node || !params.to) throw new Error("add_edge requires name, node, and to");
						const flow = await loadFlow(params.name);
						const from = resolveNode(flow, params.node);
						const to = resolveNode(flow, params.to);
						let when: EdgeCondition = { type: "always" };
						if (params.condition === "url") {
							if (!params.conditionValue) throw new Error("url condition requires conditionValue glob");
							when = { type: "url", glob: params.conditionValue };
						} else if (params.condition === "target") {
							if (!params.conditionValue) throw new Error("target condition requires conditionValue");
							when = { type: "target", equals: params.conditionValue };
						}
						flow.nodes[from].edges = flow.nodes[from].edges.filter((edge) => !(edge.to === to && JSON.stringify(edge.when) === JSON.stringify(when)));
						flow.nodes[from].edges.push({ to, when, label: params.label });
						await saveFlow(flow, true);
						return textResult(`Linked ${flow.name}:${from} -> ${to} (${when.type}).`, { from, to, when });
					}
					case "remove_edge": {
						if (!params.name || !params.node || !params.to) throw new Error("remove_edge requires name, node, and to");
						const flow = await loadFlow(params.name);
						const from = resolveNode(flow, params.node);
						const to = resolveNode(flow, params.to);
						const before = flow.nodes[from].edges.length;
						flow.nodes[from].edges = flow.nodes[from].edges.filter((edge) => edge.to !== to);
						if (flow.nodes[from].edges.length === before) throw new Error(`No edge ${from} -> ${to}`);
						await saveFlow(flow, true);
						return textResult(`Removed edge ${flow.name}:${from} -> ${to}.`, { from, to });
					}
					case "document": {
						if (!params.name) throw new Error("document requires name");
						const flow = await loadFlow(params.name);
						const documentTarget = params.node ?? params.checkpoint;
						if (documentTarget) {
							const id = resolveNode(flow, documentTarget);
							const documentation = documentationFrom(params, flow.nodes[id].documentation);
							flow.nodes[id].documentation = documentation;
							await saveFlow(flow, true);
							return textResult(`Documented path ${flow.name}:${id}: ${documentation.purpose}`, { node: id, documentation });
						}
						const documentation = documentationFrom(params, flow.documentation);
						flow.documentation = documentation;
						await saveFlow(flow, true);
						return textResult(`Documented flow ${flow.name}: ${documentation.purpose}`, { documentation });
					}
					case "remove_document": {
						if (!params.name) throw new Error("remove_document requires name");
						const flow = await loadFlow(params.name);
						const documentTarget = params.node ?? params.checkpoint;
						if (documentTarget) {
							const id = resolveNode(flow, documentTarget);
							flow.nodes[id].documentation = undefined;
							await saveFlow(flow, true);
							return textResult(`Removed path documentation from ${flow.name}:${id}.`, { node: id });
						}
						flow.documentation = undefined;
						await saveFlow(flow, true);
						return textResult(`Removed flow documentation from ${flow.name}.`);
					}
					case "add_note": {
						if (!params.name || !params.note?.trim()) throw new Error("add_note requires name and note");
						const flow = await loadFlow(params.name);
						if (params.node) {
							const id = resolveNode(flow, params.node);
							flow.nodes[id].note = params.note.trim();
							await saveFlow(flow, true);
							return textResult(`Added node memo to ${flow.name}:${id}.`, { node: id, note: flow.nodes[id].note });
						}
						const memo = { id: randomUUID().slice(0, 8), text: params.note.trim(), urlGlob: params.noteUrl, createdAt: new Date().toISOString() };
						(flow.memos ??= []).push(memo);
						await saveFlow(flow, true);
						return textResult(`Added site memo ${memo.id} to ${flow.name}${memo.urlGlob ? ` for ${memo.urlGlob}` : ""}.`, { memo });
					}
					case "remove_note": {
						if (!params.name) throw new Error("remove_note requires name");
						const flow = await loadFlow(params.name);
						if (params.node) {
							const id = resolveNode(flow, params.node);
							if (!flow.nodes[id].note) throw new Error(`Node ${id} has no memo`);
							flow.nodes[id].note = undefined;
							await saveFlow(flow, true);
							return textResult(`Removed node memo from ${flow.name}:${id}.`, { node: id });
						}
						if (!params.noteId) throw new Error("remove_note requires node or noteId");
						const before = flow.memos?.length ?? 0;
						flow.memos = (flow.memos ?? []).filter((memo) => memo.id !== params.noteId);
						if (flow.memos.length === before) throw new Error(`Site memo not found: ${params.noteId}`);
						await saveFlow(flow, true);
						return textResult(`Removed site memo ${params.noteId} from ${flow.name}.`, { noteId: params.noteId });
					}
					case "set_entry": {
						if (!params.name || !params.node) throw new Error("set_entry requires name and node");
						const flow = await loadFlow(params.name);
						flow.entry = resolveNode(flow, params.node);
						await saveFlow(flow, true);
						return textResult(`Entry for ${flow.name} is now ${flow.entry}.`, { entry: flow.entry });
					}
					default:
						throw new Error(`Unsupported browser_flow operation: ${String(params.operation)}`);
				}
			});
		},
	});

	pi.registerCommand("flow", {
		description: "Browser flow: list | show | record | stop | cancel | run | doc",
		handler: async (raw, ctx) => {
			const parts = raw.trim().split(/\s+/).filter(Boolean);
			const [command = "list", name, extra] = parts;
			try {
				if (command === "list") {
					const flows = await listFlows();
					ctx.ui.notify(flows.length ? flows.map((f) => `${f.name}${f.purpose ? ` — ${f.purpose}` : ""} (${f.nodes} nodes; ${f.targets.map((target) => target.checkpoint).join(", ") || "no targets"})`).join("\n") : "No browser flows", "info");
				} else if (command === "show" && name) {
					const flow = await loadFlow(name);
					ctx.ui.notify(`${flow.name}: ${Object.keys(flow.nodes).length} nodes, revision ${flow.revision}\n${FLOW_HOME}/${flow.name}.json`, "info");
				} else if (command === "record" && name) {
					const flow = await startRecording(name, { from: extra });
					ctx.ui.setStatus("browser-flow", `recording ${flow.name}`);
					ctx.ui.notify(`Recording ${flow.name}${extra ? ` from ${extra}` : ""}`, "info");
				} else if (command === "stop") {
					const flow = await stopRecording(name);
					ctx.ui.setStatus("browser-flow", undefined);
					ctx.ui.notify(`Saved ${flow.name}`, "info");
				} else if (command === "cancel") {
					const cancelled = recording;
					recording = undefined;
					await saveRecording(undefined);
					ctx.ui.setStatus("browser-flow", undefined);
					ctx.ui.notify(cancelled ? `Cancelled recording ${cancelled.flowName}` : "No recording was active", "info");
				} else if (command === "run" && name) {
					const flow = await loadFlow(name);
					const result = await serial(() => runFlow(browser, flow, { target: extra }));
					ctx.ui.notify(result.ok ? `Flow ${name} completed (${result.steps} commands)` : `Flow ${name} failed at ${result.failure.node}; artifacts: ${result.failure.artifactDir}`, result.ok ? "info" : "error");
				} else if (command === "doc" && name && extra && parts.length >= 4) {
					const flow = await loadFlow(name);
					const purpose = parts.slice(3).join(" ");
					if (extra === "-") flow.documentation = { ...flow.documentation, purpose };
					else {
						const id = resolveNode(flow, extra);
						flow.nodes[id].documentation = { ...flow.nodes[id].documentation, purpose };
					}
					await saveFlow(flow, true);
					ctx.ui.notify(`Documentation added to ${name}:${extra}`, "info");
				} else {
					ctx.ui.notify("Usage: /flow list | show NAME | record NAME [FROM] | stop [CHECKPOINT] | cancel | run NAME [TARGET] | doc NAME NODE|- PURPOSE", "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		recording = await loadRecording();
		if (recording) ctx.ui.setStatus("browser-flow", `recording ${recording.flowName}`);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("browser-flow", undefined);
	});
}
