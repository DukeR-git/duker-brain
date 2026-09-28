/**
 * Every mutation the keeper can make to the vault.
 *
 * Four rules hold throughout:
 *
 *  1. **Frontmatter is the source of truth.** A write touches a `.md` file and
 *     then recompiles manifests from what is on disk. No operation ever edits
 *     an `_index.json` directly — the next compile would overwrite it anyway.
 *  2. **Every operation recompiles the whole vault.** Working out exactly which
 *     folders a move touched is the kind of bookkeeping that silently goes
 *     wrong; the scan caches parsed notes, so a recompile stays cheap. The
 *     result reports only the manifests that actually changed.
 *  3. **One writer at a time.** Each operation holds the vault lock, so the MCP
 *     server, Pi's tools, the CLI and the watcher cannot interleave.
 *  4. **Nothing is destroyed.** Writes are atomic, and "remove" moves things to
 *     the vault's `.trash/` — Obsidian's own convention — where they can be restored.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { parseNote, serialiseNote, slugify } from "../../brain-core/src/frontmatter.js";
import { withVaultLock, writeFileAtomic } from "../../brain-core/src/fsutil.js";
import { ABOUT_FILE, MANIFEST_FILE, MAX_CHILDREN } from "../../brain-core/src/manifest.js";
import { isInsideVault, relativeToVault, resolveInVault } from "../../brain-core/src/paths.js";
import { defaultRouteCache } from "../../brain-core/src/index.js";
import type { CompiledFile } from "../../brain-core/src/vault.js";
import { DEFAULT_MAX_HOPS, compileVault, findNode, flatten, scanVault } from "../../brain-core/src/vault.js";
import type { ParsedNote, VaultIssue, VaultNode } from "../../brain-core/src/types.js";

export class OperationError extends Error {}

export interface FileChange {
	action: "created" | "updated" | "deleted" | "moved" | "trashed";
	/** Vault-relative path after the change. */
	path: string;
	/** Vault-relative path before the change, for moves. */
	from?: string;
	detail?: string;
}

export interface ChangeSet {
	summary: string;
	changes: FileChange[];
	/** Manifests that changed as a result, reported by the compiler. */
	manifests: CompiledFile[];
	/** Things the caller should probably act on next. */
	warnings: string[];
	/** Full vault health after the change, worst-first. */
	issues: VaultIssue[];
}

/** Settings an operation needs from the config; all optional. */
export interface OperationOptions {
	/** The router's hop ceiling, for the `too-deep` check in the post-write report. */
	maxHops?: number;
}

/** Where removed notes and folders go, as in Obsidian. The scanner ignores it. */
export const TRASH_DIR = ".trash";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noteFileName(id: string): string {
	return `${id}.md`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A folder name that works on every platform and that the scanner will see:
 * no path separators or characters Windows rejects, no leading dot (the scanner
 * skips dotfolders, so `.NET` would vanish), no trailing dots or spaces
 * (Windows strips them), and not a reserved device name.
 */
export function safeFolderName(name: string): string {
	let safe = name
		.trim()
		.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (WINDOWS_RESERVED.test(safe)) safe = `${safe}_`;
	if (!safe) throw new OperationError(`cannot make a folder name from ${JSON.stringify(name)}`);
	return safe;
}

function buildNote(fields: {
	id: string;
	title: string;
	criteria: string;
	fallback?: boolean;
	content: string;
	preserve?: ParsedNote;
}): string {
	const base: ParsedNote = fields.preserve ?? {
		frontmatter: {},
		extraLines: [],
		hadFrontmatter: true,
		body: "",
	};

	return serialiseNote({
		...base,
		frontmatter: {
			...base.frontmatter,
			id: fields.id,
			title: fields.title,
			criteria: fields.criteria,
			fallback: fields.fallback ?? base.frontmatter.fallback,
		},
		body: fields.content.endsWith("\n") ? fields.content : `${fields.content}\n`,
	});
}

function assertMarkdown(path: string): void {
	// Name checks first: "_index.json is generated" tells the caller what to do
	// instead, where "not a markdown note" just states the obvious.
	const name = basename(path);
	if (name === ABOUT_FILE) {
		throw new OperationError(
			`${ABOUT_FILE} describes its folder and is not a note. Use brain_update_branch to change it.`,
		);
	}
	if (name === MANIFEST_FILE) {
		throw new OperationError(`${MANIFEST_FILE} is generated. Edit note frontmatter and rebuild instead.`);
	}
	if (!path.toLowerCase().endsWith(".md")) {
		throw new OperationError(`not a markdown note: ${path}`);
	}
}

function assertCriteria(criteria: string, what: string): string {
	const trimmed = (criteria ?? "").trim();
	if (!trimmed) {
		throw new OperationError(
			`${what} needs a \`criteria\`: 10-25 words naming the trigger words, domain keywords and ` +
				`user intents that should select it. Without one the router has only the title to go on.`,
		);
	}
	return trimmed;
}

function assertTitle(title: string | undefined, what: string): string {
	const trimmed = (title ?? "").trim();
	if (!trimmed) throw new OperationError(`${what} needs a non-empty title`);
	return trimmed;
}

/** A folder may have one catch-all; refuse a second rather than leave the router guessing. */
function assertSingleFallback(folder: VaultNode, exceptPath?: string): void {
	const existing = folder.children?.find((child) => child.fallback && child.path !== exceptPath);
	if (existing) {
		throw new OperationError(
			`${existing.path} is already the catch-all for '${folder.path}'. ` +
				`Unset it first (brain_update_note with fallback: false), then mark this note.`,
		);
	}
}

/** Recompile and fold the result into a ChangeSet. */
function finish(
	vaultRoot: string,
	summary: string,
	changes: FileChange[],
	warnings: string[],
	options: OperationOptions,
): ChangeSet {
	const compiled = compileVault(vaultRoot, { maxHops: options.maxHops ?? DEFAULT_MAX_HOPS });
	defaultRouteCache.clear(vaultRoot);
	return {
		summary,
		changes,
		manifests: compiled.files.filter((file) => file.status !== "unchanged"),
		warnings,
		issues: compiled.issues,
	};
}

function folderNode(vaultRoot: string, folder: string): VaultNode {
	const absolute = resolveInVault(vaultRoot, folder, "folder");
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
		throw new OperationError(
			`no such folder in the vault: ${folder || "."}. Create it with brain_add_branch first.`,
		);
	}
	const tree = scanVault(vaultRoot);
	const node = findNode(tree.root, relativeToVault(vaultRoot, absolute));
	if (!node) throw new OperationError(`folder is not part of the vault tree (ignored or hidden): ${folder}`);
	return node;
}

function overfullWarning(node: VaultNode, added: number): string[] {
	const total = (node.children?.length ?? 0) + added;
	if (total <= MAX_CHILDREN) return [];
	return [
		`'${node.path}' now has ${total} children, over the ${MAX_CHILDREN} limit. ` +
			`The decision model's option budget cannot describe them all, so routing accuracy here will degrade. ` +
			`Use brain_split_branch to move a themed subset into a subfolder.`,
	];
}

/** A free path in `.trash/` for `name`, numbering it the way Obsidian does on a clash. */
function trashDestination(vaultRoot: string, name: string): string {
	const trash = join(vaultRoot, TRASH_DIR);
	mkdirSync(trash, { recursive: true });
	const extension = extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;
	let candidate = join(trash, name);
	for (let index = 2; existsSync(candidate); index++) candidate = join(trash, `${stem} ${index}${extension}`);
	return candidate;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface AddNoteInput {
	folder: string;
	title: string;
	criteria: string;
	content: string;
	id?: string;
	fallback?: boolean;
	overwrite?: boolean;
}

export function addNote(vaultRoot: string, input: AddNoteInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const node = folderNode(vaultRoot, input.folder);
		const criteria = assertCriteria(input.criteria, "a note");
		const title = assertTitle(input.title, "a note");

		const id = slugify(input.id?.trim() || title);
		if (!id) throw new OperationError(`could not derive a usable id from ${JSON.stringify(input.id ?? title)}`);

		const absolute = join(node.absolutePath, noteFileName(id));
		const path = relativeToVault(vaultRoot, absolute);
		const exists = existsSync(absolute);

		if (exists && !input.overwrite) {
			throw new OperationError(
				`${path} already exists. Pass overwrite: true to replace it, or use brain_update_note to amend it.`,
			);
		}

		const clash = node.children?.find((child) => child.id === id && child.path !== path);
		if (clash) {
			throw new OperationError(
				`id '${id}' is already used by ${clash.path} in this folder. Ids are the router's labels, so they must be unique per folder.`,
			);
		}
		if (input.fallback) assertSingleFallback(node, path);

		const preserve = exists ? parseNote(readFileSync(absolute, "utf8")) : undefined;
		writeFileAtomic(absolute, buildNote({ id, title, criteria, fallback: input.fallback, content: input.content, preserve }));

		return finish(
			vaultRoot,
			`${exists ? "Replaced" : "Added"} ${path}`,
			[{ action: exists ? "updated" : "created", path, detail: title }],
			overfullWarning(node, exists ? 0 : 1),
			options,
		);
	});
}

export interface UpdateNoteInput {
	path: string;
	title?: string;
	criteria?: string;
	/** Replaces the body. */
	content?: string;
	/** Appended to the body, after a blank line. */
	append?: string;
	fallback?: boolean;
}

export function updateNote(vaultRoot: string, input: UpdateNoteInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		assertMarkdown(input.path);
		const absolute = resolveInVault(vaultRoot, input.path, "note");
		if (!existsSync(absolute)) throw new OperationError(`no such note: ${input.path}`);

		if (input.content !== undefined && input.append !== undefined) {
			throw new OperationError("pass content (replace) or append (add to the end), not both");
		}

		const note = parseNote(readFileSync(absolute, "utf8"));
		const path = relativeToVault(vaultRoot, absolute);
		const touched: string[] = [];

		if (input.title !== undefined) {
			note.frontmatter.title = assertTitle(input.title, "a note");
			touched.push("title");
		}
		if (input.criteria !== undefined) {
			note.frontmatter.criteria = assertCriteria(input.criteria, "a note");
			touched.push("criteria");
		}
		if (input.fallback !== undefined) {
			if (input.fallback) assertSingleFallback(folderNode(vaultRoot, dirname(path)), path);
			note.frontmatter.fallback = input.fallback;
			touched.push("fallback");
		}
		if (input.content !== undefined) {
			note.body = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
			touched.push("content");
		}
		if (input.append !== undefined) {
			const addition = input.append.replace(/^\n+/, "").trimEnd();
			note.body = `${note.body.trimEnd()}\n\n${addition}\n`;
			touched.push("content (appended)");
		}

		if (touched.length === 0) throw new OperationError("nothing to update: pass title, criteria, content or append");

		writeFileAtomic(absolute, serialiseNote(note));

		return finish(
			vaultRoot,
			`Updated ${path} (${touched.join(", ")})`,
			[{ action: "updated", path, detail: touched.join(", ") }],
			[],
			options,
		);
	});
}

export interface MoveNoteInput {
	from: string;
	toFolder: string;
	newId?: string;
}

export function moveNote(vaultRoot: string, input: MoveNoteInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		assertMarkdown(input.from);
		const source = resolveInVault(vaultRoot, input.from, "note");
		if (!existsSync(source)) throw new OperationError(`no such note: ${input.from}`);

		const target = folderNode(vaultRoot, input.toFolder);
		const note = parseNote(readFileSync(source, "utf8"));
		const id = slugify(input.newId?.trim() || note.frontmatter.id || basename(source, ".md"));
		const destination = join(target.absolutePath, noteFileName(id));

		if (destination === source) throw new OperationError(`${input.from} is already there`);
		if (existsSync(destination)) {
			throw new OperationError(`${relativeToVault(vaultRoot, destination)} already exists`);
		}

		const sourcePath = relativeToVault(vaultRoot, source);
		const clash = target.children?.find((child) => child.id === id && child.path !== sourcePath);
		if (clash) throw new OperationError(`id '${id}' is already used by ${clash.path} in the destination folder`);
		if (note.frontmatter.fallback) assertSingleFallback(target, sourcePath);

		// Move first, then rewrite at the destination: if the move fails, the
		// original is untouched rather than carrying an id for a file that never moved.
		renameSync(source, destination);

		// Keep the id in frontmatter consistent with the new filename, so the next
		// compile does not produce a label that disagrees with the file.
		if (note.frontmatter.id !== undefined || input.newId) {
			note.frontmatter.id = id;
			writeFileAtomic(destination, serialiseNote(note));
		}

		const path = relativeToVault(vaultRoot, destination);
		return finish(
			vaultRoot,
			`Moved ${input.from} to ${path}`,
			[{ action: "moved", path, from: sourcePath }],
			dirname(source) === target.absolutePath ? [] : overfullWarning(target, 1),
			options,
		);
	});
}

/** Move a note to the vault's `.trash/`. Restoring it is moving it back. */
export function removeNote(vaultRoot: string, path: string, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		assertMarkdown(path);
		const absolute = resolveInVault(vaultRoot, path, "note");
		if (!existsSync(absolute)) throw new OperationError(`no such note: ${path}`);

		const relative = relativeToVault(vaultRoot, absolute);
		const warnings: string[] = [];
		try {
			if (parseNote(readFileSync(absolute, "utf8")).frontmatter.fallback) {
				warnings.push(
					`${relative} was a catch-all note; ${dirname(relative) === "." ? "the vault" : `'${dirname(relative)}'`} ` +
						`now has none, so unsure routes there inject nothing. Mark another note \`fallback: true\`.`,
				);
			}
		} catch {
			/* unreadable: trash it anyway */
		}

		const destination = trashDestination(vaultRoot, basename(absolute));
		renameSync(absolute, destination);
		const trashed = relativeToVault(vaultRoot, destination);
		return finish(
			vaultRoot,
			`Moved ${relative} to ${trashed}`,
			[{ action: "trashed", path: trashed, from: relative }],
			warnings,
			options,
		);
	});
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface AddBranchInput {
	parent: string;
	title: string;
	criteria: string;
	id?: string;
	/** Body of the folder's `_about.md`. */
	about?: string;
	/** Folder name on disk. Defaults to the title. */
	folderName?: string;
}

/** Create the folder and its `_about.md` without recompiling; returns its vault-relative path. */
function createBranchFiles(vaultRoot: string, input: AddBranchInput): { path: string; absolute: string; title: string } {
	const parent = folderNode(vaultRoot, input.parent);
	const criteria = assertCriteria(input.criteria, "a folder");
	const title = assertTitle(input.title, "a folder");

	const folderName = safeFolderName(input.folderName ?? title);
	const id = slugify(input.id?.trim() || folderName);
	const absolute = join(parent.absolutePath, folderName);
	const path = relativeToVault(vaultRoot, absolute);

	if (existsSync(absolute)) throw new OperationError(`${path} already exists`);
	const clash = parent.children?.find((child) => child.id === id);
	if (clash) throw new OperationError(`id '${id}' is already used by ${clash.path} in this folder`);

	mkdirSync(absolute, { recursive: true });
	writeFileAtomic(
		join(absolute, ABOUT_FILE),
		buildNote({
			id,
			title,
			criteria,
			content: input.about ?? `# ${title}\n\nWhat belongs in this folder.\n`,
		}),
	);
	return { path, absolute, title };
}

export function addBranch(vaultRoot: string, input: AddBranchInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const parent = folderNode(vaultRoot, input.parent);
		const { path, title } = createBranchFiles(vaultRoot, input);

		// A folder with only an _about.md has nothing to route to, so the compiler
		// leaves it out of its parent's manifest until it holds a note.
		return finish(
			vaultRoot,
			`Created folder ${path}`,
			[{ action: "created", path: `${path}/${ABOUT_FILE}`, detail: title }],
			[
				`'${path}' has no notes yet, so the router will not offer it until you add one.`,
				...overfullWarning(parent, 1),
			],
			options,
		);
	});
}

export interface UpdateBranchInput {
	folder: string;
	title?: string;
	criteria?: string;
	about?: string;
}

export function updateBranch(vaultRoot: string, input: UpdateBranchInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const node = folderNode(vaultRoot, input.folder);
		if (node.path === ".") throw new OperationError("the vault root has no _about.md to update");

		const aboutPath = join(node.absolutePath, ABOUT_FILE);
		const note: ParsedNote = existsSync(aboutPath)
			? parseNote(readFileSync(aboutPath, "utf8"))
			: { frontmatter: {}, extraLines: [], hadFrontmatter: true, body: "" };

		const touched: string[] = [];
		if (input.title !== undefined) {
			note.frontmatter.title = assertTitle(input.title, "a folder");
			touched.push("title");
		}
		if (input.criteria !== undefined) {
			note.frontmatter.criteria = assertCriteria(input.criteria, "a folder");
			touched.push("criteria");
		}
		if (input.about !== undefined) {
			note.body = input.about.endsWith("\n") ? input.about : `${input.about}\n`;
			touched.push("about");
		}
		if (touched.length === 0) throw new OperationError("nothing to update: pass title, criteria or about");

		note.frontmatter.id ??= node.id;
		note.frontmatter.title ??= node.title;
		writeFileAtomic(aboutPath, serialiseNote(note));

		const path = `${node.path}/${ABOUT_FILE}`;
		return finish(vaultRoot, `Updated ${path} (${touched.join(", ")})`, [{ action: "updated", path }], [], options);
	});
}

export interface MoveBranchInput {
	folder: string;
	/** New parent folder, vault-relative. Defaults to the current parent (a rename). */
	toParent?: string;
	/** New folder name on disk. Defaults to the current name. */
	newName?: string;
	/** New routing label, written to `_about.md`. */
	newId?: string;
}

/** Move and/or rename a folder, keeping its `_about.md` id in step when asked. */
export function moveBranch(vaultRoot: string, input: MoveBranchInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const node = folderNode(vaultRoot, input.folder);
		if (node.path === ".") throw new OperationError("the vault root cannot be moved");

		const currentParent = dirname(node.path) === "." ? "." : dirname(node.path);
		const parent = folderNode(vaultRoot, input.toParent ?? currentParent);
		const name = input.newName !== undefined ? safeFolderName(input.newName) : basename(node.absolutePath);
		const destination = join(parent.absolutePath, name);

		if (destination === node.absolutePath && input.newId === undefined) {
			throw new OperationError(`${node.path} is already there; pass toParent, newName or newId`);
		}
		if (isInsideVault(node.absolutePath, parent.absolutePath)) {
			throw new OperationError("a folder cannot be moved into itself");
		}
		if (destination !== node.absolutePath && existsSync(destination)) {
			throw new OperationError(`${relativeToVault(vaultRoot, destination)} already exists`);
		}

		const id = input.newId !== undefined ? slugify(input.newId) : node.id;
		const clash = parent.children?.find((child) => child.id === id && child.absolutePath !== node.absolutePath);
		if (clash) throw new OperationError(`id '${id}' is already used by ${clash.path} in '${parent.path}'`);

		if (destination !== node.absolutePath) renameSync(node.absolutePath, destination);
		if (input.newId !== undefined) {
			const aboutPath = join(destination, ABOUT_FILE);
			const about: ParsedNote = existsSync(aboutPath)
				? parseNote(readFileSync(aboutPath, "utf8"))
				: { frontmatter: { title: node.title }, extraLines: [], hadFrontmatter: true, body: "" };
			about.frontmatter.id = id;
			writeFileAtomic(aboutPath, serialiseNote(about));
		}

		const path = relativeToVault(vaultRoot, destination);
		return finish(
			vaultRoot,
			`Moved folder ${node.path} to ${path}`,
			[{ action: "moved", path, from: node.path }],
			parent.path === currentParent ? [] : overfullWarning(parent, 1),
			options,
		);
	});
}

/** Move a folder and everything in it to `.trash/`. */
export function removeBranch(vaultRoot: string, folder: string, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const node = folderNode(vaultRoot, folder);
		if (node.path === ".") throw new OperationError("the vault root cannot be removed");

		const notes = flatten(node).filter((each) => each.kind === "leaf").length;
		const destination = trashDestination(vaultRoot, basename(node.absolutePath));
		renameSync(node.absolutePath, destination);
		const trashed = relativeToVault(vaultRoot, destination);

		return finish(
			vaultRoot,
			`Moved folder ${node.path} (${notes} note(s)) to ${trashed}`,
			[{ action: "trashed", path: trashed, from: node.path, detail: `${notes} note(s)` }],
			[],
			options,
		);
	});
}

export interface SplitBranchInput {
	folder: string;
	newFolderTitle: string;
	newFolderCriteria: string;
	/** Ids of the folder's current children to move into the new subfolder. */
	moveIds: string[];
	newFolderId?: string;
	newFolderName?: string;
	about?: string;
}

/**
 * The remedy for an over-full folder: create a subfolder and move a themed
 * subset of children into it, restoring the branching invariant in one step.
 *
 * Everything is validated before anything moves, the manifests are compiled
 * once at the end, and a failure part-way through moves the children back and
 * removes the new folder, so the vault is never left half-split.
 */
export function splitBranch(vaultRoot: string, input: SplitBranchInput, options: OperationOptions = {}): ChangeSet {
	return withVaultLock(vaultRoot, () => {
		const parent = folderNode(vaultRoot, input.folder);
		const children = parent.children ?? [];
		const moveIds = [...new Set(input.moveIds.map((id) => id.trim()).filter(Boolean))];

		if (moveIds.length < 2) {
			throw new OperationError("a split needs at least 2 distinct children to move; otherwise just move the note");
		}

		const byId = new Map(children.map((child) => [child.id, child]));
		const missing = moveIds.filter((id) => !byId.has(id));
		if (missing.length) {
			throw new OperationError(
				`these ids are not children of '${parent.path}': ${missing.join(", ")}. ` +
					`Available: ${children.map((child) => child.id).join(", ")}`,
			);
		}
		if (moveIds.length >= children.length) {
			throw new OperationError(
				"moving every child just renames the folder; leave at least one behind or use brain_move_branch",
			);
		}
		const folderName = safeFolderName(input.newFolderName ?? input.newFolderTitle ?? "");
		if (moveIds.some((id) => basename(byId.get(id)!.absolutePath) === folderName)) {
			throw new OperationError(`the new folder name '${folderName}' collides with a child being moved`);
		}

		const created = createBranchFiles(vaultRoot, {
			parent: parent.path,
			title: input.newFolderTitle,
			criteria: input.newFolderCriteria,
			id: input.newFolderId,
			folderName,
			about: input.about,
		});

		const moved: { from: string; to: string; path: string }[] = [];
		try {
			for (const id of moveIds) {
				const child = byId.get(id)!;
				const to = join(created.absolute, basename(child.absolutePath));
				renameSync(child.absolutePath, to);
				moved.push({ from: child.absolutePath, to, path: child.path });
			}
		} catch (error) {
			for (const { from, to } of moved.reverse()) {
				try {
					renameSync(to, from);
				} catch {
					/* leave it where it is; the error below names the problem */
				}
			}
			rmSync(created.absolute, { recursive: true, force: true });
			throw new OperationError(`split rolled back: ${(error as Error).message}`);
		}

		const changes: FileChange[] = [
			{ action: "created", path: `${created.path}/${ABOUT_FILE}`, detail: created.title },
			...moved.map(({ to, path }) => ({ action: "moved" as const, path: relativeToVault(vaultRoot, to), from: path })),
		];

		const remaining = children.length - moveIds.length + 1;
		return finish(
			vaultRoot,
			`Split '${parent.path}': moved ${moveIds.length} children into ${created.path}, leaving ${remaining} there`,
			changes,
			remaining > MAX_CHILDREN
				? [`'${parent.path}' still has ${remaining} children, over the ${MAX_CHILDREN} limit. Split again.`]
				: [],
			options,
		);
	});
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function rebuild(vaultRoot: string, subtree?: string, dryRun = false, options: OperationOptions = {}): ChangeSet {
	const run = () => compileVault(vaultRoot, { subtree, dryRun, maxHops: options.maxHops });
	const compiled = dryRun ? run() : withVaultLock(vaultRoot, run);
	const changed = compiled.files.filter((file) => file.status !== "unchanged");

	return {
		summary: dryRun
			? `${changed.length} manifest(s) would change`
			: changed.length === 0
				? "All manifests already up to date"
				: `Rebuilt ${changed.length} manifest(s)`,
		changes: [],
		manifests: changed,
		warnings: [],
		issues: compiled.issues,
	};
}

export function doctor(
	vaultRoot: string,
	options: OperationOptions = {},
): {
	issues: VaultIssue[];
	counts: { branches: number; leaves: number };
	stale: CompiledFile[];
} {
	// One scan serves both halves: the issues, and a dry-run compile that says
	// whether the manifests on disk still match the notes — the single most likely
	// way a hand-edited vault breaks routing.
	const compiled = compileVault(vaultRoot, { dryRun: true, maxHops: options.maxHops });
	return {
		issues: compiled.issues,
		counts: compiled.counts,
		stale: compiled.files.filter((file) => file.status === "written"),
	};
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
	path: string;
	kind: "leaf" | "branch";
	id: string;
	title: string;
	criteria: string;
	score: number;
	/** The first body line that mentions a search term. */
	snippet?: string;
}

/**
 * Keyword search over titles, criteria and bodies — the check for "is this
 * already in the brain?" that does not need the decisions service.
 */
export function searchNotes(vaultRoot: string, query: string, limit = 10): SearchHit[] {
	const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2))];
	if (terms.length === 0) throw new OperationError("search needs at least one word of two or more characters");

	const tree = scanVault(vaultRoot);
	const hits: SearchHit[] = [];
	const count = (text: string, term: string) => text.split(term).length - 1;

	for (const node of flatten(tree.root)) {
		if (node.path === ".") continue;
		const head = `${node.id} ${node.title}`.toLowerCase();
		const criteria = node.criteria.toLowerCase();
		let body = "";
		if (node.kind === "leaf") {
			try {
				body = parseNote(readFileSync(node.absolutePath, "utf8")).body;
			} catch {
				body = "";
			}
		}
		const lowerBody = body.toLowerCase();

		let score = 0;
		let matched = 0;
		for (const term of terms) {
			const inHead = count(head, term);
			const inCriteria = count(criteria, term);
			const inBody = Math.min(count(lowerBody, term), 5);
			if (inHead + inCriteria + inBody > 0) matched++;
			score += inHead * 3 + inCriteria * 2 + inBody;
		}
		if (score === 0) continue;
		// Notes that match every term outrank notes that match one term many times.
		score *= matched / terms.length;

		const snippet = body
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#") && terms.some((term) => line.toLowerCase().includes(term)));

		hits.push({
			path: node.path,
			kind: node.kind,
			id: node.id,
			title: node.title,
			criteria: node.criteria,
			score: Number(score.toFixed(2)),
			snippet: snippet && snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet,
		});
	}

	return hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).slice(0, limit);
}
