import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, saveChatEndpoint, test } from "./loom.ts";

function reply(response: ServerResponse, toolName?: string) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = toolName
		? { tool_calls: [{ index: 0, id: "mcp-image", type: "function", function: { name: `fixture__${toolName}`, arguments: "{}" } }] }
		: { content: "Image result received" };
	response.end(`data: ${JSON.stringify({ id: "image", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "image", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: toolName ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

for (const toolName of ["image", "embedded_image"]) test(`MCP ${toolName} reaches the model and renders live, after reload and on a branch`, async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	let modelReceivedImage = false;
	const question = `Return an ${toolName} from the MCP test tool`;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
			const hasResult = parsed.messages.some((message) => message.role === "tool");
			if (hasResult) modelReceivedImage ||= JSON.stringify(parsed.messages).includes("data:image/png;base64,");
			reply(response, hasResult ? undefined : toolName);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await expect(loomPage.locator(".shell")).toBeVisible();
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { input: ["text", "image"] });
		await loomPage.evaluate(async ({ command, script, toolName }) => {
			await window.loom.setAgentPermission("full");
			const draft = {
				id: "fixture", transport: "stdio" as const, command, argsText: `--experimental-strip-types\n${script}${toolName === "embedded_image" ? "\n--embedded" : ""}`,
				envText: "", cwd: "", url: "", headersText: "", enabled: true,
			};
			await window.loom.saveMcpSettings({ upsert: [{ server: draft }] });
			const status = await window.loom.setMcpServerLive(draft);
			if (status.error || !status.tools.includes(toolName)) throw new Error(`MCP image fixture did not connect: ${JSON.stringify(status)}`);
		}, { command: process.execPath, script: fileURLToPath(new URL("../tests/fixtures/mcp-image-server.ts", import.meta.url)), toolName });
		await loomPage.reload();
		await expect(loomPage.getByRole("button", { name: "Agent permission" })).toContainText("Full permission");
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		const composer = loomPage.getByRole("textbox");
		await composer.fill(question);
		await composer.press("Enter");
		const image = loomPage.locator(".tool-call-images img").first();
		await expect(image).toBeVisible();
		await expect(image).toHaveAttribute("src", /^loom-asset:\/\/chat-image\//);
		const sessionId = new URL((await image.getAttribute("src"))!).pathname.split("/")[1]!;
		await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(loomPage.getByText("Image result received", { exact: true }).first()).toBeVisible();
		expect(modelReceivedImage).toBe(true);
		const card = loomPage.locator(".tool-call").filter({ has: image });
		await expect(card.locator(".tool-call-result")).toContainText("Image from MCP");
		await expect(card.locator(".tool-call-result")).not.toContainText("base64");
		await loomPage.reload();
		await expect(image).toBeVisible();
		await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await loomPage.getByRole("textbox").fill("Keep the previous image in a branch");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("Image result received", { exact: true })).toHaveCount(2);
		await loomPage.evaluate(async (sessionId) => {
			const record = await window.loom.getSession(sessionId);
			const latestUser = record.messages.findLast((message) => message.role === "user")!;
			await window.loom.branchBefore(sessionId, String(latestUser.id));
		}, sessionId);
		await loomPage.reload();
		await expect(image).toBeVisible();
		await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	} finally {
		await loomPage.evaluate(async () => {
			const draft = (await window.loom.getMcpSettings()).servers.find((server) => server.id === "fixture");
			if (draft) await window.loom.setMcpServerLive({ ...draft, enabled: false });
			await window.loom.saveMcpSettings({ remove: ["fixture"] });
		}).catch(() => undefined);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
