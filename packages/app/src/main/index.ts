import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { LoomAgentOptions } from "@loom/agent";
import { type AgentServer, startAgentServer } from "./agent-server.ts";
import { type AgentEndpoint, IPC } from "../shared/ipc.ts";

const AGENT_OPTIONS: LoomAgentOptions = {
	systemPrompt: "You are Loom, a helpful assistant for a creative asset workspace.",
	model: { provider: "deepseek", model: "deepseek-v4-flash" },
};

let agentServer: AgentServer | null = null;

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1100,
		height: 760,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.mjs"),
			sandbox: false,
		},
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(async () => {
	// Development convenience: keep provider secrets in the workspace root.
	// Production will source credentials from settings/keychain instead.
	if (!app.isPackaged) {
		const envFile = resolve(app.getAppPath(), "../../.env");
		if (existsSync(envFile)) process.loadEnvFile(envFile);
	}

	// Start the localhost agent server BEFORE the window loads, so the renderer
	// always finds a ready endpoint.
	agentServer = await startAgentServer(AGENT_OPTIONS);

	ipcMain.handle(IPC.getAgentEndpoint, (): AgentEndpoint => {
		if (!agentServer) throw new Error("Agent server not started");
		return { runtimeUrl: agentServer.runtimeUrl, agentId: agentServer.agentId };
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", async (event) => {
	if (!agentServer) return;
	event.preventDefault();
	const server = agentServer;
	agentServer = null;
	await server.close().catch(() => undefined);
	app.quit();
});
