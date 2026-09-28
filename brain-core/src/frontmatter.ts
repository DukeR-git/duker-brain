/**
 * Reading and writing the small slice of YAML frontmatter this system owns.
 *
 * Deliberately not a YAML library. The schema is four scalar fields, and an
 * Obsidian vault will contain frontmatter written by humans and other plugins —
 * tags, aliases, dates, nested blocks. Parsing only the keys we own and
 * preserving every other line verbatim is both simpler and safer than
 * round-tripping arbitrary YAML through a parser that will reformat it.
 *
 * The owned keys are one-line concepts, so however a human wrote them — folded
 * (`>`), literal (`|`), a plain scalar wrapped over several lines, or a list of
 * keywords — they are read as a single line and written back as one.
 */

import { createHash } from "node:crypto";

import type { NodeFrontmatter, ParsedNote } from "./types.js";

// Consumes the blank line(s) separating the block from the body, so `body` is
// the content itself. serialiseNote writes exactly one back, which keeps the
// parse -> serialise -> parse round trip stable. The inner group is optional so
// an empty `---\n---` block still counts as frontmatter.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)(?:\r?\n)*/;

/** Keys brain-core owns; everything else on a note is passed through untouched. */
const OWNED = new Set(["id", "title", "criteria", "fallback"]);

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/;
const BLOCK_INDICATOR = /^[|>][+-]?[1-9]?[+-]?$/;
const CONTINUATION = /^[ \t]/;

const DOUBLE_ESCAPES: Record<string, string> = {
	"\\": "\\",
	'"': '"',
	"/": "/",
	n: "\n",
	t: "\t",
	r: "\r",
	"0": "\0",
};

/** Strip a trailing ` # comment`, which YAML does not treat as part of a plain scalar. */
function stripComment(value: string): string {
	const match = /(^|[ \t])#/.exec(value);
	return match ? value.slice(0, match.index).trimEnd() : value;
}

function unquote(value: string): string {
	let trimmed = value.trim();
	// A quoted scalar may still carry a trailing comment: `"a: b"  # why`.
	const commented = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]+#.*$/s.exec(trimmed);
	if (commented) trimmed = commented[1];
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/\\(.)/gs, (whole, char: string) => DOUBLE_ESCAPES[char] ?? whole);
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return stripComment(trimmed);
}

/** Plain scalars YAML would read as something other than a string. */
const NON_STRING_SCALAR =
	/^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?(?:\.inf|\.nan)|[-+]?(?:0x[0-9a-f]+|0o[0-7]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:e[-+]?\d+)?))$/i;

/**
 * Quote only when the value would otherwise be misread: a leading indicator
 * character, a `: ` or ` #` that YAML treats as structure, surrounding
 * whitespace, or a scalar YAML would type as a number, boolean or null.
 */
function quote(value: string): string {
	const text = String(value).replace(/\r?\n/g, " ");
	if (text === "") return '""';
	const needsQuotes =
		/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
		/:(\s|$)/.test(text) ||
		/\s#/.test(text) ||
		/\s$/.test(text) ||
		/\t/.test(text) ||
		NON_STRING_SCALAR.test(text);
	if (!needsQuotes) return text;
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

/** Collapse an owned key's value plus its continuation lines into one line. */
function foldValue(first: string, continuation: string[], problems: string[], key: string): string {
	const lines = continuation.map((line) => line.trim()).filter((line) => line !== "");

	if (BLOCK_INDICATOR.test(first)) {
		// Folded or literal block: either way the owned keys are one-line concepts.
		return lines.join(" ");
	}

	if (first === "" && lines.length && lines.every((line) => line.startsWith("- "))) {
		// A list of keywords, e.g. `criteria:` followed by `- postgres` lines.
		return lines.map((line) => unquote(line.slice(2))).join(", ");
	}

	if (first === "" && lines.some((line) => KEY_LINE.test(line))) {
		problems.push(`\`${key}\` holds a nested mapping; it was read as plain text`);
	}

	// A plain or quoted scalar wrapped over several lines: YAML folds it with spaces.
	return unquote([first, ...lines].filter(Boolean).join(" "));
}

export function parseNote(input: string): ParsedNote {
	const markdown = input.startsWith("﻿") ? input.slice(1) : input;
	const match = FRONTMATTER.exec(markdown);
	if (!match) {
		const problems = /^---[ \t]*\r?\n/.test(markdown)
			? ["the file starts with `---` but the frontmatter block is never closed"]
			: [];
		return { frontmatter: {}, extraLines: [], hadFrontmatter: false, body: markdown, problems };
	}

	const frontmatter: NodeFrontmatter = {};
	const extraLines: string[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	const lines = (match[1] ?? "").split(/\r?\n/);

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const field = KEY_LINE.exec(line);
		// A continuation line (list item, nested mapping) belongs to whichever key
		// preceded it, so it travels with the passthrough block.
		if (!field || !OWNED.has(field[1])) {
			extraLines.push(line);
			continue;
		}

		// Everything indented beneath an owned key is part of its value; leaving it
		// behind would orphan it under whichever key happened to follow.
		const continuation: string[] = [];
		while (index + 1 < lines.length && (CONTINUATION.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
			// A blank line only continues the value if more indented lines follow it.
			if (lines[index + 1].trim() === "") {
				const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== "");
				if (next === undefined || !CONTINUATION.test(next)) break;
			}
			continuation.push(lines[++index]);
		}

		const key = field[1];
		if (seen.has(key)) problems.push(`\`${key}\` is set more than once; the last value wins`);
		seen.add(key);

		const value = foldValue((field[2] ?? "").trim(), continuation, problems, key);
		if (key === "fallback") {
			const normalised = value.toLowerCase();
			if (!["true", "false", "yes", "no", "on", "off", "1", "0", ""].includes(normalised)) {
				problems.push(`\`fallback: ${value}\` is not a boolean; it was read as false`);
			}
			frontmatter.fallback = ["true", "yes", "on", "1"].includes(normalised);
		} else {
			(frontmatter as Record<string, string>)[key] = value;
		}
	}

	return {
		frontmatter,
		extraLines,
		hadFrontmatter: true,
		body: markdown.slice(match[0].length),
		problems,
	};
}

/** Rebuild a note, rewriting the owned keys and keeping everything else. */
export function serialiseNote(note: ParsedNote): string {
	const lines: string[] = [];
	const { id, title, criteria, fallback } = note.frontmatter;

	if (id !== undefined) lines.push(`id: ${quote(id)}`);
	if (title !== undefined) lines.push(`title: ${quote(title)}`);
	if (criteria !== undefined) lines.push(`criteria: ${quote(criteria)}`);
	if (fallback) lines.push("fallback: true");

	// Drop blank passthrough lines only at the edges, so a user's grouping survives.
	const extras = [...note.extraLines];
	while (extras.length && extras[0].trim() === "") extras.shift();
	while (extras.length && extras[extras.length - 1].trim() === "") extras.pop();
	lines.push(...extras);

	const body = note.body.replace(/^\r?\n+/, "");
	if (lines.length === 0) return body;

	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** Convenience for the traverser, which only needs the title and the body. */
export function splitFrontmatter(markdown: string): { title?: string; body: string } {
	const note = parseNote(markdown);
	return { title: note.frontmatter.title, body: note.body };
}

/** Combining diacritical marks, left behind by NFKD normalisation. */
const DIACRITICS = /[\u0300-\u036f]/g;

/**
 * Derive a routing id from a filename or title.
 *
 * Ids appear verbatim as decision labels, so they need to read as words to the
 * model: `asyncpg_pooling` discriminates, `note-2024-03-11-b` does not.
 *
 * A name with no Latin letters or digits (`日本語`, `数据库`) has no readable
 * slug. Rather than an empty id — which no manifest accepts — it gets a stable
 * hash-based one; see {@link isHashedId}. Only blank input yields `""`.
 */
export function slugify(input: string): string {
	const slug = input
		.normalize("NFKD")
		.replace(DIACRITICS, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60)
		.replace(/_+$/, "");
	if (slug !== "" || input.trim() === "") return slug;
	return `id_${createHash("sha1").update(input.trim()).digest("hex").slice(0, 8)}`;
}

/** True for the fallback ids {@link slugify} makes from names with no usable characters. */
export function isHashedId(id: string): boolean {
	return /^id_[0-9a-f]{8}$/.test(id);
}
