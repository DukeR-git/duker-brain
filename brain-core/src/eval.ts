/**
 * Automated Routing Regression Testing (brain eval).
 *
 * Runs declarative test suites against a vault to verify prompt routing
 * accuracy, measure latency percentiles, and catch regressions.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod";

import type { BrainTraverser } from "./traverser.js";
import type { EvalCase, EvalOptions, EvalReport, EvalResult, EvalSuite } from "./types.js";

export const EvalCaseSchema = z.object({
	id: z.string().min(1),
	prompt: z.string().min(1),
	expected: z.string().min(1),
	minConfidence: z.number().min(0).max(1).optional(),
	acceptableAlternatives: z.array(z.string()).default([]),
	tags: z.array(z.string()).default([]),
});

export const EvalSuiteSchema = z.object({
	version: z.number().default(1),
	defaults: z
		.object({
			minConfidence: z.number().min(0).max(1).optional(),
			timeoutMs: z.number().positive().optional(),
		})
		.optional(),
	evals: z.array(EvalCaseSchema).min(1),
});

/**
 * Parses and validates an eval suite file (supports JSON and simple YAML).
 */
export function loadEvalSuite(filePath: string): EvalSuite {
	if (!existsSync(filePath)) {
		throw new Error(`Eval suite file not found: ${filePath}`);
	}

	const content = readFileSync(filePath, "utf8");
	let parsed: unknown;

	if (filePath.endsWith(".json")) {
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			throw new Error(`Invalid JSON in eval suite (${filePath}): ${(error as Error).message}`);
		}
	} else {
		// Basic parser for JSON or YAML-formatted suites
		try {
			parsed = JSON.parse(content);
		} catch {
			parsed = parseSimpleYaml(content);
		}
	}

	const result = EvalSuiteSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid eval suite schema in ${filePath}:\n${issues}`);
	}

	return result.data as EvalSuite;
}

/**
 * Runs an eval suite using the provided BrainTraverser instance.
 */
export async function runEvalSuite(
	suite: EvalSuite,
	traverser: BrainTraverser,
	options: EvalOptions = {},
): Promise<EvalReport> {
	let cases = suite.evals;
	if (options.tags && options.tags.length > 0) {
		const filterTags = new Set(options.tags);
		cases = cases.filter((c) => c.tags?.some((t) => filterTags.has(t)));
	}

	if (cases.length === 0) {
		return {
			total: 0,
			passed: 0,
			failed: 0,
			accuracy: 1.0,
			meanLatencyMs: 0,
			p50LatencyMs: 0,
			p95LatencyMs: 0,
			results: [],
		};
	}

	const results: EvalResult[] = [];
	const latencies: number[] = [];

	for (const testCase of cases) {
		const start = performance.now();
		let error: string | undefined;
		let res;
		try {
			res = await traverser.route(testCase.prompt);
		} catch (err) {
			error = (err as Error).message;
		}

		const latency = performance.now() - start;
		latencies.push(latency);

		if (error || !res) {
			results.push({
				id: testCase.id,
				prompt: testCase.prompt,
				expected: testCase.expected,
				actual: null,
				passed: false,
				confidence: 0,
				minConfidencePassed: false,
				nearTie: false,
				latencyMs: latency,
				error: error ?? "No result returned",
			});
			continue;
		}

		const docs = res.documents && res.documents.length > 0 ? res.documents : (res.document ? [res.document] : []);
		const actualId = docs.map((d) => d.id).join("+") || null;
		const actualPath = docs.length > 0 ? docs.map((d) => d.path).join("+") : null;

		const matchesExpected =
			matchesDestination(testCase.expected, actualId, null) ||
			docs.some((doc) => matchesDestination(testCase.expected, doc.id, doc.path));

		const matchesAlternative = testCase.acceptableAlternatives?.some((alt) =>
			matchesDestination(alt, actualId, null) ||
			docs.some((doc) => matchesDestination(alt, doc.id, doc.path)),
		);
		const destinationMatched = matchesExpected || Boolean(matchesAlternative);

		const requiredConf = testCase.minConfidence ?? suite.defaults?.minConfidence ?? 0;
		const minConfidencePassed = res.minConfidence >= requiredConf;

		// Check for near-tie in the last hop
		let nearTie = false;
		let runnerUp: { label: string; confidence: number } | undefined;
		const lastHop = res.hops[res.hops.length - 1];
		if (lastHop?.probabilities) {
			const sorted = Object.entries(lastHop.probabilities).sort((a, b) => b[1] - a[1]);
			if (sorted.length >= 2) {
				const [first, second] = sorted;
				if (first[1] - second[1] < 0.15) {
					nearTie = true;
					runnerUp = { label: second[0], confidence: second[1] };
				}
			}
		}

		const passed = destinationMatched && minConfidencePassed;

		results.push({
			id: testCase.id,
			prompt: testCase.prompt,
			expected: testCase.expected,
			actual: actualPath ?? actualId ?? `status:${res.status}`,
			passed,
			confidence: res.minConfidence,
			minConfidencePassed,
			nearTie,
			runnerUp,
			latencyMs: latency,
			error: res.status === "error" ? res.reason : undefined,
		});
	}

	latencies.sort((a, b) => a - b);
	const passedCount = results.filter((r) => r.passed).length;
	const total = results.length;
	const accuracy = total > 0 ? passedCount / total : 1.0;
	const sumLatencies = latencies.reduce((acc, l) => acc + l, 0);

	return {
		total,
		passed: passedCount,
		failed: total - passedCount,
		accuracy,
		meanLatencyMs: total > 0 ? sumLatencies / total : 0,
		p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
		p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
		results,
	};
}

/** Formats an EvalReport as a clean terminal string. */
export function renderEvalReport(report: EvalReport): string {
	const lines: string[] = [];

	for (const r of report.results) {
		const icon = r.passed ? "✔ [PASS]" : "✖ [FAIL]";
		const lat = `${r.latencyMs.toFixed(0)}ms`;
		const conf = `conf: ${r.confidence.toFixed(2)}`;
		if (r.passed) {
			lines.push(`  ${icon} ${r.id} -> ${r.actual} (${conf}, ${lat})`);
		} else {
			const reason = r.error ? ` [error: ${r.error}]` : "";
			lines.push(`  ${icon} ${r.id}: expected '${r.expected}', got '${r.actual}' (${conf}, ${lat})${reason}`);
		}
		if (r.nearTie && r.runnerUp) {
			lines.push(`         ⚠ near-tie: runner-up '${r.runnerUp.label}' was only ${(r.runnerUp.confidence * 100).toFixed(0)}%`);
		}
	}

	const pct = (report.accuracy * 100).toFixed(1);
	lines.push("");
	lines.push(`Summary: ${report.passed}/${report.total} passed (${pct}% accuracy)`);
	lines.push(`Latency: mean ${report.meanLatencyMs.toFixed(0)}ms | p50 ${report.p50LatencyMs.toFixed(0)}ms | p95 ${report.p95LatencyMs.toFixed(0)}ms`);

	return lines.join("\n");
}

function matchesDestination(expected: string, actualId: string | null, actualPath: string | null): boolean {
	if (!actualId && !actualPath) return false;
	const normExpected = expected.replace(/\\/g, "/").replace(/^\.\//, "");
	if (actualId && actualId === normExpected) return true;
	if (actualPath) {
		const normPath = actualPath.replace(/\\/g, "/");
		if (normPath === normExpected) return true;
		if (basename(normPath) === normExpected || basename(normPath, ".md") === normExpected) return true;
	}
	return false;
}

/** Minimal line-oriented parser for simple YAML eval files */
function parseSimpleYaml(text: string): unknown {
	// If it contains "evals:" parse simple lines
	const lines = text.split(/\r?\n/);
	const evals: Array<Record<string, unknown>> = [];
	let current: Record<string, unknown> | null = null;
	let inEvals = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (trimmed.startsWith("evals:")) {
			inEvals = true;
			continue;
		}

		if (inEvals) {
			if (trimmed.startsWith("- ")) {
				if (current) evals.push(current);
				current = {};
				const rest = trimmed.slice(2).trim();
				if (rest.includes(":")) {
					const [k, ...v] = rest.split(":");
					current[k.trim()] = parseYamlValue(v.join(":").trim());
				}
			} else if (current && trimmed.includes(":")) {
				const [k, ...v] = trimmed.split(":");
				current[k.trim()] = parseYamlValue(v.join(":").trim());
			}
		}
	}

	if (current) evals.push(current);
	return { version: 1, evals };
}

function parseYamlValue(val: string): unknown {
	if (val === "true") return true;
	if (val === "false") return false;
	if (!Number.isNaN(Number(val)) && val !== "") return Number(val);
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		return val.slice(1, -1);
	}
	if (val.startsWith("[") && val.endsWith("]")) {
		return val
			.slice(1, -1)
			.split(",")
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
	}
	return val;
}
