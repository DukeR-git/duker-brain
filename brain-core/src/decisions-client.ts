/**
 * HTTP client for the decisions API.
 *
 * Works unchanged against the hosted TypeSafe Jev API (`https://api.typesafe.ai`
 * + a bearer token) and a self-hosted Laya server such as ../host-laya, because
 * both speak the same request/response shape on `POST /v1/systemone`.
 *
 * The contract with the caller is that this never throws for a routing failure:
 * a timeout, a 503 while the checkpoint loads, or a malformed body all come back
 * as `{ ok: false }`. An agent turn must not die because a side-car is down.
 */

import { DEFAULT_MODEL } from "./env.js";
import type { Logger } from "./logger.js";
import type { Answer, DecisionsResponse, Question } from "./types.js";

export interface DecisionsClientOptions {
	baseUrl: string;
	path: string;
	apiKey?: string;
	/** Sent as the request's `model`. Required by Jev; a Laya host ignores it. */
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

/** What `health()` found. `backend` says which kind of server answered. */
export interface ServiceHealth {
	ok: boolean;
	backend: "laya" | "jev" | "unknown";
	/** The model that will answer: Laya's served name, or the configured Jev model. */
	model?: string;
	/** Where inference runs: Laya's active device, or "remote". */
	device?: string;
	/** Why `ok` is false, phrased so the user knows what to fix. */
	error?: string;
	/** True while a Laya host is still loading its checkpoint: worth probing again soon. */
	loading?: boolean;
	/** The raw body of whichever probe answered. */
	detail?: Record<string, unknown>;
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

	private get model(): string {
		return this.options.model ?? DEFAULT_MODEL;
	}

	/** Ask one or more typed questions. Laya answers all of them in one forward pass. */
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
				// `model` is ignored by a Laya host and required by Jev; sending it
				// keeps one payload valid against both.
				body: JSON.stringify({ model: this.model, state, questions }),
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					ok: false,
					error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
					// 503 is the host still loading its checkpoint; 429/5xx are worth one retry.
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

	/** Single-choice convenience wrapper, as `pickChoice` in the plan. */
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

	/**
	 * Is the service up, and can we use it?
	 *
	 * Tries `GET /healthz` first - a Laya host answers it with its device and
	 * readiness - then `GET /v1/models`, which both Jev and host-laya serve and
	 * which checks the API key. Never throws.
	 */
	async health(): Promise<ServiceHealth> {
		const laya = await this.probe("/healthz", false);
		if (laya.status === 200 && laya.body) {
			const body = laya.body;
			const model = body.served_model_name === undefined ? undefined : String(body.served_model_name);
			const device = body.device_active === undefined ? undefined : String(body.device_active);
			if (body.status === "failed") {
				return {
					ok: false,
					backend: "laya",
					model,
					error: `the Laya host failed to load its checkpoint: ${String(body.error ?? "see its logs")}`,
					detail: body,
				};
			}
			if (body.ready === false || body.status === "loading") {
				return {
					ok: false,
					backend: "laya",
					model,
					loading: true,
					error: "the Laya host is still loading its checkpoint",
					detail: body,
				};
			}

			// A host started with LAYA_API_KEY checks the key on /v1/*; say so now
			// rather than failing every prompt with a 401.
			const models = await this.probe("/v1/models", true);
			if (models.status === 401 || models.status === 403) {
				return {
					ok: false,
					backend: "laya",
					model,
					device,
					error: this.options.apiKey
						? `the Laya host rejected the API key (HTTP ${models.status})`
						: "the Laya host requires an API key: set BRAIN_DECISIONS_API_KEY to its LAYA_API_KEY",
					detail: body,
				};
			}
			return { ok: true, backend: "laya", model, device, detail: body };
		}
		if (laya.status === 0) return { ok: false, backend: "unknown", error: laya.error };

		const models = await this.probe("/v1/models", true);
		if (models.status === 200) {
			return {
				ok: true,
				backend: "jev",
				model: this.model,
				device: "remote",
				detail: models.body,
			};
		}
		if (models.status === 401 || models.status === 403) {
			return {
				ok: false,
				backend: "jev",
				error: this.options.apiKey
					? `API key rejected (HTTP ${models.status})`
					: "no API key: set TYPESAFE_API_KEY (or BRAIN_DECISIONS_API_KEY)",
			};
		}
		return {
			ok: false,
			backend: "unknown",
			error: models.status === 0 ? models.error : `no decisions API here (HTTP ${models.status})`,
		};
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		const headers = { ...extra };
		if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
		return headers;
	}

	/** One GET. `status` 0 means the server never answered. */
	private async probe(
		path: string,
		authenticated: boolean,
	): Promise<{ status: number; body?: Record<string, unknown>; error?: string }> {
		const doFetch = this.options.fetchImpl ?? fetch;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
		try {
			const base = this.options.baseUrl.replace(/\/+$/, "");
			const response = await doFetch(`${base}${path}`, {
				headers: authenticated ? this.headers() : {},
				signal: controller.signal,
			});
			const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
			return { status: response.status, body: body && typeof body === "object" ? body : undefined };
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
