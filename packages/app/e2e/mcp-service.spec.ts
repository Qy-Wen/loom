import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "./loom.ts";

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

test("external MCP supports client-owned permissions, optional authentication, editable tokens, and disconnect", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "requires isolated settings and library");
	test.setTimeout(60_000);
	const port = await unusedPort();
	await expect.poll(() => loomPage.evaluate(async () => !!(await window.loom.getLibrarySnapshot()).rootPath)).toBe(true);
	await loomPage.evaluate(() => window.loom.setAgentPermission("basic"));
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	await loomPage.getByRole("tab", { name: "External access", exact: true }).click();
	const settings = loomPage.locator(".settings-dialog");
	await expect(settings.getByRole("switch", { name: "Enable local MCP service" })).not.toBeChecked();
	// A fresh installation must allow configuration copy without enabling the service first.
	await expect(settings.getByRole("button", { name: "Copy connection configuration", exact: true })).toBeEnabled();
	await settings.getByRole("button", { name: "Copy connection configuration", exact: true }).click();
	await expect(settings.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
	const prepared = await loomPage.evaluate(() => window.loom.getMcpService());
	expect(prepared.enabled).toBe(false);
	expect(prepared.running).toBe(false);
	expect(prepared.token).toBe("");
	const connectionInfo = settings.locator(".settings-connection-info");
	await expect(settings.getByRole("textbox", { name: "Server URL", exact: true })).toHaveCount(0);
	await expect(connectionInfo.getByText(prepared.url, { exact: true })).toBeVisible();
	await expect(settings.getByLabel("Access token", { exact: true })).toHaveValue("");
	await expect(settings.getByLabel("Access token", { exact: true })).toBeEditable();
	const preparedClipboard = await electronApp!.evaluate(({ clipboard }) => clipboard.readText());
	expect(JSON.parse(preparedClipboard).mcpServers.loom.headers).toBeUndefined();
	await expect(settings.getByRole("button", { name: "Copy connection configuration", exact: true })).toBeVisible();
	await settings.getByRole("spinbutton", { name: "Port", exact: true }).fill(String(port));
	await settings.getByRole("button", { name: "Save", exact: true }).click();
	await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	await expect(settings.getByRole("switch", { name: "Enable local MCP service" })).toBeEnabled();
	await settings.getByRole("switch", { name: "Enable local MCP service" }).locator("..").click();
	await expect(settings.locator(".settings-slot-head .settings-probe")).toHaveClass(/\bis-ok\b/);
	const service = await loomPage.evaluate(() => window.loom.getMcpService());
	expect(service.running).toBe(true);
	const userData = await electronApp!.evaluate(({ app }) => app.getPath("userData"));
	expect(JSON.parse(await readFile(join(userData, "mcp-service.json"), "utf8")).encryptedToken).toBe("");
	await settings.getByRole("button", { name: "Copy connection configuration", exact: true }).click();
	await expect(settings.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
	const clipboard = await electronApp!.evaluate(({ clipboard }) => clipboard.readText());
	expect(JSON.parse(clipboard).mcpServers.loom.headers).toBeUndefined();
	await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	const client = new Client({ name: "Desktop MCP verification", version: "1" });
	const transport = new StreamableHTTPClientTransport(new URL(service.url));
	async function verifyConnection(token = "") {
		const probe = new Client({ name: "Auth verification", version: "1" });
		try {
			await probe.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
			expect((await probe.listTools()).tools).toHaveLength(31);
			expect((await probe.callTool({ name: "list_tags", arguments: {} })).isError).toBeUndefined();
		} finally { await probe.close(); }
	}
	try {
		await client.connect(transport);
		const tools = (await client.listTools()).tools;
		expect(tools).toHaveLength(31);
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_settings", "update_settings"]));
		const instructions = "Configured through external MCP";
		expect((await client.callTool({ name: "update_settings", arguments: { instructions } })).isError).toBeUndefined();
		const current = await client.callTool({ name: "get_settings", arguments: {} });
		expect(current.isError).toBeUndefined();
		expect(current.structuredContent).toMatchObject({ instructions });
		expect((await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "", name: "From MCP" } }, undefined, { timeout: 5000 })).isError).toBeUndefined();
		await expect(loomPage.getByRole("region", { name: "External tool approval", exact: true })).toHaveCount(0);
		await expect(loomPage.locator(".library-sidebar")).toContainText("From MCP");
		expect((await client.callTool({ name: "rename_folder", arguments: { relativePath: "From MCP", name: "Renamed through MCP" } }, undefined, { timeout: 5000 })).isError).toBeUndefined();
		expect((await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).folders).toContain("Renamed through MCP");
		for (const level of ["standard", "full", "basic"] as const) {
			await loomPage.evaluate((level) => window.loom.setAgentPermission(level), level);
			expect((await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "", name: `MCP-${level}` } }, undefined, { timeout: 5000 })).isError).toBeUndefined();
		}
		// Folder tools retain the core library's own path rules.
		expect((await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "..", name: "Outside" } })).isError).toBe(true);
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		await loomPage.getByRole("tab", { name: "External access", exact: true }).click();
		await expect(settings.getByRole("region", { name: "Recent external calls" })).toContainText("rename_folder");
		const manualToken = "desktop-manual-token";
		await settings.getByLabel("Access token", { exact: true }).fill(manualToken);
		await settings.getByRole("button", { name: "Save", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getMcpService())).token).toBe(manualToken);
		expect((await fetch(service.url)).status).toBe(401);
		expect(await readFile(join(userData, "mcp-service.json"), "utf8")).not.toContain(manualToken);
		await verifyConnection(manualToken);
		await settings.getByRole("button", { name: "Generate", exact: true }).click();
		const generated = await settings.getByLabel("Access token", { exact: true }).inputValue();
		expect(generated).toMatch(/^[a-f0-9]{64}$/);
		expect((await loomPage.evaluate(() => window.loom.getMcpService())).token).toBe(manualToken);
		// Copy applies the generated draft, so its header always matches the running server.
		await settings.getByRole("button", { name: "Copy connection configuration", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
		const authenticatedClipboard = await electronApp!.evaluate(({ clipboard }) => clipboard.readText());
		expect(JSON.parse(authenticatedClipboard).mcpServers.loom.headers.Authorization).toBe(`Bearer ${generated}`);
		expect((await fetch(service.url, { headers: { Authorization: `Bearer ${manualToken}` } })).status).toBe(401);
		await verifyConnection(generated);
		await settings.getByLabel("Access token", { exact: true }).fill("");
		await settings.getByRole("button", { name: "Save", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getMcpService())).token).toBe("");
		await verifyConnection();
		await expect(settings.getByRole("switch", { name: "Enable local MCP service" })).toBeEnabled();
		await settings.getByRole("switch", { name: "Enable local MCP service" }).locator("..").click();
		await expect(settings.locator(".settings-slot-head .settings-probe")).toHaveClass(/\bis-idle\b/);
		await expect(settings.getByRole("button", { name: "Copy connection configuration", exact: true })).toBeEnabled();
		await settings.getByRole("button", { name: "Copy connection configuration", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
		const stopped = await loomPage.evaluate(() => window.loom.getMcpService());
		expect(stopped.running).toBe(false);
		const stoppedClipboard = await electronApp!.evaluate(({ clipboard }) => clipboard.readText());
		expect(stopped.token).toBe("");
		expect(JSON.parse(stoppedClipboard).mcpServers.loom.headers).toBeUndefined();
	} finally { await client.close(); }
});
