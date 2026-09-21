import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { LocalCore, type LibraryChange, type LibrarySnapshot } from "@loom/core";
import type { LoomAgentOptions } from "@loom/agent";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from "electron";
import { type AgentServer, startAgentServer } from "./agent-server.ts";
import { type AgentEndpoint, type AssetContextAction, IPC } from "../shared/ipc.ts";

const ASSET_SCHEME = "loom-asset";

protocol.registerSchemesAsPrivileged([
	{
		scheme: ASSET_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
]);

const AGENT_OPTIONS: LoomAgentOptions = {
	systemPrompt: "You are Loom, a helpful assistant for a creative asset workspace.",
	model: { provider: "deepseek", model: "deepseek-v4-flash" },
};

const localCore = new LocalCore();
let agentServer: AgentServer | null = null;
let shutdownStarted = false;

const MIME_TYPES: Record<string, string> = {
	".aac": "audio/aac",
	".avi": "video/x-msvideo",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".csv": "text/csv; charset=utf-8",
	".flac": "audio/flac",
	".gif": "image/gif",
	".heic": "image/heic",
	".html": "text/html; charset=utf-8",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json; charset=utf-8",
	".m4a": "audio/mp4",
	".m4v": "video/mp4",
	".md": "text/markdown; charset=utf-8",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".wav": "audio/wav",
	".webm": "video/webm",
	".webp": "image/webp",
};

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null {
	const match = value?.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;

	let start: number;
	let end: number;
	if (match[1]) {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
	} else {
		const suffixLength = Number(match[2]);
		if (!suffixLength) return null;
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	}

	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	) {
		return null;
	}
	return { start, end: Math.min(end, size - 1) };
}

function registerAssetProtocol(): void {
	protocol.handle(ASSET_SCHEME, async (request) => {
		try {
			const url = new URL(request.url);
			if (url.hostname !== "asset") return new Response("Not found", { status: 404 });

			const assetId = decodeURIComponent(url.pathname.slice(1));
			const filePath = await localCore.getAssetFilePath(assetId);
			if (!filePath) return new Response("Asset not found", { status: 404 });

			const info = await stat(filePath);
			if (!info.isFile()) return new Response("Asset not found", { status: 404 });

			const range = parseByteRange(request.headers.get("range"), info.size);
			const start = range?.start ?? 0;
			const end = range?.end ?? Math.max(0, info.size - 1);
			const headers = new Headers({
				"Accept-Ranges": "bytes",
				"Access-Control-Allow-Origin": "*",
				"Content-Length": String(info.size === 0 ? 0 : end - start + 1),
				"Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
			});
			if (range) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
			if (request.method === "HEAD" || info.size === 0) {
				return new Response(null, { status: range ? 206 : 200, headers });
			}

			const stream = createReadStream(filePath, { start, end });
			return new Response(Readable.toWeb(stream) as ReadableStream, {
				status: range ? 206 : 200,
				headers,
			});
		} catch (error) {
			console.error("Failed to serve asset preview", error);
			return new Response("Failed to load asset", { status: 500 });
		}
	});
}

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 860,
		minHeight: 600,
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

function registerIpc(): void {
	ipcMain.handle(IPC.getAgentEndpoint, (): AgentEndpoint => {
		if (!agentServer) throw new Error("Agent server not started");
		return { runtimeUrl: agentServer.runtimeUrl, agentId: agentServer.agentId };
	});

	ipcMain.handle(IPC.getLibrarySnapshot, (): Promise<LibrarySnapshot> => {
		return localCore.getLibrarySnapshot();
	});

	ipcMain.handle(IPC.openLibrary, async (event): Promise<LibrarySnapshot | null> => {
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner
			? await dialog.showOpenDialog(owner, { properties: ["openDirectory"] })
			: await dialog.showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || !result.filePaths[0]) return null;
		return localCore.openLibrary(result.filePaths[0]);
	});

	ipcMain.handle(
		IPC.showAssetContextMenu,
		async (event, assetId: string): Promise<AssetContextAction | null> => {
			if (!(await localCore.getAssetFilePath(assetId))) throw new Error("Asset not found");
			const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;

			return new Promise<AssetContextAction | null>((resolveAction) => {
				let resolved = false;
				const choose = (action: AssetContextAction) => {
					if (resolved) return;
					resolved = true;
					resolveAction(action);
				};
				const menu = Menu.buildFromTemplate([
					{ label: "Rename", click: () => choose("rename") },
					{ label: "Duplicate", click: () => choose("duplicate") },
					{ type: "separator" },
					{ label: "Copy Path", click: () => choose("copy_path") },
					{ label: "Show in Finder", click: () => choose("reveal") },
					{ type: "separator" },
					{ label: "Move to Trash", click: () => choose("trash") },
				]);
				menu.popup({
					window: owner,
					callback: () => {
						if (!resolved) resolveAction(null);
					},
				});
			});
		},
	);

	ipcMain.handle(IPC.renameAsset, (_event, assetId: string, stem: string) => {
		return localCore.renameAsset(assetId, stem);
	});

	ipcMain.handle(IPC.duplicateAsset, (_event, assetId: string) => {
		return localCore.duplicateAsset(assetId);
	});

	ipcMain.handle(IPC.copyAssetPath, async (_event, assetId: string): Promise<void> => {
		const filePath = await localCore.getAssetFilePath(assetId);
		if (!filePath) throw new Error("Asset not found");
		clipboard.writeText(filePath);
	});

	ipcMain.handle(IPC.revealAsset, async (_event, assetId: string): Promise<void> => {
		const filePath = await localCore.getAssetFilePath(assetId);
		if (!filePath) throw new Error("Asset not found");
		shell.showItemInFolder(filePath);
	});

	ipcMain.handle(IPC.trashAsset, async (event, assetId: string): Promise<boolean> => {
		const filePath = await localCore.getAssetFilePath(assetId);
		if (!filePath) throw new Error("Asset not found");
		const owner = BrowserWindow.fromWebContents(event.sender);
		const options = {
			type: "warning" as const,
			buttons: ["Cancel", "Move to Trash"],
			defaultId: 0,
			cancelId: 0,
			message: `Move “${basename(filePath)}” to the Trash?`,
			detail: "The file can be recovered from the system Trash.",
		};
		const result = owner
			? await dialog.showMessageBox(owner, options)
			: await dialog.showMessageBox(options);
		if (result.response !== 1) return false;

		await shell.trashItem(filePath);
		await localCore.forgetAsset(assetId);
		return true;
	});

	localCore.subscribeLibrary((change: LibraryChange) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send(IPC.libraryChanged, change);
		}
	});
}

app
	.whenReady()
	.then(async () => {
		// Development convenience: keep provider secrets in the workspace root.
		// Production will source credentials from settings/keychain instead.
		if (!app.isPackaged) {
			const envFile = resolve(app.getAppPath(), "../../.env");
			if (existsSync(envFile)) process.loadEnvFile(envFile);
		}

		// Start the localhost agent server before the window loads, so the
		// renderer always finds a ready endpoint.
		agentServer = await startAgentServer(AGENT_OPTIONS);
		registerAssetProtocol();
		registerIpc();
		createWindow();

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	})
	.catch((error) => {
		console.error("Failed to start Loom", error);
		app.quit();
	});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", (event) => {
	if (shutdownStarted) return;
	event.preventDefault();
	shutdownStarted = true;

	const server = agentServer;
	agentServer = null;
	void Promise.allSettled([localCore.close(), server?.close() ?? Promise.resolve()]).finally(() => {
		app.quit();
	});
});
