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
