/**
 * Scanning the vault and compiling `_index.json` manifests from it.
 *
 * The authoring model, in one sentence: **note frontmatter is the source of
 * truth and every `_index.json` is a build artifact.** A folder describes
 * itself in `_about.md`; a leaf describes itself in its own frontmatter; the
 * compiler turns both into the manifests the traverser reads. Nothing should
 * ever hand-edit a manifest, because the next compile would overwrite it.
 *
 * The compiler's contract with the traverser: **it never writes a manifest the
 * traverser would reject.** Problems it cannot fix (two notes with one label)
 * are reported as issues and the offending entries are left out, rather than
 * written into a file that would take the whole folder offline.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { isHashedId, parseNote, slugify } from "./frontmatter.js";
import { writeFileAtomic } from "./fsutil.js";
import {
	ABOUT_FILE,
	MANIFEST_FILE,
	MAX_CHILDREN,
	THIN_CRITERIA_WORDS,
	VERBOSE_CRITERIA_WORDS,
	serialiseManifest,
	wordCount,
} from "./manifest.js";
import { relativeToVault, resolveInVault } from "./paths.js";
import type {
	ManifestEntry,
	ParsedNote,
	VaultIssue,
	VaultIssueCode,
	VaultNode,
	VaultTree,
} from "./types.js";

/** Directories that are never part of the brain, beyond anything starting with `.`. */
const IGNORED_DIRS = new Set(["node_modules"]);

/** Vault-root file listing folders and notes that are not part of the brain, gitignore-style. */
export const IGNORE_FILE = ".brainignore";

/** The traverser's default hop ceiling, used when a caller does not pass its own. */
export const DEFAULT_MAX_HOPS = 4;

/** Locale-independent ordering, so a manifest compiles identically on every machine. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function issue(
	severity: VaultIssue["severity"],
	code: VaultIssueCode,
	path: string,
	message: string,
	remedy?: string,
): VaultIssue {
	return { severity, code, path, message, remedy };
}

// ---------------------------------------------------------------------------
// Reading notes
// ---------------------------------------------------------------------------

export interface ReadNote extends ParsedNote {
	absolutePath: string;
	path: string;
	raw: string;
}

export function readNote(vaultRoot: string, absolutePath: string): ReadNote {
	const raw = readFileSync(absolutePath, "utf8");
	return {
		...parseNote(raw),
		absolutePath,
		path: relativeToVault(vaultRoot, absolutePath),
		raw,
	};
}

/**
 * Parsed notes keyed by path and invalidated by mtime + size. Every keeper
 * operation rescans the whole vault; without this each one re-reads every note.
 */
const parseCache = new Map<string, { mtimeMs: number; size: number; note: ParsedNote }>();

function readParsed(absolutePath: string): ParsedNote {
	const { mtimeMs, size } = statSync(absolutePath);
	const cached = parseCache.get(absolutePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.note;
	const note = parseNote(readFileSync(absolutePath, "utf8"));
	parseCache.set(absolutePath, { mtimeMs, size, note });
	return note;
}

// ---------------------------------------------------------------------------
// Ignoring
// ---------------------------------------------------------------------------

type IgnoreTest = (path: string) => boolean;

function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*" && glob[index + 1] === "*") {
			source += ".*";
			index++;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`, "i");
}

/**
 * Read `.brainignore`: one pattern per line, `#` for comments. A pattern with a
 * `/` matches a vault-relative path; one without matches a name at any depth.
 * `*`, `**` and `?` work as in `.gitignore`. Matching a folder skips everything in it.
 */
export function loadIgnore(vaultRoot: string): IgnoreTest {
	let text = "";
	try {
		text = readFileSync(join(vaultRoot, IGNORE_FILE), "utf8");
	} catch {
		return () => false;
	}

	const anchored: RegExp[] = [];
	const names: RegExp[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+#.*$/, "").trim();
		if (!line || line.startsWith("#")) continue;
		const pattern = line.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!pattern) continue;
		(pattern.includes("/") ? anchored : names).push(globToRegExp(pattern));
	}

	return (path) => {
		const name = path.split("/").pop() ?? path;
		return anchored.some((pattern) => pattern.test(path)) || names.some((pattern) => pattern.test(name));
	};
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export interface ScanOptions {
	/** Stop descending below this depth. Deeper folders are reported, not scanned. */
	maxDepth?: number;
	/** The traverser's hop ceiling; folders it cannot reach are reported. */
	maxHops?: number;
}

interface ScanContext {
	root: string;
	maxDepth: number;
	maxHops: number;
	ignored: IgnoreTest;
	counts: { branches: number; leaves: number };
}

export function scanVault(vaultRoot: string, options: ScanOptions = {}): VaultTree {
	const root = resolve(vaultRoot);
	const context: ScanContext = {
		root,
		maxDepth: options.maxDepth ?? 8,
		maxHops: options.maxHops ?? DEFAULT_MAX_HOPS,
		ignored: loadIgnore(root),
		counts: { branches: 0, leaves: 0 },
	};

	const node = scanBranch(context, root, ".", 0);

	// The fallback note is what the traverser reaches for when routing is
	// inconclusive; without one at the root, a low-confidence hop injects nothing.
	// (A fallback inside a folder is that folder's own catch-all; see checkChildren.)
	const rootIssues: VaultIssue[] = [];
	if (!(node.children ?? []).some((child) => child.fallback)) {
		rootIssues.push(
			issue(
				"warning",
				"no-fallback",
				".",
				"no note at the vault root is marked `fallback: true`",
				"add `fallback: true` to the frontmatter of your catch-all note (e.g. general_instructions.md)",
			),
		);
	}

	return {
		root: node,
		issues: [...rootIssues, ...flatten(node).flatMap((each) => each.issues)],
		counts: context.counts,
	};
}

/** Resolve a node's id: an explicit `id:` normalised to a slug, else a slug of its name. */
function resolveId(declared: string | undefined, name: string, path: string, own: VaultIssue[]): string {
	const explicit = declared?.trim();
	if (explicit) {
		const id = slugify(explicit);
		if (id !== explicit) {
			own.push(
				issue(
					"info",
					"non-slug-id",
					path,
					`id '${explicit}' is used as the routing label '${id}'`,
					`write \`id: ${id}\` so the frontmatter matches the label the router sees`,
				),
			);
		}
		return id;
	}

	const id = slugify(name);
	if (isHashedId(id)) {
		own.push(
			issue(
				"warning",
				"hashed-id",
				path,
				`the name has no Latin letters or digits, so its routing label is the unreadable '${id}'`,
				"add a readable `id:` (e.g. `id: database_notes`) to the frontmatter",
			),
		);
	}
	return id;
}

function frontmatterIssues(note: ParsedNote | undefined, path: string, own: VaultIssue[]): void {
	for (const problem of note?.problems ?? []) {
		own.push(
			issue("warning", "bad-frontmatter", path, problem, "rewrite the frontmatter as plain `key: value` lines"),
		);
	}
}

function scanBranch(context: ScanContext, absolutePath: string, path: string, depth: number): VaultNode {
	const own: VaultIssue[] = [];
	const aboutPath = join(absolutePath, ABOUT_FILE);

	let about: ParsedNote | undefined;
	try {
		about = existsSync(aboutPath) ? readParsed(aboutPath) : undefined;
	} catch (error) {
		own.push(issue("error", "unreadable", `${path}/${ABOUT_FILE}`, `cannot read: ${(error as Error).message}`));
	}
	frontmatterIssues(about, path === "." ? ABOUT_FILE : `${path}/${ABOUT_FILE}`, own);

	const folderName = path === "." ? basename(absolutePath) : basename(path);
	const title = about?.frontmatter.title || folderName;
	const id = path === "." ? slugify(folderName) : resolveId(about?.frontmatter.id, folderName, path, own);

	// A manifest entry must carry non-empty criteria or the traverser rejects it,
	// so an undescribed folder gets its title as a placeholder and a loud error.
	let criteria = (about?.frontmatter.criteria ?? "").trim();
	if (!criteria) {
		criteria = title;
		if (path !== ".") {
			own.push(
				issue(
					"error",
					about ? "missing-criteria" : "missing-about",
					path,
					about
						? `${ABOUT_FILE} has no \`criteria\` field, so the router has only the folder name to go on`
						: `folder has no ${ABOUT_FILE}, so the router has only the folder name to go on`,
					`write ${path}/${ABOUT_FILE} with a 10-25 word \`criteria\` describing what belongs in this folder`,
				),
			);
		}
	}

	if (depth === context.maxHops) {
		own.push(
			issue(
				"warning",
				"too-deep",
				path,
				`notes in this folder need ${depth + 1} hops to reach, but the router stops after ${context.maxHops}`,
				"move this folder up a level, or raise `maxHops` in the config",
			),
		);
	}

	const node: VaultNode = {
		kind: "branch",
		id,
		title,
		criteria,
		fallback: false,
		absolutePath,
		path,
		aboutPath: about ? aboutPath : undefined,
		children: [],
		issues: own,
	};
	context.counts.branches++;

	let dirEntries: string[];
	try {
		dirEntries = readdirSync(absolutePath);
	} catch (error) {
		own.push(issue("error", "unreadable", path, `cannot read directory: ${(error as Error).message}`));
		return node;
	}

	const branches: VaultNode[] = [];
	const leaves: VaultNode[] = [];

	for (const name of dirEntries.sort(compareText)) {
		if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;
		if (name === MANIFEST_FILE || name === ABOUT_FILE) continue;

		const childAbsolute = join(absolutePath, name);
		const childPath = path === "." ? name : `${path}/${name}`;
		if (context.ignored(childPath)) continue;

		let stats;
		try {
			stats = statSync(childAbsolute);
		} catch {
			own.push(issue("error", "unreadable", childPath, "cannot stat this entry"));
			continue;
		}

		if (stats.isDirectory()) {
			if (depth + 1 > context.maxDepth) {
				own.push(
					issue(
						"warning",
						"too-deep",
						childPath,
						`folder is nested more than ${context.maxDepth} levels deep and is not scanned`,
						"move it closer to the vault root",
					),
				);
				continue;
			}
			branches.push(scanBranch(context, childAbsolute, childPath, depth + 1));
			continue;
		}

		// Only markdown becomes a leaf; attachments and images are ignored.
		if (extname(name).toLowerCase() !== ".md") continue;
		leaves.push(scanLeaf(context, childAbsolute, childPath));
	}

	// Deterministic order: branches, then leaves, then the catch-all last. A
	// stable order means recompiling an unchanged vault produces no diff.
	const sortById = (a: VaultNode, b: VaultNode) => compareText(a.id, b.id);
	const normalLeaves = leaves.filter((leaf) => !leaf.fallback).sort(sortById);
	const fallbackLeaves = leaves.filter((leaf) => leaf.fallback).sort(sortById);
	node.children = [...branches.sort(sortById), ...normalLeaves, ...fallbackLeaves];

	checkChildren(node, own);
	return node;
}

function scanLeaf(context: ScanContext, absolutePath: string, path: string): VaultNode {
	const own: VaultIssue[] = [];
	const fileName = basename(absolutePath, extname(absolutePath));

	let note: ParsedNote;
	try {
		note = readParsed(absolutePath);
	} catch (error) {
		own.push(issue("error", "unreadable", path, `cannot read note: ${(error as Error).message}`));
		note = { frontmatter: {}, extraLines: [], hadFrontmatter: false, body: "" };
	}
	frontmatterIssues(note, path, own);

	const title = note.frontmatter.title || fileName;
	const id = resolveId(note.frontmatter.id, fileName, path, own);
	let criteria = (note.frontmatter.criteria ?? "").trim();

	if (!criteria) {
		criteria = title;
		own.push(
			issue(
				"error",
				"missing-criteria",
				path,
				"note has no `criteria` frontmatter, so the router has only its title to go on",
				"add a 10-25 word `criteria` naming the trigger words and intents that should select this note",
			),
		);
	}

	if (note.body.trim().length === 0) {
		own.push(
			issue("warning", "empty-body", path, "note has no content; routing here would inject nothing useful"),
		);
	}

	context.counts.leaves++;

	return {
		kind: "leaf",
		id,
		title,
		criteria,
		fallback: note.frontmatter.fallback === true,
		absolutePath,
		path,
		issues: own,
	};
}

/** A node the router can usefully descend into: a leaf, or a folder with something routable in it. */
export function isRoutable(node: VaultNode): boolean {
	return node.kind === "leaf" || (node.children ?? []).some(isRoutable);
}

/** Checks that only make sense across a folder's children. */
function checkChildren(node: VaultNode, own: VaultIssue[]): void {
	const children = node.children ?? [];

	if (children.length === 0) {
		own.push(
			issue(
				"error",
				"empty-branch",
				node.path,
				"folder has no notes or subfolders, so the router cannot route into it",
				"add a note here, or remove the folder; until then its parent leaves it out",
			),
		);
		return;
	}

	if (children.length > MAX_CHILDREN) {
		own.push(
			issue(
				"error",
				"too-many-children",
				node.path,
				`${children.length} children exceeds the ${MAX_CHILDREN} limit; ` +
					`the decision model spreads a fixed option budget over every label, so each gets too little to describe itself`,
				`split this folder — brain_split_branch moves a themed subset into a new subfolder`,
			),
		);
	}

	const fallbacks = children.filter((child) => child.fallback);
	if (fallbacks.length > 1) {
		own.push(
			issue(
				"warning",
				"multiple-fallbacks",
				node.path,
				`${fallbacks.length} notes here are marked as the fallback: ${fallbacks.map((child) => child.id).join(", ")}`,
				"mark exactly one catch-all note per folder",
			),
		);
	}

	const byId = new Map<string, VaultNode[]>();
	const byCriteria = new Map<string, VaultNode[]>();

	for (const child of children) {
		byId.set(child.id, [...(byId.get(child.id) ?? []), child]);
		const key = child.criteria.toLowerCase().replace(/\s+/g, " ").trim();
		byCriteria.set(key, [...(byCriteria.get(key) ?? []), child]);

		const words = wordCount(child.criteria);
		if (words > 0 && words < THIN_CRITERIA_WORDS) {
			own.push(
				issue(
					"warning",
					"thin-criteria",
					child.path,
					`criteria is ${words} word(s); too little for the model to discriminate on`,
					"aim for 10-25 words of distinct domain keywords and typical user intents",
				),
			);
		} else if (words > VERBOSE_CRITERIA_WORDS) {
			own.push(
				issue(
					"warning",
					"verbose-criteria",
					child.path,
					`criteria is ${words} words; the option budget will truncate it`,
					"cut it to 10-25 words, keeping only the discriminating terms",
				),
			);
		}
	}

	for (const [id, nodes] of byId) {
		if (nodes.length > 1) {
			own.push(
				issue(
					"error",
					"duplicate-id",
					node.path,
					`id '${id}' is used by ${nodes.length} children: ${nodes.map((n) => n.path).join(", ")}; ` +
						`only ${nodes[0].path} is routable until they differ`,
					"give each note a distinct `id` in its frontmatter",
				),
			);
		}
	}

	for (const [, nodes] of byCriteria) {
		if (nodes.length > 1) {
			own.push(
				issue(
					"warning",
					"duplicate-criteria",
					node.path,
					`these siblings have identical criteria, so the model cannot tell them apart: ` +
						nodes.map((n) => n.id).join(", "),
					"rewrite each criteria to name what is unique about that note",
				),
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

/**
 * The manifest entries for a folder: its routable children, with any repeat of
 * an id dropped so the file stays one the traverser accepts. The first child
 * with an id keeps it; the rest are reported by the doctor as `duplicate-id`.
 */
export function manifestFor(node: VaultNode): { entries: ManifestEntry[]; dropped: string[] } {
	const entries: ManifestEntry[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();

	for (const child of node.children ?? []) {
		if (!isRoutable(child)) continue;
		if (seen.has(child.id)) {
			dropped.push(child.path);
			continue;
		}
		seen.add(child.id);

		const entry: ManifestEntry = {
			id: child.id,
			type: child.kind,
			criteria: child.criteria,
			targetPath: basename(child.absolutePath),
		};
		if (child.title && child.title !== child.id) entry.title = child.title;
		if (child.fallback) entry.fallback = true;
		entries.push(entry);
	}

	return { entries, dropped };
}

export interface CompiledFile {
	/** Vault-relative path of the manifest. */
	path: string;
	status: "written" | "unchanged" | "skipped";
	entries: number;
	reason?: string;
}

export interface CompileResult {
	files: CompiledFile[];
	issues: VaultIssue[];
	counts: { branches: number; leaves: number };
	/** The scan the compile was based on, so callers need not scan again. */
	tree: VaultTree;
}

export interface CompileOptions {
	/** Report what would change without touching disk. */
	dryRun?: boolean;
	/** Compile only this subtree (vault-relative). Defaults to the whole vault. */
	subtree?: string;
	/** The traverser's hop ceiling, for the `too-deep` check. */
	maxHops?: number;
}

export function compileVault(vaultRoot: string, options: CompileOptions = {}): CompileResult {
	const root = resolve(vaultRoot);
	const tree = scanVault(root, { maxHops: options.maxHops });
	const files: CompiledFile[] = [];

	const start = options.subtree
		? findNode(tree.root, relativeToVault(root, resolveInVault(root, options.subtree, "subtree")))
		: tree.root;

	if (!start) {
		throw new Error(`no such folder in the vault: ${options.subtree}`);
	}

	compileNode(start, files, options.dryRun === true);

	return { files, issues: collectIssues(tree), counts: tree.counts, tree };
}

function compileNode(node: VaultNode, files: CompiledFile[], dryRun: boolean): void {
	if (node.kind !== "branch") return;

	const { entries, dropped } = manifestFor(node);
	const manifestPath = join(node.absolutePath, MANIFEST_FILE);
	const displayPath = node.path === "." ? MANIFEST_FILE : `${node.path}/${MANIFEST_FILE}`;

	if (entries.length === 0) {
		// An empty array is not a valid manifest, and writing one would make the
		// traverser throw rather than fall back. The parent leaves this folder out.
		files.push({ path: displayPath, status: "skipped", entries: 0, reason: "folder has no children to route to" });
	} else {
		const next = serialiseManifest(entries);
		let current: string | null = null;
		try {
			current = readFileSync(manifestPath, "utf8");
		} catch {
			current = null;
		}

		const reason = dropped.length ? `left out duplicate id(s): ${dropped.join(", ")}` : undefined;
		if (current === next) {
			files.push({ path: displayPath, status: "unchanged", entries: entries.length, reason });
		} else {
			if (!dryRun) writeFileAtomic(manifestPath, next);
			files.push({ path: displayPath, status: "written", entries: entries.length, reason });
		}
	}

	for (const child of node.children ?? []) compileNode(child, files, dryRun);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function findNode(node: VaultNode, path: string): VaultNode | undefined {
	if (node.path === path) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, path);
		if (found) return found;
	}
	return undefined;
}

export function flatten(node: VaultNode, into: VaultNode[] = []): VaultNode[] {
	into.push(node);
	for (const child of node.children ?? []) flatten(child, into);
	return into;
}

/** Every issue in the tree, deduplicated and ordered worst-first. */
export function collectIssues(tree: VaultTree): VaultIssue[] {
	const rank = { error: 0, warning: 1, info: 2 };
	const seen = new Set<string>();
	const unique = tree.issues.filter((item) => {
		const key = `${item.code}|${item.path}|${item.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	return unique.sort((a, b) => rank[a.severity] - rank[b.severity] || compareText(a.path, b.path));
}

/** Create a folder inside the vault, refusing anything outside it. */
export function ensureFolder(vaultRoot: string, folder: string): string {
	const absolute = resolveInVault(vaultRoot, folder, "folder");
	mkdirSync(absolute, { recursive: true });
	return absolute;
}
