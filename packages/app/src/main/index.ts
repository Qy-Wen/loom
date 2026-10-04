import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
	LocalCore,
	type EmbeddingProvider,
	type RerankProvider,
	type LibraryChange,
	type LibrarySnapshot,
	type PropertyType,
	type PropertyValue,
} from "@loom/core";
import { HarnessSessionManager, promptAttachments, type LoomAgentOptions } from "@loom/agent";
import { stageComposerAssets, takeComposerAssets } from "./composer-assets.ts";
import { stageComposerImages, takeComposerImages } from "./composer-images.ts";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { type AgentServer, startAgentServer } from "./agent-server.ts";
import { systemPromptForLibrary } from "./agent-prompt.ts";
import { createAssetTools } from "./asset-tools.ts";
import { createFfmpegTools } from "./ffmpeg-tools.ts";
import { McpHost } from "./mcp/host.ts";
import { McpSettingsStore } from "./mcp/store.ts";
import { AgentStatsStore } from "./agent-stats-store.ts";
import { parseByteRange } from "./byte-range.ts";
import { type AgentEndpoint, type AssetContextAction, type FolderContextAction, type LibraryContextAction, IPC } from "../shared/ipc.ts";
import { getUiSelection, parseUiSelectionDraft, setUiSelection } from "./ui-selection.ts";
import type { McpServerDraft } from "../shared/mcp-settings.ts";
import type { ModelProbeDraft, ModelSettingsDraft } from "../shared/model-settings.ts";
import { createHttpEmbeddingProvider } from "./embedding-provider.ts";
import { createHttpRerankProvider } from "./rerank-provider.ts";
import { createHttpAudioProvider, createHttpVideoVlmProvider, createHttpVlmProvider } from "./vlm-provider.ts";
import { probeModelSlot } from "./model-probe.ts";
import { configFromDraft } from "./mcp/store.ts";
import { LastLibraryStore, lastLibraryStillOpenable } from "./last-library-store.ts";
import { ModelSettingsStore, resolveChatEndpoint, settingsView } from "./model-settings-store.ts";

const ASSET_SCHEME = "loom-asset";
const DEFAULT_CDP_PORT = "9344";

function configureAutomation(): void {
	if (process.env.LOOM_E2E === "1") {
		app.setPath("userData", process.env.LOOM_E2E_USER_DATA?.trim() || join(tmpdir(), `loom-e2e-${process.pid}`));
		return;
	}
	if (app.isPackaged || process.env.LOOM_CDP_PORT === "0") return;
	const port = process.env.LOOM_CDP_PORT?.trim() || DEFAULT_CDP_PORT;
	app.commandLine.appendSwitch("remote-debugging-port", port);
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
	app.commandLine.appendSwitch("remote-allow-origins", `http://127.0.0.1:${port}`);
	console.log(`[loom:e2e] CDP http://127.0.0.1:${port}`);
}

configureAutomation();

type ContextMenuItem<T extends string> =
	| { type: "separator" }
	| { label: string; enabled?: boolean; click: () => T };

function popupContextMenu<T extends string>(
	event: IpcMainInvokeEvent,
	items: ContextMenuItem<T>[],
): Promise<T | null> {
	const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
	return new Promise((resolveAction) => {
		let chosen: T | null = null;
		const menu = Menu.buildFromTemplate(
			items.map((item) => {
				if ("label" in item) {
					return {
						label: item.label,
						enabled: item.enabled,
						click: () => {
							chosen = item.click();
						},
					};
				}
				return { type: "separator" as const };
			}),
		);
		menu.popup({
			window: owner,
			callback: () => {
				owner?.focus();
				event.sender.focus();
				resolveAction(chosen);
			},
		});
	});
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: ASSET_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
]);

const localCore = new LocalCore();
const BUILTIN_TOOLS = [
	...createAssetTools(localCore, {
		embedAsset: embedAssetWithSettings,
		embeddingProvider: embeddingProviderFromSettings,
		rerankProvider: rerankProviderFromSettings,
		describeImage: describeImageWithSettings,
		describeVideo: describeVideoWithSettings,
		describeAudio: describeAudioWithSettings,
	}),
	...createFfmpegTools(localCore),
];
const AGENT_OPTIONS: LoomAgentOptions = {
	systemPrompt: systemPromptForLibrary(null),
	tools: [...BUILTIN_TOOLS],
};
let modelSettings: ModelSettingsStore | null = null;
let mcpSettings: McpSettingsStore | null = null;
let lastLibrary: LastLibraryStore | null = null;
let agentStats: AgentStatsStore | null = null;
let mcpHost: McpHost | null = null;
let mcpReady = false;
let agentServer: AgentServer | null = null;
let shutdownStarted = false;
// Keep the single manager and LocalCore on the same root across overlapping open requests.
let libraryTransition: Promise<void> = Promise.resolve();
let openingLibrary = false;
let pendingLibraryChanges: LibraryChange[] = [];
const agentManager = new HarnessSessionManager(AGENT_OPTIONS, (usage) => {
	void agentStats?.record(usage);
});

function sendLibraryChange(change: LibraryChange): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(IPC.libraryChanged, change);
	}
}

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

/**
 * Expose preview bytes by asset UUID rather than leaking absolute paths to the
 * renderer. Range responses are required for seeking in audio/video elements.
 */
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
		return applyOpenedLibrary(result.filePaths[0]);
	});

	ipcMain.handle(
		IPC.showAssetContextMenu,
		async (event, assetId: string, canPaste: boolean): Promise<AssetContextAction | null> => {
			if (!(await localCore.getAssetFilePath(assetId))) throw new Error("Asset not found");
			return popupContextMenu<AssetContextAction>(event, [
				{ label: "Add to chat", click: () => "add_to_chat" },
				{ type: "separator" },
				{ label: "New Folder", click: () => "new_folder" },
				{ type: "separator" },
				{ label: "Rename", click: () => "rename" },
				{ label: "Duplicate", click: () => "duplicate" },
				{ label: "Copy", click: () => "copy" },
				{ label: "Paste", enabled: canPaste, click: () => "paste" },
				{ type: "separator" },
				{ label: "Copy Path", click: () => "copy_path" },
				{ label: "Show in Finder", click: () => "reveal" },
				{ type: "separator" },
				{ label: "Move to Trash", click: () => "trash" },
			]);
		},
	);

	ipcMain.handle(
		IPC.showFolderContextMenu,
		async (event, relativePath: string, canPaste: boolean): Promise<FolderContextAction | null> => {
			localCore.getFolderFilePath(relativePath);
			return popupContextMenu<FolderContextAction>(event, [
				{ label: "New Folder", click: () => "new_folder" },
				{ type: "separator" },
				{ label: "Rename", click: () => "rename" },
				{ label: "Copy", click: () => "copy" },
				{ label: "Paste", enabled: canPaste, click: () => "paste" },
				{ type: "separator" },
				{ label: "Copy Path", click: () => "copy_path" },
				{ label: "Show in Finder", click: () => "reveal" },
				{ type: "separator" },
				{ label: "Move to Trash", click: () => "trash" },
			]);
		},
	);

	ipcMain.handle(
		IPC.showLibraryContextMenu,
		async (event, canPaste: boolean): Promise<LibraryContextAction | null> => {
			return popupContextMenu<LibraryContextAction>(event, [
				{ label: "New Folder", click: () => "new_folder" },
				{ label: "New MD File", click: () => "new_md_file" },
				{ label: "Paste", enabled: canPaste, click: () => "paste" },
			]);
		},
	);

	ipcMain.handle(IPC.renameAsset, (_event, assetId: string, stem: string) => {
		return localCore.renameAsset(assetId, stem);
	});

	ipcMain.handle(IPC.duplicateAsset, (_event, assetId: string) => {
		return localCore.duplicateAsset(assetId);
	});

	ipcMain.handle(IPC.copyAssetsInto, (_event, assetIds: string[], destFolder: string) => {
		return localCore.copyAssetsInto(assetIds, destFolder);
	});

	ipcMain.handle(IPC.createFolder, (_event, parentRelativePath: string) => {
		return localCore.createFolder(parentRelativePath);
	});

	ipcMain.handle(IPC.createMarkdownFile, (_event, parentRelativePath: string) => {
		return localCore.createMarkdownFile(parentRelativePath);
	});

	ipcMain.handle(IPC.renameFolder, (_event, relativePath: string, name: string) => {
		return localCore.renameFolder(relativePath, name);
	});

	ipcMain.handle(IPC.copyFolderInto, (_event, sourceFolder: string, destFolder: string) => {
		return localCore.copyFolderInto(sourceFolder, destFolder);
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

	ipcMain.handle(IPC.copyFolderPath, (_event, relativePath: string): void => {
		clipboard.writeText(localCore.getFolderFilePath(relativePath));
	});

	ipcMain.handle(IPC.revealFolder, (_event, relativePath: string): void => {
		shell.showItemInFolder(localCore.getFolderFilePath(relativePath));
	});

	ipcMain.handle(IPC.getPropertySnapshot, () => localCore.getPropertySnapshot());
	ipcMain.handle(IPC.createProperty, (_event, name: string, type: PropertyType) => {
		return localCore.createProperty(name, type);
	});
	ipcMain.handle(
		IPC.updateProperty,
		(_event, propertyId: string, name: string, type: PropertyType) => {
			return localCore.updateProperty(propertyId, name, type);
		},
	);
	ipcMain.handle(IPC.removeProperty, (_event, propertyId: string) => {
		return localCore.removeProperty(propertyId);
	});
	ipcMain.handle(
		IPC.setAssetProperty,
		(_event, assetId: string, propertyId: string, value: PropertyValue) => {
			return localCore.setAssetProperty(assetId, propertyId, value);
		},
	);
	ipcMain.handle(IPC.removeAssetProperty, (_event, assetId: string, propertyId: string) => {
		return localCore.removeAssetProperty(assetId, propertyId);
	});
	ipcMain.handle(IPC.getAssetEnrichment, (_event, assetId: string) => {
		return localCore.getAssetEnrichment(assetId);
	});
	ipcMain.handle(IPC.getAssetRelations, (_event, assetId: string) => {
		return localCore.listAssetRelations(assetId);
	});
	ipcMain.handle(IPC.listGraphRelations, () => localCore.listGraphRelations());
	ipcMain.handle(IPC.createRelation, (_event, fromAssetId: string, toAssetId: string, type: string) => {
		return localCore.createRelation(fromAssetId, toAssetId, type);
	});
	ipcMain.handle(IPC.removeRelation, (_event, relationId: string) => localCore.removeRelation(relationId));
	ipcMain.handle(IPC.analyzeAsset, (_event, assetId: string) => {
		return localCore.analyzeAsset(assetId);
	});
	ipcMain.handle(IPC.getTextEmbedStatus, async (_event, assetId: string) => {
		const modelId = modelSettings ? (await modelSettings.load()).embedding.model.trim() : "";
		return localCore.getTextEmbedStatus(assetId, modelId || undefined);
	});
	ipcMain.handle(IPC.embedAsset, (_event, assetId: string) => embedAssetWithSettings(assetId));
	ipcMain.handle(IPC.getImageVlmStatus, async (_event, assetId: string) => {
		const modelId = modelSettings ? (await modelSettings.load()).vlm.model.trim() : "";
		return localCore.getImageVlmStatus(assetId, modelId || undefined);
	});
	ipcMain.handle(IPC.describeImage, (_event, assetId: string) => describeImageWithSettings(assetId));
	ipcMain.handle(IPC.getVideoVlmStatus, async (_event, assetId: string) => {
		const modelId = modelSettings ? (await modelSettings.load()).vlm.model.trim() : "";
		return localCore.getVideoVlmStatus(assetId, modelId || undefined);
	});
	ipcMain.handle(IPC.describeVideo, (_event, assetId: string) => describeVideoWithSettings(assetId));
	ipcMain.handle(IPC.getAudioWriteupStatus, async (_event, assetId: string) => {
		const modelId = modelSettings ? (await modelSettings.load()).audio.model.trim() : "";
		return localCore.getAudioWriteupStatus(assetId, modelId || undefined);
	});
	ipcMain.handle(IPC.describeAudio, (_event, assetId: string) => describeAudioWithSettings(assetId));
	ipcMain.handle(IPC.listSessions, () => agentManager.listSessions());
	ipcMain.handle(IPC.createSession, () => agentManager.createSession());
	ipcMain.handle(IPC.openSession, (_event, id: string) => agentManager.openSession(id));
	ipcMain.handle(IPC.getSession, (_event, id: string) => agentManager.getSession(id));
	ipcMain.handle(IPC.stageComposerImages, (_event, id: string, images: unknown) => {
		if (typeof id !== "string" || !id.trim()) throw new Error("Session is missing");
		stageComposerImages(id, images);
	});
	ipcMain.handle(IPC.stageComposerAssets, (_event, id: string, assets: unknown) => {
		if (typeof id !== "string" || !id.trim()) throw new Error("Session is missing");
		stageComposerAssets(id, assets);
	});
	ipcMain.handle(IPC.followUp, async (_event, id: string, text: string) => {
		const session = await agentManager.getSession(id);
		const images = await takeComposerImages(id);
		const chips = await takeComposerAssets(id);
		const attachments = promptAttachments(chips, getUiSelection(), session.messages);
		const body = text.replaceAll("\u200b", "");
		await agentManager.followUp(id, body.trim() ? body : "", {
			...(attachments.length > 0 ? { attachments } : {}),
			...(images.length > 0 ? { images } : {}),
		});
	});
	ipcMain.handle(IPC.branchBefore, (_event, id: string, entryId: string) => agentManager.branchBefore(id, entryId));
	ipcMain.handle(IPC.forkBefore, (_event, id: string, entryId: string) => agentManager.forkBefore(id, entryId));
	ipcMain.handle(IPC.archiveSession, (_event, id: string) => agentManager.archiveSession(id));
	ipcMain.handle(IPC.unarchiveSession, (_event, id: string) => agentManager.unarchiveSession(id));
	ipcMain.handle(IPC.getModelSettings, async () => {
		if (!modelSettings) throw new Error("Settings store not started");
		return modelSettings.view();
	});
	ipcMain.handle(IPC.getMcpSettings, async () => mcpSettingsView());
	ipcMain.handle(IPC.saveMcpSettings, async (_event, drafts: McpServerDraft[]) => {
		if (!mcpSettings) throw new Error("Settings store not started");
		await mcpSettings.save(drafts);
		return mcpSettingsView();
	});
	ipcMain.handle(IPC.setMcpServerLive, async (_event, draft: McpServerDraft) => {
		return setMcpServerLive(draft);
	});
	ipcMain.handle(IPC.probeModelSlot, async (_event, draft: ModelProbeDraft) => {
		return probeModelSlot(draft);
	});
	ipcMain.handle(IPC.getAgentStats, async () => {
		if (!agentStats) throw new Error("Settings store not started");
		return agentStats.view();
	});
	ipcMain.handle(IPC.resetAgentStats, async () => {
		if (!agentStats) throw new Error("Settings store not started");
		return agentStats.reset();
	});

	ipcMain.handle(IPC.setUiSelection, (_event, raw: unknown) => {
		setUiSelection(parseUiSelectionDraft(raw));
	});

	ipcMain.handle(IPC.saveModelSettings, async (_event, draft: ModelSettingsDraft) => {
		if (!modelSettings) throw new Error("Settings store not started");
		const file = await modelSettings.update(draft);
		await agentManager.setChat(resolveChatEndpoint(file, process.env, false));
		return settingsView(file);
	});

	ipcMain.handle(IPC.deleteSession, (_event, id: string) => agentManager.deleteSession(id));

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

	ipcMain.handle(IPC.trashFolder, async (event, relativePath: string): Promise<boolean> => {
		if (!relativePath) throw new Error("Cannot trash the library root");
		const folderPath = localCore.getFolderFilePath(relativePath);
		const owner = BrowserWindow.fromWebContents(event.sender);
		const name = relativePath.includes("/") ? relativePath.slice(relativePath.lastIndexOf("/") + 1) : relativePath;
		const options = {
			type: "warning" as const,
			buttons: ["Cancel", "Move to Trash"],
			defaultId: 0,
			cancelId: 0,
			message: `Move “${name}” to the Trash?`,
			detail: "Everything inside this folder can be recovered from the system Trash.",
		};
		const result = owner
			? await dialog.showMessageBox(owner, options)
			: await dialog.showMessageBox(options);
		if (result.response !== 1) return false;

		await shell.trashItem(folderPath);
		await localCore.forgetFolder(relativePath);
		return true;
	});

	localCore.subscribeLibrary((change: LibraryChange) => {
		if (openingLibrary) pendingLibraryChanges.push(change);
		else sendLibraryChange(change);
	});
	agentManager.subscribeSessions((sessions) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send(IPC.sessionsChanged, sessions);
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

		modelSettings = new ModelSettingsStore(join(app.getPath("userData"), "model-settings.json"));
		agentStats = new AgentStatsStore(join(app.getPath("userData"), "agent-stats.json"));
		lastLibrary = new LastLibraryStore(join(app.getPath("userData"), "last-library.json"));
		mcpSettings = new McpSettingsStore(mcpConfigPath());
		mcpHost = new McpHost();
		// Start the localhost agent server before the window loads, so the
		// renderer always finds a ready endpoint. MCP attaches in the background.
		await agentManager.setChat(await modelSettings.chat());
		agentServer = await startAgentServer(
			agentManager,
			getUiSelection,
			(id) => takeComposerImages(id),
			(id) => takeComposerAssets(id),
		);
		registerAssetProtocol();
		registerIpc();
		await restoreLastLibrary();
		createWindow();
		void attachConfiguredMcp();

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
	if (process.env.LOOM_E2E === "1") return;
	if (shutdownStarted) return;
	event.preventDefault();
	shutdownStarted = true;

	const server = agentServer;
	agentServer = null;
	const host = mcpHost;
	mcpHost = null;
	void libraryTransition.then(() => Promise.allSettled([
		server?.close() ?? Promise.resolve(),
		agentManager.close(),
	])).then(() => Promise.allSettled([
		localCore.close(),
		host?.close() ?? Promise.resolve(),
	])).finally(() => {
		app.quit();
	});
});

async function embedAssetWithSettings(assetId: string, signal?: AbortSignal) {
	const provider = await embeddingProviderFromSettings();
	if (!provider) throw new Error("Enable the Embedding slot in Settings first.");
	return localCore.embedTextAsset(assetId, provider, signal);
}

async function embeddingProviderFromSettings(): Promise<EmbeddingProvider | undefined> {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).embedding;
	if (!slot.enabled || !slot.baseUrl.trim() || !slot.model.trim()) return undefined;
	return createHttpEmbeddingProvider(slot);
}

async function rerankProviderFromSettings(): Promise<RerankProvider | undefined> {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).rerank;
	if (!slot.enabled || !slot.baseUrl.trim() || !slot.model.trim()) return undefined;
	return createHttpRerankProvider(slot);
}

async function applyOpenedLibrary(rootPath: string): Promise<LibrarySnapshot> {
	if (shutdownStarted) throw new Error("App is shutting down");
	const previous = libraryTransition;
	let releaseTransition!: () => void;
	libraryTransition = new Promise<void>((resolve) => { releaseTransition = resolve; });
	await previous;
	openingLibrary = true;
	try {
		// Old asset tools must settle while LocalCore still points at the old library.
		await agentManager.close();
		const snapshot = await localCore.openLibrary(rootPath);
		if (snapshot.rootPath) {
			agentManager.setSystemPrompt(systemPromptForLibrary(snapshot.rootPath));
			await agentManager.openLibrary(snapshot.rootPath, { deferRecovery: !mcpReady });
			await lastLibrary?.remember(snapshot.rootPath);
		}
		setUiSelection(null);
		return snapshot;
	} catch (error) {
		await agentManager.close();
		throw error;
	} finally {
		openingLibrary = false;
		const changes = pendingLibraryChanges;
		pendingLibraryChanges = [];
		releaseTransition();
		for (const change of changes) sendLibraryChange(change);
	}
}

async function restoreLastLibrary(): Promise<void> {
	const rootPath = await lastLibrary?.load();
	if (!rootPath || !(await lastLibraryStillOpenable(rootPath))) return;
	try {
		await applyOpenedLibrary(rootPath);
	} catch (error) {
		console.error("Failed to reopen last library", error);
	}
}

async function describeImageWithSettings(assetId: string, signal?: AbortSignal) {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).vlm;
	if (!slot.enabled || !slot.baseUrl.trim() || !slot.model.trim()) {
		throw new Error("Enable the VLM slot in Settings first.");
	}
	return localCore.describeImageAsset(assetId, createHttpVlmProvider(slot), signal);
}

async function describeVideoWithSettings(assetId: string, signal?: AbortSignal) {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).vlm;
	if (!slot.enabled || !slot.baseUrl.trim() || !slot.model.trim()) {
		throw new Error("Enable the VLM slot in Settings first.");
	}
	return localCore.describeVideoAsset(assetId, createHttpVideoVlmProvider(slot), signal);
}

async function describeAudioWithSettings(assetId: string, signal?: AbortSignal) {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).audio;
	if (!slot.enabled || !slot.baseUrl.trim() || !slot.model.trim()) {
		throw new Error("Enable the Audio slot in Settings first.");
	}
	return localCore.describeAudioAsset(assetId, createHttpAudioProvider(slot), signal);
}

async function setMcpServerLive(draft: McpServerDraft) {
	if (!mcpHost) throw new Error("MCP host not started");
	const id = draft.id.trim();
	if (!id) return { id: "", tools: [], error: "Each MCP server needs an id" };
	if (!draft.enabled) {
		await mcpHost.dropServer(id);
		await syncAgentTools();
		return { id, tools: [] };
	}
	try {
		const status = await mcpHost.upsertServer({ ...configFromDraft(draft), enabled: true });
		await syncAgentTools();
		return status;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { id, tools: [], error: message };
	}
}

/** Push the full tool list (built-in library/FFmpeg plus live MCP tools) to the agent manager. */
async function syncAgentTools(): Promise<void> {
	await agentManager.setTools([...BUILTIN_TOOLS, ...(mcpHost?.allTools() ?? [])]);
	mcpReady = true;
}

function mcpConfigPath(): string {
	return process.env.LOOM_MCP_CONFIG?.trim() || join(app.getPath("userData"), "mcp.json");
}

async function mcpSettingsView() {
	if (!mcpSettings) throw new Error("Settings store not started");
	return {
		path: mcpSettings.path(),
		servers: await mcpSettings.drafts(),
		status: mcpHost?.lastStatus() ?? [],
	};
}

async function reconnectMcp(configs: Awaited<ReturnType<McpSettingsStore["load"]>>): Promise<void> {
	const previous = mcpHost;
	mcpHost = new McpHost();
	await mcpHost.connect(configs);
	if (shutdownStarted || !mcpHost) return;
	await syncAgentTools();
	if (previous) await previous.close();
}

async function attachConfiguredMcp(): Promise<void> {
	if (!mcpSettings) return;
	try {
		await reconnectMcp(await mcpSettings.load());
	} catch (error) {
		console.error("Failed to read MCP config", error);
		await syncAgentTools();
	}
}

