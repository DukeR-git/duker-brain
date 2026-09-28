/**
 * Shared test plumbing: throwaway directories that are removed when the test
 * process exits, so a run does not leave dozens of vaults behind in the temp dir.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const created: string[] = [];
process.once("exit", () => {
	for (const dir of created) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** A fresh empty directory, deleted when the process exits. */
export function tempDir(prefix = "brain-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/** A temp directory holding `files` (path -> content). */
export function scratch(files: Record<string, string> = {}, prefix = "brain-vault-"): string {
	const root = tempDir(prefix);
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return root;
}

/** The shared fixture vault. Read-only: copy it with {@link fixtureCopy} before writing. */
export const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-traverser", "fixtures", "vault");

/** A throwaway copy of the fixture vault. */
export function fixtureCopy(prefix = "brain-vault-"): string {
	const root = tempDir(prefix);
	cpSync(FIXTURE, root, { recursive: true });
	return root;
}

/** A note with the given frontmatter fields. */
export function note(fields: Record<string, string>, body = "content here\n"): string {
	const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** An isolated environment: no real user config, and no routing log in the real state dir. */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
	return { XDG_CONFIG_HOME: tempDir("brain-xdg-"), XDG_STATE_HOME: tempDir("brain-state-"), ...extra };
}
