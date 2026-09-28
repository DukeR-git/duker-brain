import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { numberFlag, parseArgs } from "../src/cli.js";

const VALUES = new Set(["vault", "n", "min-conf"]);

describe("parseArgs", () => {
	it("reads commands, positionals, value flags and switches", () => {
		const args = parseArgs(["route", "--vault", "/v", "how", "do", "I", "--json"], VALUES);
		assert.equal(args.command, "route");
		assert.deepEqual(args.positional, ["how", "do", "I"]);
		assert.deepEqual(args.flags, { vault: "/v", json: true });
	});

	it("accepts --name=value and short aliases", () => {
		const args = parseArgs(["bench", "--min-conf=0.6", "-n", "5", "-v"], VALUES, { v: "debug" });
		assert.deepEqual(args.flags, { "min-conf": "0.6", n: "5", debug: true });
	});

	it("stops reading flags after --, and keeps negative numbers as values", () => {
		const args = parseArgs(["route", "--", "-v is a flag?"], VALUES);
		assert.deepEqual(args.positional, ["-v is a flag?"]);
		assert.deepEqual(args.flags, {});
		assert.deepEqual(parseArgs(["x", "-5"], VALUES).positional, ["-5"]);
	});
});

describe("numberFlag", () => {
	it("validates type and range", () => {
		assert.deepEqual(numberFlag({ n: "20" }, "n", { min: 1, integer: true }), { value: 20 });
		assert.match(numberFlag({ n: "abc" }, "n").error!, /needs a number/);
		assert.match(numberFlag({ n: "0" }, "n", { min: 1 }).error!, /at least 1/);
		assert.match(numberFlag({ n: "2.5" }, "n", { integer: true }).error!, /whole number/);
		assert.match(numberFlag({ n: true }, "n").error!, /needs a number/);
		assert.deepEqual(numberFlag({}, "n"), {});
	});
});
