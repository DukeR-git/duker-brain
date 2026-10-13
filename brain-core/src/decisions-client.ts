/**
 * HTTP client for the decisions API.
 *
 * Speaks the hosted TypeSafe Jev API: `POST /v1/systemone` with a bearer token.
 *
 * The contract with the caller is that this never throws for a routing failure:
 * a timeout, a 5xx, or a malformed body all come back
 * as `{ ok: false }`. An agent turn must not die because a side-car is down.
 */

import { DEFAULT_MODEL } from "./env.js";
import type { Logger } from "./logger.js";
import type { Answer, DecisionsResponse, Question } from "./types.js";

export interface DecisionsClientOptions {
	baseUrl: string;
	path: string;
	apiKey?: string;
	/** Sent as the request's `model`. */
	model?: string;
	timeoutMs: number;
	retries: number;
	logger: Logger;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

export interface AskOptions {
	/** `performance.now()` value after which no request may start or keep running. */
	deadline?: number;
}

export type DecisionOutcome =
	| { ok: true; answers: Record<string, Answer>; latencyMs: number; serverMs?: number; warnings?: string[] }
	| { ok: false; error: string; latencyMs: number };

/** What `health()` found. */
export interface ServiceHealth {
	ok: boolean;
	/** The configured Jev model. */
	model?: string;
	/** Why `ok` is false, phrased so the user knows what to fix. */
	error?: string;
}

/** Longest back-off this client will sleep before a retry, whatever `Retry-After` asks for. */
const MAX_BACKOFF_MS = 1000;

type Attempt =
	| { ok: true; answers: Record<string, Answer>; serverMs?: number; warnings?: string[] }
	| { ok: false; error: string; retryable: boolean; retryAfterMs?: number };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class DecisionsClient {
	private readonly url: string;

	constructor(private readonly options: DecisionsClientOptions) {
		this.url = options.baseUrl.replace(/\/+$/, "") + options.path;
	}

	get endpoint(): string {
		return this.url;
	}

	get model(): string {
		return this.options.model ?? DEFAULT_MODEL;
	}

	/** Ask one or more typed questions; they are answered together in one request. */
	async ask(state: string, questions: Record<string, Question>, askOptions: AskOptions = {}): Promise<DecisionOutcome> {
		const started = performance.now();
		const deadline = askOptions.deadline ?? Infinity;
		const attempts = Math.max(0, this.options.retries) + 1;
		let lastError = "unknown error";

		for (let attempt = 1; attempt <= attempts; attempt++) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				lastError = attempt === 1 ? "routing budget exhausted before the request" : `${lastError}; routing budget exhausted`;
				break;
			}

			const outcome = await this.attempt(state, questions, Math.min(this.options.timeoutMs, remaining));
			if (outcome.ok) {
				return { ...outcome, latencyMs: performance.now() - started };
			}
			lastError = outcome.error;
			if (!outcome.retryable || attempt === attempts) break;

			// Back off a little (with jitter) so a 429 is not answered with an
			// instant second request, but never past the route's budget.
			const backoff = Math.min(outcome.retryAfterMs ?? 50 * attempt + Math.random() * 50, MAX_BACKOFF_MS);
			if (performance.now() + backoff >= deadline) {
				lastError = `${lastError}; no time left to retry`;
				break;
			}
			this.options.logger.debug(`retrying decision in ${Math.round(backoff)}ms (attempt ${attempt + 1}/${attempts}): ${lastError}`);
			await sleep(backoff);
		}

		return { ok: false, error: lastError, latencyMs: performance.now() - started };
	}

	private async attempt(state: string, questions: Record<string, Question>, timeoutMs: number): Promise<Attempt> {
		const doFetch = this.options.fetchImpl ?? fetch;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await doFetch(this.url, {
				method: "POST",
				headers: this.headers({ "content-type": "application/json" }),
				body: JSON.stringify({ model: this.model, state, questions }),
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					ok: false,
					error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
					// 429 and 5xx are worth one retry.
					retryable: response.status >= 500 || response.status === 429,
					retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
				};
			}

			let payload: DecisionsResponse;
			try {
				payload = (await response.json()) as DecisionsResponse;
			} catch (error) {
				// A body that is not JSON will not become JSON on a second try.
				return { ok: false, error: `response is not JSON: ${(error as Error).message}`, retryable: false };
			}
			if (!payload || typeof payload !== "object" || !payload.answers || typeof payload.answers !== "object") {
				return { ok: false, error: "response has no answers map", retryable: false };
			}

			return {
				ok: true,
				answers: payload.answers,
				serverMs: payload.routing?.latency_ms,
				warnings: Array.isArray(payload.warnings) && payload.warnings.length ? payload.warnings.map(String) : undefined,
			};
		} catch (error) {
			const err = error as Error;
			const timedOut = err.name === "AbortError";
			return {
				ok: false,
				error: timedOut ? `timed out after ${Math.round(timeoutMs)}ms` : `${err.name}: ${err.message}`,
				retryable: !timedOut,
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/** Single-choice convenience wrapper. */
	async pickChoice(
		state: string,
		instructions: string,
		criteria: Record<string, string>,
	): Promise<
		| { ok: true; choice: string; confidence: number; probabilities?: Record<string, number>; latencyMs: number }
		| { ok: false; error: string; latencyMs: number }
	> {
		const outcome = await this.ask(state, {
			route_selection: { type: "choice", instructions, criteria },
		});
		if (!outcome.ok) return outcome;

		const answer = outcome.answers.route_selection;
		if (!answer || answer.type !== "choice") {
			return { ok: false, error: "no choice answer returned", latencyMs: outcome.latencyMs };
		}
		return {
			ok: true,
			choice: answer.choice,
			confidence: choiceConfidence(answer),
			probabilities: answer.probabilities,
			latencyMs: outcome.latencyMs,
		};
	}

	/** Is the service up, and does it take our key? `GET /v1/models` checks the key. Never throws. */
	async health(): Promise<ServiceHealth> {
		const models = await this.probe("/v1/models");
		if (models.status === 200) return { ok: true, model: this.model };
		if (models.status === 401 || models.status === 403) {
			return {
				ok: false,
				error: this.options.apiKey
					? `API key rejected (HTTP ${models.status})`
					: "no API key: set TYPESAFE_API_KEY (or BRAIN_DECISIONS_API_KEY)",
			};
		}
		return { ok: false, error: models.status === 0 ? models.error : `no decisions API here (HTTP ${models.status})` };
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		const headers = { ...extra };
		if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
		return headers;
	}

	/** One GET. `status` 0 means the server never answered. */
	private async probe(path: string): Promise<{ status: number; error?: string }> {
		const doFetch = this.options.fetchImpl ?? fetch;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
		try {
			const base = this.options.baseUrl.replace(/\/+$/, "");
			const response = await doFetch(`${base}${path}`, {
				headers: this.headers(),
				signal: controller.signal,
			});
			await response.text().catch(() => "");
			return { status: response.status };
		} catch (error) {
			const err = error as Error;
			return {
				status: 0,
				error:
					err.name === "AbortError"
						? `unreachable: timed out after ${this.options.timeoutMs}ms at ${this.options.baseUrl}`
						: `unreachable: ${err.message} (${this.options.baseUrl})`,
			};
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * A choice answer's confidence: the reported `confidence`, else the winning
 * label's probability. A backend that reports only the distribution must not
 * read as zero confidence and send every hop to the fallback.
 */
export function choiceConfidence(answer: { choice: string; confidence?: number; probabilities?: Record<string, number> }): number {
	if (typeof answer.confidence === "number" && Number.isFinite(answer.confidence)) return answer.confidence;
	const probability = answer.probabilities?.[answer.choice];
	return typeof probability === "number" && Number.isFinite(probability) ? probability : 0;
}
