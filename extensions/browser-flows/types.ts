export type SideEffect = "none" | "mutation" | "irreversible";

export interface Expectation {
	urlGlob?: string;
	visibleText?: string;
}

export type EdgeCondition =
	| { type: "always" }
	| { type: "url"; glob: string }
	| { type: "target"; equals: string };

export interface FlowEdge {
	to: string;
	when?: EdgeCondition;
	label?: string;
}

export interface PathDocumentation {
	/** What this flow/path is for. */
	purpose: string;
	/** Situations or user intents for which an agent should choose it. */
	useWhen?: string;
	/** State that must already be true. */
	prerequisites?: string[];
	/** State produced when the flow/path reaches this point. */
	outcome?: string;
	/** Longer operational or domain knowledge. */
	details?: string;
	tags?: string[];
}

export interface FlowNode {
	id: string;
	label?: string;
	/** Documentation for the route ending at this node/checkpoint. */
	documentation?: PathDocumentation;
	/** Legacy free-text note, retained for existing flow files. */
	note?: string;
	/** agent-browser argv, excluding global browserArgs. Empty for a pure checkpoint. */
	args: string[];
	expect?: Expectation;
	checkpoint?: string;
	sideEffect?: SideEffect;
	optional?: boolean;
	unstable?: boolean;
	edges: FlowEdge[];
}

export interface WebsiteMemo {
	id: string;
	text: string;
	/** Optional URL scope. The memo applies to the whole flow when omitted. */
	urlGlob?: string;
	createdAt: string;
}

export interface BrowserFlow {
	schemaVersion: 1;
	name: string;
	description?: string;
	/** Documentation for the workflow as a whole. */
	documentation?: PathDocumentation;
	createdAt: string;
	updatedAt: string;
	revision: number;
	/** Global agent-browser arguments, e.g. ["--profile", "C:\\Users\\..."]. */
	browserArgs: string[];
	/** Site-level knowledge that should survive UI/path repairs. */
	memos?: WebsiteMemo[];
	entry?: string;
	nodes: Record<string, FlowNode>;
}

export interface RecordingState {
	flowName: string;
	lastNode?: string;
	/** Tail at start; prevents stop-without-actions from overwriting a shared checkpoint. */
	initialLastNode?: string;
	/** Applied to the first new edge when branching from an existing node. */
	branchTarget?: string;
	startedAt: string;
}

export interface RunFailure {
	flow: string;
	node: string;
	message: string;
	note?: string;
	stdout?: string;
	stderr?: string;
	url?: string;
	artifactDir: string;
	snapshotPath?: string;
	screenshotPath?: string;
}
