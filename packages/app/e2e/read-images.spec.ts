import { writeFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, saveChatEndpoint, test } from "./loom.ts";

const filename = "photon-read-test.webp";
// A valid 2x2 WebP. Preparing even a small inline image loads Photon's WASM and decodes it.
const webp = "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=";

function reply(response: ServerResponse, read: boolean) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = read
		? { tool_calls: [{ index: 0, id: "read-webp", type: "function", function: { name: "read", arguments: JSON.stringify({ path: filename }) } }] }
		: { content: "WebP image received" };
	response.end(`data: ${JSON.stringify({ id: "read-image", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "read-image", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

test("bundled Electron read resolves Photon WASM and returns a WebP image", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	let modelImageRequest = "";
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
			const read = !parsed.messages.some((message) => message.role === "tool");
			if (!read) modelImageRequest = body;
			reply(response, read);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	let path: string | undefined;
	try {
		await expect(loomPage.locator(".shell")).toBeVisible();
		const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
		expect(root).toBeTruthy();
		path = join(root!, filename);
		await writeFile(path, Buffer.from(webp, "base64"));
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { input: ["text", "image"] });
		await loomPage.evaluate(() => window.loom.setAgentPermission("full"));
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill(`Read ${filename}`);
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("WebP image received", { exact: true }).first()).toBeVisible();
		expect(modelImageRequest).toContain(`data:image/webp;base64,${webp}`);
		expect(modelImageRequest).not.toContain("Cannot find module");
	} finally {
		if (path) await rm(path, { force: true });
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
