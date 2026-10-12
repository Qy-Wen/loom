import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, Harness, MemoryStorage } from "../dist/vendor-pi-durable/index.js";
import { createCodemodeExtension } from "../dist/vendor-pi-durable/codemode/index.js";

test("compiled durable and codemode load and execute a compiled worker", { timeout: 10_000 }, async () => {
	const sandbox = new CodemodeSandbox();
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT);
		assert.ok((await root.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name === "codemode"));
		const result = await sandbox.execute("text(6 * 7);");
		assert.equal(result.ok, true);
		assert.deepEqual(result.output, [{ type: "text", text: "42" }]);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await sandbox.close();
	}
});
