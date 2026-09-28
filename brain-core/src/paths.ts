/**
 * Path helpers with one job beyond convenience: nothing this system reads or
 * writes may sit outside the vault root.
 *
 * Manifests are generated data and note paths arrive from an LLM, so a stray
 * `../..` has to be refused rather than trusted — on the read side it would
 * hand the agent an arbitrary file, and on the write side it would let a tool
 * call scribble outside the vault.
 *
 * Symlinks are deliberately not resolved: only the user can place one inside
 * the vault, and pointing a folder of the vault somewhere else is a legitimate
 * way to share notes. What is refused is a *path* that leaves the root.
 */

import * as nodePath from "node:path";

type PathApi = Pick<typeof nodePath, "relative" | "resolve" | "isAbsolute" | "sep">;

export class VaultPathError extends Error {}

/** Path relative to the vault root, always forward-slashed for display. */
export function relativeToVault(vaultRoot: string, path: string): string {
	const rel = nodePath.relative(nodePath.resolve(vaultRoot), nodePath.resolve(path));
	return rel === "" ? "." : rel.split(nodePath.sep).join("/");
}

/**
 * The containment check, parameterised on the path flavour so the Windows rules
 * can be tested on any platform.
 *
 * `relative()` returns an *absolute* path when the two sides are on different
 * Windows drives (`C:\vault` vs `D:\x` gives `D:\x`), which contains no `..` at
 * all — so "does it start with .." alone is not a containment test.
 */
export function isInsideVaultOn(path: PathApi, vaultRoot: string, target: string): boolean {
	const root = path.resolve(vaultRoot);
	const resolved = path.resolve(target);
	if (resolved === root) return true;
	const rel = path.relative(root, resolved);
	if (rel === "" || path.isAbsolute(rel)) return false;
	return rel.split(path.sep)[0] !== "..";
}

export function isInsideVault(vaultRoot: string, path: string): boolean {
	return isInsideVaultOn(nodePath, vaultRoot, path);
}

export function assertInsideVault(vaultRoot: string, path: string, what: string): string {
	if (!isInsideVault(vaultRoot, path)) {
		throw new VaultPathError(`${what} escapes the vault root: ${path}`);
	}
	return nodePath.resolve(path);
}

/**
 * Resolve a caller-supplied vault-relative path (`"Backend/fastapi_core.md"`,
 * `"."`, `""`) to an absolute one, refusing anything that leaves the vault.
 */
export function resolveInVault(vaultRoot: string, path: string | undefined, what = "path"): string {
	const root = nodePath.resolve(vaultRoot);
	const cleaned = (path ?? "").trim().replace(/^[/\\]+/, "");
	if (cleaned === "" || cleaned === ".") return root;
	return assertInsideVault(root, nodePath.resolve(root, cleaned), what);
}

/** `"Backend\\sub/"` -> `"Backend/sub"`; `"./"`, `""` -> `"."`. For looking nodes up by path. */
export function normaliseVaultPath(path: string | undefined): string {
	const cleaned = (path ?? "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^(\.\/)+/, "")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	return cleaned === "" || cleaned === "." ? "." : cleaned;
}
