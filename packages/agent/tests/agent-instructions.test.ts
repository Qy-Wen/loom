import assert from "node:assert/strict";
import { test } from "node:test";
import { systemPromptWithInstructions } from "../src/agent-instructions.ts";

test("systemPromptWithInstructions appends user text and skips an empty note", () => {
	assert.equal(systemPromptWithInstructions("Base.", ""), "Base.");
	assert.equal(systemPromptWithInstructions("Base.", "  \n"), "Base.");
	const prompt = systemPromptWithInstructions("Base.", "Prefer short titles.\r\n");
	assert.match(prompt, /^Base\.\n\nUser instructions are shown below/);
	assert.match(prompt, /Prefer short titles\.$/);
});
