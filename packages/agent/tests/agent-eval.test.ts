import assert from "node:assert/strict";
import { test } from "node:test";
import { runStubAgentToolsEval } from "../evals/agent-tools.ts";
import { scoreAgentTask } from "../evals/agent-score.ts";

test("scoreAgentTask flags missing tools, forbidden calls, and answer misses", () => {
	const pass = scoreAgentTask(
		{ id: "ok", user: "x", expectTools: ["search_assets"], forbidTools: ["bash"], argIncludes: { search_assets: { query: "dock" } } },
		[{ name: "search_assets", args: { query: "bicycle by the dock" } }],
		"",
	);
	assert.equal(pass.ok, true);

	const missing = scoreAgentTask(
		{ id: "miss", user: "x", expectTools: ["inspect_asset"], forbidTools: [] },
		[],
		"",
	);
	assert.equal(missing.ok, false);
	assert.deepEqual(missing.missingTools, ["inspect_asset"]);

	const forbidden = scoreAgentTask(
		{ id: "bad", user: "x", expectTools: [], forbidTools: ["bash"] },
		[{ name: "bash", args: { command: "rm -rf" } }],
		"",
	);
	assert.equal(forbidden.ok, false);
	assert.deepEqual(forbidden.forbiddenHits, ["bash"]);

	const answer = scoreAgentTask(
		{ id: "ans", user: "x", expectTools: [], forbidTools: [], answerIncludes: ["4"] },
		[],
		"the sum is 5",
	);
	assert.equal(answer.ok, false);
	assert.deepEqual(answer.answerMisses, ["4"]);
});

test("stub Chat meets the agent gold tasks", async () => {
	const result = await runStubAgentToolsEval();
	assert.equal(result.failed, 0, result.scores.filter((score) => !score.ok).map((score) => score.id).join(", "));
	assert.equal(result.passed, result.scores.length);
});

test("the eval's search tool descriptions match the product's", async () => {
	const { readFile } = await import("node:fs/promises");
	const { MOCK_TOOLS } = await import("../evals/agent-tools.ts");
	const source = await readFile(new URL("../../app/src/main/tools/asset-tools.ts", import.meta.url), "utf8");
	for (const name of ["search_assets", "deep_search_assets"]) {
		const at = source.indexOf(`name: "${name}"`);
		const from = source.indexOf("description:", at);
		const to = source.indexOf("parameters:", from);
		const product = [...source.slice(from, to).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]).join("");
		const mock = MOCK_TOOLS.find((tool) => tool.name === name);
		assert.equal(mock?.description, product, `${name} description drifted from the product tool`);
	}
});

test("a model request that never answers fails the task with what was in flight instead of hanging", async () => {
	const { createServer } = await import("node:http");
	const server = createServer(() => { /* accept the request and never reply */ });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		const started = Date.now();
		const { runAgentToolsEval } = await import("../evals/agent-tools.ts");
		const result = await runAgentToolsEval({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "eval" }, { taskTimeoutMs: 300 });
		assert.equal(result.passed, 0);
		assert.equal(result.failed, result.scores.length);
		assert.match(result.scores[0]!.error ?? "", /stalled while waiting for the answer: no tool was running, so the model request itself did not finish/);
		assert.match(result.scores[0]!.error ?? "", new RegExp(`"${result.scores[0]!.id}"`));
		assert.ok(Date.now() - started < 20_000, "every task is cut off by its own timeout");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("stalledMessage names tools still running in native state", async () => {
	const { stalledMessage } = await import("../evals/agent-tools.ts");
	const states: import("../src/durable.ts").LiveState[] = [{ tools: [
		{ callId: "a", name: "run_retrieve_agent", status: "running" },
		{ callId: "b", name: "inspect_asset", status: "done" },
	] }];
	const text = stalledMessage("t", "waiting for the answer", states);
	assert.match(text, /tools still running: run_retrieve_agent/);
	assert.doesNotMatch(text, /inspect_asset/);
});

test("firstSearch fails a task whose first search was the other tool, even if the right one came later", () => {
	const task = { id: "m", user: "x", expectTools: ["deep_search_assets"], forbidTools: [], firstSearch: "deep_search_assets" as const };
	const late = scoreAgentTask(task, [{ name: "search_assets", args: {} }, { name: "deep_search_assets", args: {} }], "");
	assert.equal(late.ok, false);
	assert.match(late.wrongFirstSearch ?? "", /search_assets first, wanted deep_search_assets/);
	const first = scoreAgentTask(task, [{ name: "deep_search_assets", args: {} }, { name: "search_assets", args: {} }], "");
	assert.equal(first.ok, true);
	assert.equal(first.wrongFirstSearch, undefined);
});
