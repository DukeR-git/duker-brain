/**
 * The traversal engine.
 *
 * Walks the brain tree one `_index.json` at a time, asking the decisions API to
 * pick a child at each level, and returns the leaf markdown to inject.
 *
 * Two things this deliberately does *not* do:
 *   - throw. Every failure path returns a `TraversalResult` with a status and a
 *     reason, because a routing miss must never take down an agent turn.
 *   - scan the filesystem. If a directory has no manifest, traversal stops.
 *
 * The gate question rides along with the first hop's choice question. The
 * decisions API answers every question in a request together, so asking "does this
 * prompt even need a reference guide?" costs a few milliseconds rather than a
 * whole extra round trip.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { choiceConfidence, type DecisionsClient } from "./decisions-client.js";
import { splitFrontmatter } from "./frontmatter.js";
import type { Logger } from "./logger.js";
import { ManifestError, ManifestStore, type LoadedManifest } from "./manifest.js";
import { isInsideVault, relativeToVault } from "./paths.js";
import { RouteCache, defaultRouteCache } from "./cache.js";
import type {
	ChoiceAnswer,
	Hop,
	ManifestEntry,
	Question,
	TraversalDocument,
	TraversalResult,
	TraversalStatus,
} from "./types.js";

/**
 * What the traverser needs to run. `BrainConfig` is a superset of this, so it
 * satisfies the interface structurally — the traverser does not need to know
 * about Pi-specific settings like `displayInjection`.
 */
export interface TraverserOptions {
	vaultRoot: string;
	maxHops: number;
	minConfidence: number;
	gateEnabled: boolean;
	gateThreshold: number;
	/** `"auto"`: the nearest note marked `fallback: true`; a path: that note; `""`: none. */
	fallbackDocument: string;
	maxDocumentChars: number;
	maxPromptChars: number;
	watchManifests: boolean;
	/** Ceiling on the whole route, every hop and retry included. Unlimited when absent or 0. */
	routeBudgetMs?: number;
	/** Defaults to true when absent. */
	enabled?: boolean;
	/** Use the local route cache. Off when absent: the routing check relies on that. */
	useCache?: boolean;
	/** Support multi-document composite routing for cross-cutting prompts. Defaults to true. */
	compositeEnabled?: boolean;
	/** Minimum probability for a branch/leaf to qualify as a composite candidate. Defaults to 0.25. */
	compositeThreshold?: number;
	/** Minimum ratio of candidate probability to winner probability to qualify. Defaults to 0.65. */
	compositeMarginRatio?: number;
	/** Maximum number of complementary guides to retrieve under composite routing. Defaults to 2. */
	maxCompositeDocuments?: number;
}

const ROUTE_QUESTION = "route_selection";
const GATE_QUESTION = "needs_reference";

const ROUTE_INSTRUCTIONS =
	"Select the reference manual most relevant to the developer prompt.";
const GATE_INSTRUCTIONS =
	"Does answering this developer prompt require consulting a technical reference manual? " +
	"Answer no for greetings, small talk, and simple questions answerable without documentation.";

type Finish = (status: TraversalStatus, reason: string, extra?: Partial<TraversalResult>) => TraversalResult;

function routeQuestion(manifest: LoadedManifest): Question {
	const criteria: Record<string, string> = {};
	for (const entry of manifest.entries) criteria[entry.id] = entry.criteria;
	return { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria };
}

/** A hop's name in the trail: the file for a leaf, the id for a folder. */
function label(entry: ManifestEntry): string {
	return entry.type === "leaf" ? basename(entry.targetPath) : entry.id;
}

/** Words that carry no topic: a prompt made only of these cannot need a reference guide. */
const ACKNOWLEDGEMENT_WORDS = new Set(
	(
		"y yes yeah yep yup no nope ok okay k kk sure thanks thank you thx ty cheers continue go on ahead proceed " +
		"carry keep going next done great nice cool perfect sounds looks good lgtm agree agreed do it ship please mate"
	).split(" "),
);

/** A follow-up so short and content-free that no reference guide could apply to it. */
export function isTrivialFollowUp(state: string): boolean {
	if (state.length > 40) return false;
	const words = state.toLowerCase().split(/[\s,.!?;:]+/).filter(Boolean);
	return words.length > 0 && words.length <= 4 && words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word));
}

/** Cut to at most `limit` UTF-16 units without splitting a surrogate pair. */
export function sliceCodePoints(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let cut = text.slice(0, limit);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut;
}

/** Close a Markdown code fence left open by truncation, so the rest of the prompt is not swallowed by it. */
export function closeOpenFence(content: string): string {
	let open: string | null = null;
	for (const line of content.split("\n")) {
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence) continue;
		if (open === null) open = fence;
		else if (fence[0] === open[0] && fence.length >= open.length) open = null;
	}
	return open === null ? content : `${content}\n${open}`;
}

/**
 * Allocates a unified character budget across multiple documents.
 * Fairly divides headroom so short documents stay intact and remaining
 * budget is redistributed to longer documents, with Markdown code fences closed cleanly.
 */
export function allocateUnifiedContextBudget(
	documents: TraversalDocument[],
	maxTotalChars: number,
): TraversalDocument[] {
	if (documents.length === 0) return [];
	if (maxTotalChars <= 0) return documents;

	const totalOriginal = documents.reduce((sum, doc) => sum + doc.originalLength, 0);
	if (totalOriginal <= maxTotalChars) {
		return documents.map((doc) => ({
			...doc,
			truncated: false,
		}));
	}

	// Dynamic allocation with redistribution:
	const allocated = new Map<string, number>();
	let remainingBudget = maxTotalChars;
	let undecided = [...documents];

	// Iteratively satisfy documents whose original length is <= fairShare
	let progress = true;
	while (progress && undecided.length > 0) {
		progress = false;
		const fairShare = Math.floor(remainingBudget / undecided.length);
		const stillUndecided: TraversalDocument[] = [];

		for (const doc of undecided) {
			if (doc.originalLength <= fairShare) {
				allocated.set(doc.id, doc.originalLength);
				remainingBudget -= doc.originalLength;
				progress = true;
			} else {
				stillUndecided.push(doc);
			}
		}

		undecided = stillUndecided;
	}

	// Remaining undecided documents share what's left
	if (undecided.length > 0) {
		const perDoc = Math.floor(remainingBudget / undecided.length);
		for (const doc of undecided) {
			allocated.set(doc.id, Math.max(0, perDoc));
		}
	}

	// Apply allocations and truncation
	return documents.map((doc) => {
		const budget = allocated.get(doc.id) ?? doc.originalLength;
		if (doc.originalLength <= budget) {
			return {
				...doc,
				truncated: false,
			};
		}

		let content = doc.content.trim();
		const cut = content.lastIndexOf("\n", budget);
		content = closeOpenFence(sliceCodePoints(content, cut > budget * 0.5 ? cut : budget).trimEnd());

		return {
			...doc,
			content,
			truncated: true,
		};
	});
}

/** Where one walk down the tree ended. */
interface BranchResult {
	document: TraversalDocument | null;
	hops: Hop[];
	segments: string[];
	/** Every manifest walked through, root first; the fallback search runs back up it. */
	visited: LoadedManifest[];
	minConfidence: number;
	status: TraversalStatus;
	reason: string;
	warnings: string[];
	/** The decisions service failed: no evidence any guide is right, so no fallback either. */
	serviceDown?: boolean;
}

export class BrainTraverser {
	private readonly manifests: ManifestStore;
	private readonly cache: RouteCache;
	/** Cached routes are only valid for the settings that produced them; Pi and the Claude Code hook differ. */
	private readonly cacheScope: string;

	constructor(
		private readonly config: TraverserOptions,
		private readonly client: DecisionsClient,
		private readonly logger: Logger,
		cache?: RouteCache,
	) {
		this.manifests = new ManifestStore(config.vaultRoot, config.watchManifests);
		this.cache = cache ?? defaultRouteCache;
		const c = config;
		this.cacheScope = JSON.stringify([
			client.endpoint,
			client.model,
			c.maxHops,
			c.minConfidence,
			c.gateEnabled,
			c.gateThreshold,
			c.fallbackDocument,
			c.maxDocumentChars,
			c.maxPromptChars,
			c.compositeEnabled,
			c.compositeThreshold,
			c.compositeMarginRatio,
			c.maxCompositeDocuments,
		]);
	}

	/** Drop cached manifests and route cache; used by the `/brain reload` command. */
	reload(): void {
		this.manifests.clear();
		this.cache.clear(this.config.vaultRoot);
	}

	async route(prompt: string): Promise<TraversalResult> {
		const started = performance.now();
		const deadline = this.config.routeBudgetMs ? started + this.config.routeBudgetMs : undefined;
		const hops: Hop[] = [];
		const segments = ["Root"];
		const warnings: string[] = [];

		const finish: Finish = (status, reason, extra = {}) => {
			const docs = extra.documents ?? (extra.document ? [extra.document] : undefined);
			const primaryDoc = extra.document ?? (docs && docs.length > 0 ? docs[0] : undefined);
			const res: TraversalResult = {
				status,
				reason,
				hops,
				trail: segments.join(" -> "),
				minConfidence: hops.length ? Math.min(...hops.map((h) => h.confidence)) : 1,
				totalMs: performance.now() - started,
				...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
				...extra,
				...(primaryDoc ? { document: primaryDoc } : {}),
				...(docs ? { documents: docs } : {}),
			};
			if (
				this.config.useCache === true &&
				(status === "leaf" || status === "composite" || status === "fallback" || status === "skipped")
			) {
				this.cache.set(prompt, this.config.vaultRoot, res, this.cacheScope);
			}
			return res;
		};

		if (this.config.enabled === false) {
			return finish("disabled", "brain-traverse is disabled by configuration");
		}
		if (!this.config.vaultRoot) return finish("no-index", "vaultRoot is not configured");

		if (this.config.useCache === true) {
			const cached = this.cache.get(prompt, this.config.vaultRoot, this.cacheScope);
			if (cached) {
				return cached;
			}
		}

		const state = this.toState(prompt);
		if (!state) return finish("skipped", "prompt is empty after normalisation");
		if (this.config.gateEnabled && isTrivialFollowUp(state)) {
			// "yes", "thanks", "continue": the gate would say no anyway, so skip the round trip.
			return finish("skipped", "a short acknowledgement; no reference needed");
		}

		const rootDir = resolve(this.config.vaultRoot);
		let loaded: LoadedManifest | null;
		try {
			loaded = this.manifests.load(rootDir);
		} catch (error) {
			if (error instanceof ManifestError) {
				return this.withFallback(finish, [], "error", `malformed manifest: ${error.message}`, undefined);
			}
			throw error;
		}
		if (!loaded) return finish("no-index", `no _index.json at the vault root (${this.manifests.relativeToVault(rootDir)})`);
		const root = loaded;
		const visited = [root];

		const questions: Record<string, Question> = { [ROUTE_QUESTION]: routeQuestion(root) };
		if (this.config.gateEnabled) {
			questions[GATE_QUESTION] = { type: "noul", instructions: GATE_INSTRUCTIONS };
		}

		const outcome = await this.client.ask(state, questions, { deadline });
		if (!outcome.ok) {
			// Deliberately no fallback document here: if the decisions service is
			// down we have no evidence any guide is the right one.
			return finish("error", `decisions API failed: ${outcome.error}`);
		}
		if (outcome.warnings) warnings.push(...outcome.warnings);

		let gate: TraversalResult["gate"];
		if (this.config.gateEnabled) {
			const answer = outcome.answers[GATE_QUESTION];
			if (answer && answer.type === "noul" && typeof answer.noul === "number") {
				gate = { needed: answer.noul >= this.config.gateThreshold, probability: answer.noul };
				if (!gate.needed) {
					return finish(
						"skipped",
						`gate says no reference needed (p=${answer.noul.toFixed(3)} < ${this.config.gateThreshold})`,
						{ gate },
					);
				}
			} else {
				this.logger.debug("gate question returned no noul answer; continuing without it");
			}
		}

		const answer = outcome.answers[ROUTE_QUESTION];
		if (!answer || answer.type !== "choice") {
			return this.withFallback(finish, visited, "error", "decisions API returned no choice answer", gate);
		}

		const entry = root.entries.find((candidate) => candidate.id === answer.choice);
		if (!entry) {
			// Guard against a label that is not on the menu; without this the
			// traverser would try to descend into a directory that does not exist.
			return this.withFallback(
				finish,
				visited,
				"error",
				`model chose '${answer.choice}', which is not in ${this.manifests.relativeToVault(rootDir)}/_index.json`,
				gate,
			);
		}

		const firstHop = this.hop(root, entry, answer, outcome.serverMs ?? outcome.latencyMs);

		/** The route is the top choice's walk: its note, or the fallback when it found none. */
		const conclude = (branch: BranchResult): TraversalResult => {
			hops.push(...branch.hops);
			segments.push(...branch.segments.slice(1));
			warnings.push(...branch.warnings);
			if (branch.document) {
				const document = allocateUnifiedContextBudget([branch.document], this.config.maxDocumentChars)[0];
				return finish("leaf", branch.reason, { document, gate });
			}
			if (branch.serviceDown) return finish("error", branch.reason, { gate });
			return this.withFallback(finish, branch.visited, branch.status, branch.reason, gate);
		};

		const runnersUp = this.runnersUp(root, entry, answer, firstHop.confidence);
		if (runnersUp.length === 0) {
			return conclude(await this.walk(root, entry, firstHop, true, state, deadline, visited));
		}

		// Composite routing: walk the top choice and its close runners-up in parallel.
		const branches = await Promise.all([
			this.walk(root, entry, firstHop, true, state, deadline, visited),
			...runnersUp.map((candidate) =>
				this.walk(
					root,
					candidate,
					// One request decided every first hop; its latency is counted on the top choice only.
					this.hop(root, candidate, answer, 0, choiceConfidence({ choice: candidate.id, probabilities: answer.probabilities })),
					false,
					state,
					deadline,
					visited,
				),
			),
		]);

		const uniqueDocs: TraversalDocument[] = [];
		const seenPaths = new Set<string>();
		for (const branch of branches) {
			if (branch.document && !seenPaths.has(branch.document.path)) {
				seenPaths.add(branch.document.path);
				uniqueDocs.push({ ...branch.document, confidence: branch.minConfidence, trail: branch.segments.join(" -> ") });
			}
		}

		// A runner-up never stands alone: on its own it was not confident enough to route to.
		if (uniqueDocs.length < 2) return conclude(branches[0]);

		for (const branch of branches) {
			hops.push(...branch.hops);
			warnings.push(...branch.warnings);
		}
		const budgeted = allocateUnifiedContextBudget(uniqueDocs, this.config.maxDocumentChars);
		return finish("composite", `composite route resolved ${budgeted.length} complementary guides`, {
			document: budgeted[0],
			documents: budgeted,
			composite: true,
			trail: `Composite [${budgeted.map((d) => d.trail ?? d.path).join(", ")}]`,
			minConfidence: Math.min(...budgeted.map((d) => d.confidence ?? 1)),
			gate,
		});
	}

	// -----------------------------------------------------------------------

	/** Normalise the prompt into the `state` the model reads. */
	private toState(prompt: string): string {
		const text = (prompt ?? "").replace(/\s+/g, " ").trim();
		// The English checkpoint's context is 512 tokens and the criteria block
		// eats into it. The routing signal is almost always in the opening lines,
		// so keep the head rather than the tail.
		return sliceCodePoints(text, this.config.maxPromptChars);
	}

	private readRawDocument(path: string, entry: ManifestEntry): TraversalDocument | null {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			return null;
		}

		const { title, body } = splitFrontmatter(raw);
		const content = body.trim();
		return {
			id: entry.id,
			title: entry.title ?? title ?? entry.id,
			path: this.manifests.relativeToVault(path),
			content,
			truncated: false,
			originalLength: content.length,
		};
	}

	private readDocument(path: string, entry: ManifestEntry): TraversalDocument | null {
		const raw = this.readRawDocument(path, entry);
		if (!raw) return null;
		const budgeted = allocateUnifiedContextBudget([raw], this.config.maxDocumentChars);
		return budgeted[0] ?? null;
	}

	private hop(manifest: LoadedManifest, entry: ManifestEntry, answer: ChoiceAnswer, latencyMs: number, confidence = choiceConfidence(answer)): Hop {
		return {
			from: this.manifests.relativeToVault(manifest.dir),
			chosen: entry.id,
			type: entry.type,
			confidence,
			latencyMs,
			probabilities: answer.probabilities,
			optionCount: manifest.entries.length,
		};
	}

	/** Root options close enough to the top choice to route to alongside it, best first. */
	private runnersUp(root: LoadedManifest, entry: ManifestEntry, answer: ChoiceAnswer, confidence: number): ManifestEntry[] {
		const probabilities = answer.probabilities;
		const maxDocs = this.config.maxCompositeDocuments ?? 2;
		if (this.config.compositeEnabled === false || maxDocs < 2 || confidence < this.config.minConfidence || !probabilities) {
			return [];
		}
		const threshold = this.config.compositeThreshold ?? 0.25;
		const marginRatio = this.config.compositeMarginRatio ?? 0.65;
		const winnerProb = probabilities[entry.id] ?? confidence;
		return root.entries
			.filter((candidate) => {
				if (candidate.id === entry.id) return false;
				const p = probabilities[candidate.id];
				return typeof p === "number" && Number.isFinite(p) && p >= threshold && p >= winnerProb * marginRatio;
			})
			.sort((a, b) => probabilities[b.id] - probabilities[a.id])
			.slice(0, maxDocs - 1);
	}

	/**
	 * Walk down from `entry`, the root's choice already decided as `firstHop`, to a leaf.
	 * `checkFirst` holds that first hop to the confidence threshold too; a composite
	 * runner-up skips it, having passed the composite threshold instead.
	 */
	private async walk(
		root: LoadedManifest,
		entry: ManifestEntry,
		firstHop: Hop,
		checkFirst: boolean,
		state: string,
		deadline: number | undefined,
		visited: LoadedManifest[],
	): Promise<BranchResult> {
		const hops: Hop[] = [firstHop];
		const segments = ["Root", label(entry)];
		const warnings: string[] = [];
		const branchVisited = [...visited];

		const end = (status: TraversalStatus, reason: string, document: TraversalDocument | null = null, serviceDown = false): BranchResult => ({
			document,
			hops,
			segments,
			visited: branchVisited,
			minConfidence: Math.min(...hops.map((h) => h.confidence)),
			status,
			reason,
			warnings,
			...(serviceDown ? { serviceDown } : {}),
		});

		const unsure = (hop: Hop, n: number): BranchResult | null => {
			if (hop.confidence < this.config.minConfidence) {
				return end("low-confidence", `confidence ${hop.confidence.toFixed(3)} below threshold ${this.config.minConfidence} at hop ${n}`);
			}
			return null;
		};

		if (checkFirst) {
			const stop = unsure(firstHop, 1);
			if (stop) return stop;
		}

		let manifest = root;
		let chosen = entry;
		for (let hop = 1; ; hop++) {
			let target: string;
			try {
				target = this.manifests.resolveTarget(manifest, chosen);
			} catch (error) {
				return end("error", (error as Error).message);
			}

			if (chosen.type === "leaf") {
				const document = this.readRawDocument(target, chosen);
				if (!document) return end("error", `leaf '${chosen.id}' points at a missing file: ${chosen.targetPath}`);
				return end("leaf", `routed in ${hops.length} hop(s)`, document);
			}
			if (hop >= this.config.maxHops) {
				return end("max-hops", `hit the ${this.config.maxHops}-hop ceiling without reaching a leaf`);
			}

			let next: LoadedManifest | null;
			try {
				next = this.manifests.load(target);
			} catch (error) {
				return end("error", error instanceof ManifestError ? `malformed manifest: ${error.message}` : (error as Error).message);
			}
			// A branch pointing at a directory with no manifest is a vault bug,
			// not a reason to abandon the turn.
			if (!next) return end("no-index", `no _index.json in '${this.manifests.relativeToVault(target)}'`);
			manifest = next;
			branchVisited.push(manifest);

			const outcome = await this.client.ask(state, { [ROUTE_QUESTION]: routeQuestion(manifest) }, { deadline });
			if (!outcome.ok) return end("error", `decisions API failed: ${outcome.error}`, null, true);
			if (outcome.warnings) warnings.push(...outcome.warnings);

			const answer = outcome.answers[ROUTE_QUESTION];
			if (!answer || answer.type !== "choice") return end("error", "decisions API returned no choice answer");

			const found = manifest.entries.find((candidate) => candidate.id === answer.choice);
			if (!found) {
				return end("error", `model chose '${answer.choice}', which is not in ${this.manifests.relativeToVault(target)}/_index.json`);
			}
			chosen = found;

			const taken = this.hop(manifest, chosen, answer, outcome.serverMs ?? outcome.latencyMs);
			hops.push(taken);
			segments.push(label(chosen));
			const stop = unsure(taken, hop + 1);
			if (stop) return stop;
		}
	}

	/**
	 * Swap in a catch-all note, if the vault has one.
	 *
	 * With `fallbackDocument: "auto"` the search runs from the folder where
	 * routing gave up back towards the root, so a confident first hop into
	 * `Backend/` followed by an unsure second one lands on Backend's own
	 * catch-all rather than discarding what the first hop established.
	 */
	private withFallback(
		finish: Finish,
		visited: LoadedManifest[],
		status: TraversalStatus,
		reason: string,
		gate: TraversalResult["gate"],
	): TraversalResult {
		this.logger.debug(`${status}: ${reason}`);
		const setting = this.config.fallbackDocument;
		if (!setting) return finish(status, reason, { gate });

		if (setting !== "auto") {
			const path = resolve(this.config.vaultRoot, setting);
			const document = isInsideVault(this.config.vaultRoot, path)
				? this.readDocument(path, { id: "fallback", type: "leaf", criteria: "", targetPath: setting })
				: null;
			if (!document) return finish(status, `${reason}; fallback '${setting}' not found`, { gate });
			return finish("fallback", reason, { document, gate });
		}

		let manifests = visited;
		if (manifests.length === 0) {
			// Nothing was walked (a malformed root manifest); try the root anyway.
			try {
				const root = this.manifests.load(resolve(this.config.vaultRoot));
				manifests = root ? [root] : [];
			} catch {
				manifests = [];
			}
		}

		for (const manifest of [...manifests].reverse()) {
			const entry = manifest.entries.find((candidate) => candidate.fallback && candidate.type === "leaf");
			if (!entry) continue;
			let document: TraversalResult["document"] | null = null;
			try {
				document = this.readDocument(this.manifests.resolveTarget(manifest, entry), entry);
			} catch {
				document = null;
			}
			if (!document) continue;
			const where = relativeToVault(this.config.vaultRoot, manifest.dir);
			return finish("fallback", where === "." ? reason : `${reason}; used the '${where}' catch-all`, {
				document,
				gate,
			});
		}

		return finish(status, `${reason}; no note is marked \`fallback: true\``, { gate });
	}
}
