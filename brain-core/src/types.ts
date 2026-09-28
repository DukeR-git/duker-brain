/**
 * The shared vault model.
 *
 * Both halves of the system depend on these shapes: pi-traverser reads
 * manifests, brain-keeper writes them. Keeping the definitions in one place is
 * the point of brain-core — a manifest the keeper emits must be one the
 * traverser accepts, and two copies of this file would eventually disagree.
 */

// ---------------------------------------------------------------------------
// Decisions API (TypeSafe Jev / local Laya)
// ---------------------------------------------------------------------------

export type Content = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
	type: "choice";
	instructions: Content;
	criteria: Record<string, Content | null>;
}

export interface ScoreQuestion {
	type: "score";
	instructions: Content;
	criteria: Content[];
}

export interface NoulQuestion {
	type: "noul";
	instructions: Content;
	criteria?: Record<string, Content>;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence?: number;
	probabilities?: Record<string, number>;
	/** Laya-only: `act_probability`, the model's own act/abstain signal. */
	action?: Record<string, number>;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	legend?: Record<string, string>;
	confidence?: number;
	probabilities?: Record<string, number>;
	action?: Record<string, number>;
}

export interface NoulAnswer {
	type: "noul";
	noul: number;
	confidence?: number;
	action?: Record<string, number>;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface DecisionsRequest {
	state: Content;
	questions: Record<string, Question>;
	model?: string;
}

export interface DecisionsResponse {
	id?: string;
	model?: string;
	created?: number;
	created_at?: number;
	answers: Record<string, Answer>;
	usage?: { input_tokens?: number; output_tokens?: number };
	routing?: { model?: string; device?: string; latency_ms?: number; reason?: string };
	warnings?: string[];
}

// ---------------------------------------------------------------------------
// Vault manifests (_index.json) — generated, never hand-edited
// ---------------------------------------------------------------------------

export interface ManifestEntry {
	id: string;
	type: "branch" | "leaf";
	/** 10-25 words describing when this node should be selected. */
	criteria: string;
	/** Relative to the directory holding the manifest. */
	targetPath: string;
	/** Display name; falls back to the node's frontmatter title, then to `id`. */
	title?: string;
	/** Marks the catch-all note used when routing is inconclusive. */
	fallback?: boolean;
}

// ---------------------------------------------------------------------------
// Vault source of truth — YAML frontmatter on notes and folder descriptions
// ---------------------------------------------------------------------------

/** The frontmatter fields brain-core understands. Anything else is preserved verbatim. */
export interface NodeFrontmatter {
	id?: string;
	title?: string;
	criteria?: string;
	fallback?: boolean;
}

export interface ParsedNote {
	frontmatter: NodeFrontmatter;
	/** Frontmatter lines for keys brain-core does not own, kept so a rewrite does not drop them. */
	extraLines: string[];
	/** Whether the file had a frontmatter block at all. */
	hadFrontmatter: boolean;
	body: string;
	/** Frontmatter the parser had to guess at; surfaced by the doctor as `bad-frontmatter`. */
	problems?: string[];
}

export type NodeKind = "branch" | "leaf";

/** One node of the scanned vault tree. */
export interface VaultNode {
	kind: NodeKind;
	/** Slug used as the routing label and manifest id. */
	id: string;
	title: string;
	criteria: string;
	fallback: boolean;
	/** Absolute path: the `.md` file for a leaf, the directory for a branch. */
	absolutePath: string;
	/** Path relative to the vault root, forward-slashed. */
	path: string;
	/** For a branch: the `_about.md` that described it, if present. */
	aboutPath?: string;
	/** For a branch: its children, in manifest order. */
	children?: VaultNode[];
	/** Problems found while scanning this node. */
	issues: VaultIssue[];
}

export type IssueSeverity = "error" | "warning" | "info";

export interface VaultIssue {
	severity: IssueSeverity;
	/** Stable slug so tools and tests can assert on a specific problem. */
	code: VaultIssueCode;
	/** Path relative to the vault root that the issue is about. */
	path: string;
	message: string;
	/** What would fix it, phrased as an action. */
	remedy?: string;
}

export type VaultIssueCode =
	| "too-many-children"
	| "missing-criteria"
	| "thin-criteria"
	| "verbose-criteria"
	| "duplicate-id"
	| "missing-about"
	| "empty-branch"
	| "empty-body"
	| "no-fallback"
	| "multiple-fallbacks"
	| "unreadable"
	| "bad-frontmatter"
	| "duplicate-criteria"
	| "hashed-id"
	| "non-slug-id"
	| "too-deep";

export interface VaultTree {
	root: VaultNode;
	issues: VaultIssue[];
	counts: { branches: number; leaves: number };
}

// ---------------------------------------------------------------------------
// Traversal — the shape of one routing run
// ---------------------------------------------------------------------------

export interface Hop {
	/** Directory the decision was made in, relative to the vault root. */
	from: string;
	chosen: string;
	type: "branch" | "leaf";
	confidence: number;
	latencyMs: number;
	probabilities?: Record<string, number>;
	optionCount: number;
	/** Laya-only: the model's own act/abstain signal for this hop, when reported. */
	actProbability?: number;
}

export type TraversalStatus =
	/** A leaf was selected and read. */
	| "leaf"
	/** Multiple complementary leaves were selected across branches under composite routing. */
	| "composite"
	/** The gate decided this prompt does not need a reference guide. */
	| "skipped"
	/** A hop fell below the confidence threshold. */
	| "low-confidence"
	/** Routing was inconclusive and the fallback document was used. */
	| "fallback"
	/** The vault or a directory has no `_index.json`. */
	| "no-index"
	/** Hit the max-hop ceiling without reaching a leaf. */
	| "max-hops"
	/** The decisions API or the filesystem failed. */
	| "error"
	/** Disabled by configuration. */
	| "disabled";

export interface TraversalDocument {
	id: string;
	title: string;
	/** Path relative to the vault root. */
	path: string;
	content: string;
	truncated: boolean;
	/** Length of the body before truncation. */
	originalLength: number;
	/** Individual confidence of routing to this document. */
	confidence?: number;
	/** Traversal trail that led to this document. */
	trail?: string;
}

export interface TraversalResult {
	status: TraversalStatus;
	/** Human-readable trail, e.g. `Root -> Backend -> asyncpg_pooling.md` or composite trail. */
	trail: string;
	hops: Hop[];
	/** Populated for `leaf`, `fallback`, and primary document of `composite`. */
	document?: TraversalDocument;
	/** Populated with all routed documents when one or more documents are selected. */
	documents?: TraversalDocument[];
	/** True when multiple complementary guides were routed under composite routing. */
	composite?: boolean;
	/** Gate outcome, when the gate ran. */
	gate?: { needed: boolean; probability: number };
	/** Lowest confidence seen across hops; the traverser's weakest link. */
	minConfidence: number;
	totalMs: number;
	/** Why the traversal ended the way it did. */
	reason: string;
	/** Warnings the decisions service attached to its answers (host-laya's `warnings`). */
	warnings?: string[];
	/** True when the result was served from the local route cache. */
	cached?: boolean;
}

// ---------------------------------------------------------------------------
// Evaluations (brain eval)
// ---------------------------------------------------------------------------

export interface EvalCase {
	id: string;
	prompt: string;
	/** Expected note id (e.g. `asyncpg_pooling`) or relative path (e.g. `Backend/asyncpg_pooling.md`). */
	expected: string;
	minConfidence?: number;
	acceptableAlternatives?: string[];
	tags?: string[];
}

export interface EvalSuite {
	version: number;
	defaults?: {
		minConfidence?: number;
		timeoutMs?: number;
	};
	evals: EvalCase[];
}

export interface EvalResult {
	id: string;
	prompt: string;
	expected: string;
	actual: string | null;
	passed: boolean;
	confidence: number;
	minConfidencePassed: boolean;
	nearTie: boolean;
	runnerUp?: { label: string; confidence: number };
	latencyMs: number;
	error?: string;
}

export interface EvalReport {
	total: number;
	passed: number;
	failed: number;
	accuracy: number;
	meanLatencyMs: number;
	p50LatencyMs: number;
	p95LatencyMs: number;
	results: EvalResult[];
}

export interface EvalOptions {
	concurrency?: number;
	tags?: string[];
	failUnder?: number; // 0 - 100 percentage
}

// ---------------------------------------------------------------------------
// Exporter (brain export)
// ---------------------------------------------------------------------------

export type ExportFormat = "cursor" | "windsurf" | "aider" | "bundle";

export interface ExportOptions {
	dryRun?: boolean;
	includeCriteria?: boolean;
	tagFilter?: string[];
}

export interface ExportResult {
	format: ExportFormat;
	outDir: string;
	filesWritten: string[];
	noteCount: number;
	dryRun: boolean;
}
