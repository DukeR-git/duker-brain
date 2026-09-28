/**
 * A fake decisions API that speaks the same shape as host-laya - or, with
 * `jevKey` set, behaves like the hosted Jev API: no /healthz, and every call
 * needs the bearer key.
 *
 * Tests drive it with a scripted routing table rather than a real model, so the
 * traversal logic is tested deterministically and without a GPU. The one test
 * that talks to the real service is opt-in via BRAIN_LIVE_URL (live.test.ts).
 */

import { createServer, type Server } from "node:http";

import type { Answer, DecisionsRequest, Question } from "../src/types.js";

/** The paths a real backend serves; anything else is a 404, so a wrong client path fails loudly. */
const DECISION_PATHS = new Set(["/v1/systemone", "/v1/decisions"]);

export interface MockBehaviour {
	/** Label to choose, given the option ids available at this hop. */
	chooseBy?: (options: string[], state: string, hop: number) => string;
	/** Confidence to report. */
	confidence?: number | ((hop: number) => number);
	/** Report probabilities but no `confidence` field. */
	omitConfidence?: boolean;
	/** Custom probability distribution to report. */
	probabilities?: Record<string, number> | ((options: string[], state: string, hop: number) => Record<string, number>);
	/** Laya's act probability for the choice answer. */
	actProbability?: number;
	/** Noul probability for the gate question. */
	gate?: number;
	/** Fail every request with this HTTP status. */
	failWith?: number;
	/** Sent as `Retry-After` (seconds) with `failWith`. */
	retryAfter?: string;
	/** Answer 200 with a body that is not JSON. */
	notJson?: boolean;
	/** Delay before answering, for timeout tests. */
	delayMs?: number;
	/** Answer with a label that is not on the menu. */
	offMenu?: boolean;
	/** Omit the choice answer entirely. */
	omitChoice?: boolean;
	/** Service warnings to attach to every answer. */
	warnings?: string[];
	/** Act like hosted Jev: 404 on /healthz, and 403 unless `Authorization: Bearer <jevKey>`. */
	jevKey?: string;
	/** Act like a Laya host started with LAYA_API_KEY: /healthz open, /v1/* needs the key (401). */
	layaKey?: string;
	/** What a Laya /healthz reports: ready (default), still loading, or failed to load. */
	health?: "ready" | "loading" | "failed";
}

export interface MockServer {
	url: string;
	/** Every request body the server received, in order. */
	requests: DecisionsRequest[];
	/** Paths of every decision request, in order. */
	paths: string[];
	/** Total decision requests that reached the server, including failed ones. */
	hits: number;
	behaviour: MockBehaviour;
	close(): Promise<void>;
}

function scoreOption(option: string, state: string): number {
	// Crude lexical overlap, so the default behaviour routes plausibly without a
	// model: it lets tests assert on trails rather than on hard-coded labels.
	const words = new Set(state.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
	const parts = option.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	return parts.reduce((total, part) => total + (words.has(part) ? 1 : 0), 0);
}

export async function startMockDecisions(behaviour: MockBehaviour = {}): Promise<MockServer> {
	const requests: DecisionsRequest[] = [];
	const state: MockServer = {
		url: "",
		requests,
		paths: [],
		hits: 0,
		behaviour,
		close: async () => undefined,
	};

	const server: Server = createServer((req, res) => {
		const current = state.behaviour;
		const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(body));
		};

		const jevKey = current.jevKey;
		const layaKey = current.layaKey;
		const bearer = req.headers.authorization;
		const jevAuthorised = !jevKey || bearer === `Bearer ${jevKey}`;
		const layaAuthorised = !layaKey || bearer === `Bearer ${layaKey}`;

		if (req.url === "/healthz") {
			if (jevKey) return json(404, { detail: "Not Found" });
			const health = current.health ?? "ready";
			return json(200, {
				ready: health === "ready",
				status: health === "ready" ? "ok" : health,
				...(health === "failed" ? { error: "no XPU device" } : {}),
				served_model_name: "mock",
				device_active: "cpu",
			});
		}

		if (req.url === "/v1/models") {
			if (!layaAuthorised) return json(401, { error: { type: "authentication_error", message: "bad key" } });
			return jevAuthorised
				? json(200, { data: [{ id: "jev-latest" }] })
				: json(403, { detail: { error_type: "authentication_error" } });
		}

		if (!DECISION_PATHS.has(req.url ?? "")) return json(404, { detail: "Not Found" });

		if (!jevAuthorised) return json(403, { detail: { error_type: "authentication_error" } });
		if (!layaAuthorised) return json(401, { error: { type: "authentication_error", message: "bad key" } });

		state.hits++;
		state.paths.push(req.url ?? "");

		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const respond = () => {
				const behaviour = state.behaviour;

				if (behaviour.failWith) {
					return json(
						behaviour.failWith,
						{ error: { type: "mock", message: "scripted failure" } },
						behaviour.retryAfter ? { "retry-after": behaviour.retryAfter } : {},
					);
				}
				if (behaviour.notJson) {
					res.writeHead(200, { "content-type": "text/html" });
					res.end("<html>proxy error</html>");
					return;
				}

				let payload: DecisionsRequest;
				try {
					payload = JSON.parse(body) as DecisionsRequest;
				} catch {
					return json(400, {});
				}
				requests.push(payload);

				const hop = requests.length - 1;
				const answers: Record<string, Answer> = {};

				for (const [id, question] of Object.entries(payload.questions as Record<string, Question>)) {
					if (question.type === "noul") {
						answers[id] = { type: "noul", noul: behaviour.gate ?? 0.95, confidence: 0.9 };
						continue;
					}
					if (question.type !== "choice") continue;
					if (behaviour.omitChoice) continue;

					const options = Object.keys(question.criteria);
					const stateText = typeof payload.state === "string" ? payload.state : JSON.stringify(payload.state);

					let choice: string;
					if (behaviour.offMenu) {
						choice = "__not_a_real_option__";
					} else if (behaviour.chooseBy) {
						choice = behaviour.chooseBy(options, stateText, hop);
					} else {
						choice = options.reduce((best, option) =>
							scoreOption(option, stateText) > scoreOption(best, stateText) ? option : best,
						);
					}

					const confidence =
						typeof behaviour.confidence === "function" ? behaviour.confidence(hop) : (behaviour.confidence ?? 0.93);

					let probabilities: Record<string, number> = {};
					if (typeof behaviour.probabilities === "function") {
						probabilities = behaviour.probabilities(options, stateText, hop);
					} else if (behaviour.probabilities) {
						probabilities = behaviour.probabilities;
					} else {
						const remainder = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
						for (const option of options) probabilities[option] = option === choice ? confidence : remainder;
					}

					answers[id] = {
						type: "choice",
						choice,
						...(behaviour.omitConfidence ? {} : { confidence }),
						probabilities,
						...(behaviour.actProbability !== undefined ? { action: { act_probability: behaviour.actProbability } } : {}),
					};
				}

				json(200, {
					id: `dec_mock_${requests.length}`,
					model: "mock",
					created: Math.floor(Date.now() / 1000),
					answers,
					usage: { input_tokens: 42, output_tokens: 0 },
					routing: { model: "mock", device: "cpu", latency_ms: 12.3 },
					warnings: behaviour.warnings ?? [],
				});
			};

			const delay = state.behaviour.delayMs ?? 0;
			if (delay) setTimeout(respond, delay);
			else respond();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock server did not bind a port");

	state.url = `http://127.0.0.1:${address.port}`;
	state.close = () =>
		new Promise<void>((resolve, reject) => {
			server.closeAllConnections?.();
			server.close((error) => (error ? reject(error) : resolve()));
		});

	return state;
}
