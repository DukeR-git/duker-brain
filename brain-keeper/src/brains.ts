/**
 * Shared brains: a brain someone published, added to yours as one folder.
 *
 * A shared brain is a folder of notes in a git repository: the root of the repo
 * or any folder in it. It describes itself in `_about.md` (like any branch) and,
 * optionally, `brain.json` (name, title, version, author). Starter brains are
 * the curated ones in this repository's brains/ folder, addressed by name.
 *
 *   python-backend                          a starter brain, from brains/
 *   someone/their-brain                     a GitHub repository
 *   someone/monorepo/brains/go#v2           a folder in it, at a tag or branch
 *   https://github.com/someone/their-brain  the same, as a URL
 *   ./my-brain                              a folder on disk, for trying one out before publishing
 *
 * Adding one copies its notes into their own top-level folder and records, in
 * the vault's `.brain-sources.json`, where they came from and a hash of each
 * file. That record is what makes `update` safe: a note you edited since is
 * kept, and only notes still exactly as they arrived are replaced.
 *
 * Only Markdown notes and the brain's `evals.json` are copied. A brain cannot
 * bring scripts or settings; but its notes do reach the coding agent as
 * context, so the output says where they came from.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod";

import { resolveUserPath } from "../../brain-core/src/env.js";
import { withVaultLock, writeFileAtomic } from "../../brain-core/src/fsutil.js";
import { MANIFEST_FILE, MAX_CHILDREN } from "../../brain-core/src/manifest.js";
import { normaliseVaultPath, resolveInVault } from "../../brain-core/src/paths.js";
import { compileVault, findNode, scanVault, type CompileResult } from "../../brain-core/src/vault.js";

export const SOURCES_FILE = ".brain-sources.json";
export const BRAIN_META_FILE = "brain.json";
const EVALS_FILE = "evals.json";

const here = dirname(fileURLToPath(import.meta.url));

/** This repository's brains/ folder, found from source (brain-keeper/src/) and from a bundle (dist/). */
export const STARTERS_DIR = findUp(here, "brains");

function findUp(from: string, name: string): string | undefined {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, name);
		if (existsSync(join(candidate, "README.md")) && existsSync(join(dir, "package.json"))) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type BrainSource =
	| { kind: "starter"; spec: string; name: string }
	| { kind: "git"; spec: string; url: string; ref?: string; subdir: string; name: string }
	| { kind: "local"; spec: string; path: string; name: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse what the user typed into a source; throws with the accepted forms on
 * anything else. A local folder is recorded by its absolute path, so an update
 * finds it again from any working directory.
 */
export function parseSource(spec: string, cwd = process.cwd()): BrainSource {
	const input = spec.trim();
	if (NAME.test(input)) return { kind: "starter", spec: input, name: input };

	if (/^(\.{1,2}[\\/]|[\\/]|~[\\/]?|[A-Za-z]:[\\/])/.test(input) || input === "." || input === "..") {
		const path = resolveUserPath(input, cwd);
		return { kind: "local", spec: path, path, name: slug(basename(path)) };
	}

	// https://github.com/owner/repo[.git][/tree/<ref>/<subdir>]
	const web = /^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(input);
	if (web) return github(input, web[1], web[2], web[3], web[4]);

	// owner/repo[/subdir][#ref], optionally prefixed with github:
	const short = /^(?:github:)?([^/#\s]+)\/([^/#\s]+)((?:\/[^#\s]+)?)(?:#(\S+))?$/.exec(input);
	if (short && !input.includes("://")) return github(input, short[1], short[2], short[4], short[3].replace(/^\//, ""));

	// Any other git URL (another host, or file:// for a local repository).
	const git = /^((?:https|file):\/\/\S+?)(?:#(\S+))?$/.exec(input);
	if (git) {
		const url = git[1];
		return { kind: "git", spec: input, url, ref: git[2], subdir: "", name: slug(basename(url).replace(/\.git$/, "")) };
	}

	throw new Error(
		`'${spec}' is not a brain source. Use a starter name (see \`brain-keeper starters\`), ` +
			"owner/repo[/folder][#ref] for GitHub, or a git URL.",
	);
}

function github(spec: string, owner: string, repo: string, ref: string | undefined, subdir = ""): BrainSource {
	for (const part of [owner, repo]) {
		if (!GITHUB_PART.test(part) || part.startsWith("-") || part.startsWith(".")) throw new Error(`'${spec}': '${part}' is not a GitHub name`);
	}
	if (ref !== undefined && (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith("-"))) throw new Error(`'${spec}': '${ref}' is not a branch or tag`);
	const folder = normaliseVaultPath(subdir);
	if (folder.split("/").includes("..")) throw new Error(`'${spec}': the folder may not contain '..'`);
	const cleanSubdir = folder === "." ? "" : folder;
	return {
		kind: "git",
		spec,
		url: `https://github.com/${owner}/${repo}.git`,
		ref,
		subdir: cleanSubdir,
		name: slug(cleanSubdir ? basename(cleanSubdir) : repo),
	};
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "brain"
	);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const BrainMetaSchema = z.object({
	name: z.string().regex(NAME, "lower-case letters, digits and dashes").optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	version: z.string().optional(),
	author: z.string().optional(),
	license: z.string().optional(),
	homepage: z.string().optional(),
});
export type BrainMeta = z.infer<typeof BrainMetaSchema>;

interface Fetched {
	/** The brain's root folder. */
	dir: string;
	/** The commit it was taken from (git sources). */
	commit?: string;
	meta: BrainMeta;
	cleanup(): void;
}

/** How sources are fetched; replaced in tests. */
export type Fetcher = (source: BrainSource) => Fetched;

export const fetchSource: Fetcher = (source) => {
	if (source.kind === "starter") {
		if (!STARTERS_DIR) throw new Error("the starter brains folder is missing from this installation");
		const dir = join(STARTERS_DIR, source.name);
		if (!existsSync(join(dir, "_about.md"))) {
			const names = listStarters().map((starter) => starter.name);
			throw new Error(`there is no starter brain '${source.name}'. Available: ${names.join(", ") || "none"}`);
		}
		return { dir, meta: readMeta(dir), cleanup: () => {} };
	}

	if (source.kind === "local") {
		if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new Error(`${source.path} is not a folder`);
		return { dir: source.path, meta: readMeta(source.path), cleanup: () => {} };
	}

	const temp = mkdtempSync(join(tmpdir(), "brain-source-"));
	const cleanup = () => rmSync(temp, { recursive: true, force: true });
	try {
		const args = ["clone", "--depth", "1", "--quiet", ...(source.ref ? ["--branch", source.ref] : []), "--", source.url, join(temp, "repo")];
		const clone = spawnSync("git", args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		if (clone.error) {
			throw new Error(
				(clone.error as NodeJS.ErrnoException).code === "ENOENT"
					? "git is needed to add a brain from a repository, and it is not on the PATH"
					: `git clone failed: ${clone.error.message}`,
			);
		}
		if (clone.status !== 0) throw new Error(`could not fetch ${source.url}${source.ref ? ` at ${source.ref}` : ""}: ${clone.stderr.trim() || `git exited with ${clone.status}`}`);
		const commit = spawnSync("git", ["-C", join(temp, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || undefined;
		const dir = join(temp, "repo", source.subdir);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${source.spec}: there is no folder '${source.subdir}' in the repository`);
		// The folder named in the source may itself be a link out of the clone.
		const inside = relative(realpathSync(join(temp, "repo")), realpathSync(dir));
		if (inside.startsWith("..") || inside.includes(":")) throw new Error(`${source.spec}: '${source.subdir}' points outside the repository`);
		return { dir, commit, meta: readMeta(dir), cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
};

function readMeta(dir: string): BrainMeta {
	const file = join(dir, BRAIN_META_FILE);
	if (!existsSync(file)) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${BRAIN_META_FILE} is not valid JSON: ${(error as Error).message}`);
	}
	const parsed = BrainMetaSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`${BRAIN_META_FILE}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
	}
	return parsed.data;
}

/** Repository furniture at a brain's root that is not a note. */
const ROOT_SKIP = /^(readme|changelog|contributing|license|licence|code_of_conduct|security)(\..*)?$/i;

/**
 * The files a brain contributes: its notes, relative to its root, plus evals.json.
 * Symbolic links are skipped: a repository could otherwise pass off a link to
 * ~/.ssh or a credentials file as a note, and add would copy its contents into
 * the vault, where routing hands notes to the model.
 */
function brainFiles(root: string, dir = root): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (name.startsWith(".") || name === "node_modules" || name === MANIFEST_FILE) continue;
		const absolute = join(dir, name);
		const rel = relative(root, absolute).split("\\").join("/");
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			files.push(...brainFiles(root, absolute));
			continue;
		}
		if (dir === root && (ROOT_SKIP.test(name) || name === BRAIN_META_FILE)) continue;
		if (name.toLowerCase().endsWith(".md") || (dir === root && name === EVALS_FILE)) files.push(rel);
	}
	return files;
}

// ---------------------------------------------------------------------------
// The sources record
// ---------------------------------------------------------------------------

export interface InstalledBrain {
	source: string;
	kind: BrainSource["kind"];
	url?: string;
	ref?: string;
	subdir?: string;
	commit?: string;
	version?: string;
	title?: string;
	installedAt: string;
	updatedAt?: string;
	/** Folder-relative path -> sha1 of the content as it arrived. */
	files: Record<string, string>;
}

interface SourcesRecord {
	version: 1;
	brains: Record<string, InstalledBrain>;
}

export function readSources(vaultRoot: string): SourcesRecord {
	const file = join(vaultRoot, SOURCES_FILE);
	if (!existsSync(file)) return { version: 1, brains: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as SourcesRecord;
		return { version: 1, brains: parsed.brains ?? {} };
	} catch (error) {
		throw new Error(`${SOURCES_FILE} is not valid JSON (${(error as Error).message}); fix or delete it`);
	}
}

function writeSources(vaultRoot: string, record: SourcesRecord): void {
	writeFileAtomic(join(vaultRoot, SOURCES_FILE), JSON.stringify(record, null, 2) + "\n");
}

const sha1 = (content: string) => createHash("sha1").update(content).digest("hex");

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

export interface AddOptions {
	vaultRoot: string;
	source: string;
	/** Vault-relative folder to put it in; defaults to the brain's name. */
	as?: string;
	dryRun?: boolean;
	fetch?: Fetcher;
	now?: () => Date;
}

export interface AddResult {
	folder: string;
	source: BrainSource;
	title: string;
	commit?: string;
	version?: string;
	added: string[];
	evals: number;
	compiled?: CompileResult;
	dryRun: boolean;
}

export function addBrain(options: AddOptions): AddResult {
	const source = parseSource(options.source);
	const fetched = (options.fetch ?? fetchSource)(source);
	try {
		const folder = normaliseVaultPath(options.as ?? fetched.meta.name ?? source.name);
		if (folder === ".") throw new Error("a brain goes into its own folder, not the vault root");
		const target = resolveInVault(options.vaultRoot, folder, "folder");

		const record = readSources(options.vaultRoot);
		if (record.brains[folder]) throw new Error(`'${folder}' already holds ${record.brains[folder].source}; run \`brain-keeper update ${folder}\` to update it`);
		if (existsSync(target) && readdirSync(target).length > 0) {
			throw new Error(`the folder '${folder}' already exists in the vault; choose another with --as <folder>`);
		}
		checkRoom(options.vaultRoot, folder);

		const files = brainFiles(fetched.dir);
		const notes = files.filter((file) => file !== EVALS_FILE);
		const about = aboutFor(fetched, notes);
		if (notes.length === 0) throw new Error(`${source.spec} has no notes`);

		const title = fetched.meta.title ?? source.name;
		const result: AddResult = {
			folder,
			source,
			title,
			commit: fetched.commit,
			version: fetched.meta.version,
			added: [...(about.generated ? ["_about.md"] : []), ...notes],
			evals: 0,
			dryRun: options.dryRun === true,
		};
		if (result.dryRun) return result;

		result.compiled = withVaultLock(options.vaultRoot, () => {
			const hashes: Record<string, string> = {};
			for (const file of notes) {
				const content = readFileSync(join(fetched.dir, file), "utf8");
				writeInto(target, file, content);
				hashes[file] = sha1(content);
			}
			if (about.generated) {
				writeInto(target, "_about.md", about.generated);
				hashes["_about.md"] = sha1(about.generated);
			}
			result.evals = mergeEvals(options.vaultRoot, folder, fetched.dir);

			record.brains[folder] = {
				source: source.spec,
				kind: source.kind,
				...(source.kind === "git" ? { url: source.url, ref: source.ref, subdir: source.subdir || undefined } : {}),
				commit: fetched.commit,
				version: fetched.meta.version,
				title,
				installedAt: (options.now?.() ?? new Date()).toISOString(),
				files: hashes,
			};
			writeSources(options.vaultRoot, record);
			return compileVault(options.vaultRoot);
		});
		return result;
	} finally {
		fetched.cleanup();
	}
}

/** The brain's own `_about.md`, or one generated from brain.json; a brain needs one to be routable. */
function aboutFor(fetched: Fetched, notes: string[]): { generated?: string } {
	if (notes.includes("_about.md")) return {};
	const { title, description } = fetched.meta;
	if (!description) {
		throw new Error("the brain has no _about.md at its root, and no description in brain.json to route by");
	}
	const id = slug(title ?? "brain").replace(/-/g, "_");
	return { generated: `---\nid: ${id}\ntitle: ${title ?? id}\ncriteria: ${description.replace(/\s+/g, " ").trim()}\n---\n` };
}

/** A new top-level folder is one more option at its parent's hop; refuse to push a folder past the limit. */
function checkRoom(vaultRoot: string, folder: string): void {
	const parentPath = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ".";
	const tree = scanVault(vaultRoot);
	const parent = parentPath === "." ? tree.root : findNode(tree.root, parentPath);
	if (!parent) return; // a new parent folder: it will only hold this brain
	const children = parent.children?.length ?? 0;
	if (children >= MAX_CHILDREN) {
		const where = parentPath === "." ? "The vault root" : `'${parentPath}'`;
		throw new Error(
			`${where} already has ${children} entries, the most one folder can route between. ` +
				"Put the brain inside an existing folder with --as <folder>/<name>.",
		);
	}
}

function writeInto(target: string, file: string, content: string): void {
	const path = join(target, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomic(path, content);
}

/**
 * The vault's evals.json is the one suite every eval command runs, so a brain's
 * cases go in there, with ids prefixed by its folder so an update can replace
 * exactly its own.
 */
function mergeEvals(vaultRoot: string, folder: string, brainDir: string): number {
	const incoming = join(brainDir, EVALS_FILE);
	const file = join(vaultRoot, EVALS_FILE);
	let suite: { version?: number; evals?: { id: string }[] } = { version: 1, evals: [] };
	if (existsSync(file)) {
		try {
			suite = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return 0; // leave a file we cannot read alone
		}
	}
	const prefix = `${folder}/`;
	const kept = (suite.evals ?? []).filter((entry) => !entry.id.startsWith(prefix));
	let added: { id: string }[] = [];
	if (existsSync(incoming)) {
		try {
			const theirs = JSON.parse(readFileSync(incoming, "utf8")) as { evals?: { id: string }[] };
			added = (theirs.evals ?? []).map((entry) => ({ ...entry, id: `${prefix}${entry.id}` }));
		} catch {
			added = [];
		}
	}
	if (added.length === 0 && kept.length === (suite.evals ?? []).length && !existsSync(file)) return 0;
	writeFileAtomic(file, JSON.stringify({ ...suite, version: suite.version ?? 1, evals: [...kept, ...added] }, null, 2) + "\n");
	return added.length;
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

export interface UpdateOptions {
	vaultRoot: string;
	/** One installed folder; all of them when omitted. */
	folder?: string;
	dryRun?: boolean;
	fetch?: Fetcher;
	now?: () => Date;
}

export interface BrainUpdate {
	folder: string;
	source: string;
	from?: string;
	to?: string;
	added: string[];
	updated: string[];
	/** Changed upstream, but you edited them: your version was kept. */
	kept: string[];
	/** Gone upstream; left in place. */
	removedUpstream: string[];
	evals: number;
	error?: string;
}

export interface UpdateResult {
	updates: BrainUpdate[];
	compiled?: CompileResult;
	dryRun: boolean;
}

export function updateBrains(options: UpdateOptions): UpdateResult {
	const record = readSources(options.vaultRoot);
	const folders = options.folder ? [normaliseVaultPath(options.folder)] : Object.keys(record.brains).sort();
	if (options.folder && !record.brains[folders[0]]) {
		throw new Error(`'${folders[0]}' is not a brain added with brain-keeper add. Added: ${Object.keys(record.brains).join(", ") || "none"}`);
	}
	const dryRun = options.dryRun === true;
	const updates: BrainUpdate[] = [];

	const run = () => {
		for (const folder of folders) {
			const installed = record.brains[folder];
			const update: BrainUpdate = { folder, source: installed.source, from: installed.commit ?? installed.version, added: [], updated: [], kept: [], removedUpstream: [], evals: 0 };
			updates.push(update);
			let fetched: Fetched | undefined;
			try {
				fetched = (options.fetch ?? fetchSource)(parseSource(installed.source));
				update.to = fetched.commit ?? fetched.meta.version;
				const target = resolveInVault(options.vaultRoot, folder, "folder");
				const upstream = new Set(brainFiles(fetched.dir).filter((file) => file !== EVALS_FILE));
				const hashes = { ...installed.files };

				for (const file of [...upstream].sort()) {
					const content = readFileSync(join(fetched.dir, file), "utf8");
					const incoming = sha1(content);
					const localPath = join(target, file);
					if (!existsSync(localPath)) {
						// New upstream, or a note you deleted: only a new one comes back.
						if (installed.files[file] !== undefined) continue;
						update.added.push(file);
					} else {
						const local = sha1(readFileSync(localPath, "utf8"));
						if (local === incoming) {
							hashes[file] = incoming;
							continue;
						}
						if (local !== installed.files[file]) {
							update.kept.push(file);
							continue;
						}
						update.updated.push(file);
					}
					if (!dryRun) writeInto(target, file, content);
					hashes[file] = incoming;
				}
				for (const file of Object.keys(installed.files)) {
					if (!upstream.has(file) && file !== "_about.md") update.removedUpstream.push(file);
				}
				if (!dryRun) {
					update.evals = mergeEvals(options.vaultRoot, folder, fetched.dir);
					record.brains[folder] = {
						...installed,
						commit: fetched.commit,
						version: fetched.meta.version ?? installed.version,
						updatedAt: (options.now?.() ?? new Date()).toISOString(),
						files: hashes,
					};
				}
			} catch (error) {
				update.error = (error as Error).message;
			} finally {
				fetched?.cleanup();
			}
		}
		if (dryRun) return undefined;
		writeSources(options.vaultRoot, record);
		return compileVault(options.vaultRoot);
	};

	const compiled = dryRun ? run() : withVaultLock(options.vaultRoot, run);
	return { updates, compiled, dryRun };
}

// ---------------------------------------------------------------------------
// Listing and rendering
// ---------------------------------------------------------------------------

export interface StarterInfo {
	name: string;
	title: string;
	description: string;
	version?: string;
	notes: number;
}

export function listStarters(): StarterInfo[] {
	if (!STARTERS_DIR) return [];
	const starters: StarterInfo[] = [];
	for (const name of readdirSync(STARTERS_DIR).sort()) {
		const dir = join(STARTERS_DIR, name);
		if (!statSync(dir).isDirectory() || !existsSync(join(dir, "_about.md"))) continue;
		const meta = readMeta(dir);
		starters.push({
			name,
			title: meta.title ?? name,
			description: meta.description ?? "",
			version: meta.version,
			notes: brainFiles(dir).filter((file) => file.endsWith(".md") && !file.endsWith("_about.md")).length,
		});
	}
	return starters;
}

function describeSource(source: BrainSource, commit?: string, version?: string): string {
	if (source.kind === "starter") return `the ${source.name} starter brain${version ? ` v${version}` : ""}`;
	if (source.kind === "local") return source.path;
	return `${source.url.replace(/\.git$/, "")}${source.subdir ? `/${source.subdir}` : ""}${commit ? ` @ ${commit.slice(0, 7)}` : ""}`;
}

export function renderAdd(result: AddResult): string {
	const notes = result.added.filter((file) => file.endsWith(".md") && basename(file) !== "_about.md");
	const lines = [
		result.dryRun
			? `Dry run: nothing was written. Would add ${notes.length} note(s) from ${describeSource(result.source, result.commit, result.version)} into ${result.folder}/:`
			: `Added ${result.title} into ${result.folder}/: ${notes.length} note(s) from ${describeSource(result.source, result.commit, result.version)}.`,
	];
	if (result.dryRun) lines.push(...result.added.map((file) => `  ${result.folder}/${file}`));
	if (result.evals) lines.push(`  evals     ${result.evals} routing eval case(s) added to evals.json`);
	if (result.compiled) {
		const errors = result.compiled.issues.filter((issue) => issue.severity === "error");
		lines.push(`  compiled  ${result.compiled.counts.branches} folder(s), ${result.compiled.counts.leaves} note(s) in the vault`);
		for (const issue of errors.slice(0, 5)) lines.push(`  error     ${issue.path}: ${issue.message}`);
	}
	if (result.source.kind === "git") {
		lines.push(
			"",
			"These notes are given to your coding agent as context whenever a prompt routes to them.",
			"Only add brains from sources you trust, and read what they say.",
		);
	}
	if (!result.dryRun) lines.push("", `Update it later with: brain-keeper update ${result.folder}`);
	return lines.join("\n");
}

export function renderUpdate(result: UpdateResult): string {
	if (result.updates.length === 0) return "No brains were added with brain-keeper add, so there is nothing to update.";
	const lines = [result.dryRun ? "Dry run: nothing was written." : "Updated shared brains:"];
	for (const update of result.updates) {
		if (update.error) {
			lines.push(`  ${update.folder}/  failed: ${update.error}`);
			continue;
		}
		const changes = update.added.length + update.updated.length;
		const moved = update.from && update.to && update.from !== update.to ? ` (${short(update.from)} -> ${short(update.to)})` : "";
		lines.push(`  ${update.folder}/  ${changes ? `${update.added.length} new, ${update.updated.length} updated` : "already up to date"}${moved}`);
		for (const file of update.kept) lines.push(`    kept your edit: ${file} (it also changed upstream)`);
		for (const file of update.removedUpstream) lines.push(`    no longer upstream, left in place: ${file}`);
	}
	return lines.join("\n");
}

const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

export function renderStarters(vaultRoot?: string): string {
	const starters = listStarters();
	const lines = ["Starter brains (add with: brain-keeper add <name>):"];
	if (starters.length === 0) lines.push("  none in this installation");
	for (const starter of starters) {
		lines.push(`  ${starter.name.padEnd(18)} ${starter.title}${starter.version ? ` v${starter.version}` : ""}, ${starter.notes} notes`);
		if (starter.description) lines.push(`  ${"".padEnd(18)} ${starter.description}`);
	}
	lines.push("", "Any git repository works too: brain-keeper add owner/repo[/folder][#ref]");
	if (vaultRoot) {
		const installed = Object.entries(readSources(vaultRoot).brains);
		if (installed.length) {
			lines.push("", "Added to this vault:");
			for (const [folder, brain] of installed) {
				lines.push(`  ${folder.padEnd(18)} ${brain.source}${brain.commit ? ` @ ${brain.commit.slice(0, 7)}` : brain.version ? ` v${brain.version}` : ""}`);
			}
		}
	}
	return lines.join("\n");
}
