import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setProcessSandboxEnabled } from "@loom/core/sandbox";
import { processSandboxActive } from "../shared/agent-sandbox.ts";
import {
	LocalCore,
	type EmbeddingProvider,
	type RerankProvider,
	type LibraryChange,
	type LibrarySnapshot,
	type PropertyType,
	type PropertyValue,
} from "@loom/core";
import {
	HarnessSessionManager,
	parseAgentPermissionLevel,
	contentWithPlacedAssets,
	implicitSelectionAttachments,
	type LoomAgentOptions,
	type ToolGateDecision,
} from "@loom/agent";
import { composerAssetsAtSend, stageComposerAssets, takeComposerAssets } from "./composer-assets.ts";
import { composerAssetsFromPickedFiles, draftsFromAssets } from "./composer-library-pick.ts";
import { stageComposerImages, takeComposerImages } from "./composer-images.ts";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { applyAppIcon, loadAppIcon } from "./app-icon.ts";
import { type AgentServer, startAgentServer } from "./agent-server.ts";
import { systemPromptForLibrary } from "./agent-prompt.ts";
import { createAssetTools } from "./asset-tools.ts";
import { createFfmpegTools } from "./ffmpeg-tools.ts";
import { createPropertyTools } from "./property-tools.ts";
import { createRelationTools } from "./relation-tools.ts";
import {
	chatSlotChanged,
	createSettingsTools,
	mergeMcpServers,
	modelChangeNotes,
	modelDraftForPatch,
	publicMcpServer,
	publicModelSlot,
	type PublicSettings,
	type SettingsPatch,
} from "./settings-tools.ts";
import { McpHost } from "./mcp/host.ts";
import { McpSettingsStore } from "./mcp/store.ts";
import { AgentInstructionsStore } from "./agent-instructions-store.ts";
import { AgentSandboxStore } from "./agent-sandbox-store.ts";
import { AgentStatsStore } from "./agent-stats-store.ts";
import { parseByteRange } from "./byte-range.ts";
import type { DevTraceRecord } from "../shared/dev-trace.ts";
import { type AgentEndpoint, type AssetContextAction, type FolderContextAction, type LibraryContextAction, type UiSelectionDraft, IPC } from "../shared/ipc.ts";
import { getUiSelection, parseUiSelectionDraft, setUiSelection } from "./ui-selection.ts";
import { parseGeneralSettings, resolveAppLanguage } from "../shared/general-settings.ts";
import { messagesFor, uiPlatform, type Messages, type UiPlatform } from "../shared/locale.ts";
import type { McpServerDraft } from "../shared/mcp-settings.ts";
import type { ModelProbeDraft, ModelSettingsDraft } from "../shared/model-settings.ts";
import { createHttpEmbeddingProvider } from "./embedding-provider.ts";
import { createHttpRerankProvider } from "./rerank-provider.ts";
import { createHttpAudioProvider, createHttpVideoVlmProvider, createHttpVlmProvider } from "./vlm-provider.ts";
import { probeModelSlot } from "./model-probe.ts";
import { configFromDraft } from "./mcp/store.ts";
import { AgentPermissionStore } from "./agent-permission-store.ts";
import { GeneralSettingsStore } from "./general-settings-store.ts";
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

async function uiCopy(): Promise<{ t: Messages; platform: UiPlatform }> {
	const choice = generalSettings ? (await generalSettings.load()).language : "system";
	return {
		t: messagesFor(resolveAppLanguage(choice, app.getLocale())),
		platform: uiPlatform(process.platform),
	};
}

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
	...createRelationTools(localCore),
	...createPropertyTools(localCore),
	...createSettingsTools({
		read: () => readPublicSettings(),
		apply: (patch) => applySettingsPatch(patch),
	}),
];
const AGENT_OPTIONS: LoomAgentOptions = {
	systemPrompt: systemPromptForLibrary(null),
	tools: [...BUILTIN_TOOLS],
};
let modelSettings: ModelSettingsStore | null = null;
let mcpSettings: McpSettingsStore | null = null;
let lastLibrary: LastLibraryStore | null = null;
let generalSettings: GeneralSettingsStore | null = null;
let agentPermission: AgentPermissionStore | null = null;
let agentInstructions: AgentInstructionsStore | null = null;
let agentSandbox: AgentSandboxStore | null = null;
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
		icon: loadAppIcon(),
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

async function applyProcessSandbox(): Promise<void> {
	if (!agentSandbox) throw new Error("Settings store not started");
	const setting = await agentSandbox.load();
	await setProcessSandboxEnabled(processSandboxActive(setting, agentManager.getPermissionLevel()));
}

function registerIpc(): void {
	ipcMain.handle(IPC.getAgentEndpoint, (): AgentEndpoint => {
		if (!agentServer) throw new Error("Agent server not started");
		return { runtimeUrl: agentServer.runtimeUrl, agentId: agentServer.agentId };
	});

	ipcMain.handle(IPC.getLibrarySnapshot, (): Promise<LibrarySnapshot> => {
		return localCore.getLibrarySnapshot();
	});

	ipcMain.handle(IPC.setFavorite, (_event, assetId: string, favorite: boolean): Promise<void> => {
		return localCore.setFavorite(assetId, favorite);
	});

	ipcMain.handle(IPC.addAssetTag, (_event, assetId: string, name: string): Promise<void> => {
		return localCore.addAssetTag(assetId, name);
	});

	ipcMain.handle(IPC.removeAssetTag, (_event, assetId: string, tagId: string): Promise<void> => {
		return localCore.removeAssetTag(assetId, tagId);
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
			const favorite = (await localCore.getLibrarySnapshot()).favoriteAssetIds.includes(assetId);
			const { t, platform } = await uiCopy();
			return popupContextMenu<AssetContextAction>(event, [
				{ label: t.menu.addToChat, click: () => "add_to_chat" },
				{
					label: favorite ? t.menu.removeFromFavorites : t.menu.addToFavorites,
					click: () => favorite ? "unfavorite" : "favorite",
				},
				{ type: "separator" },
				{ label: t.menu.newFolder, click: () => "new_folder" },
				{ type: "separator" },
				{ label: t.menu.rename, click: () => "rename" },
				{ label: t.menu.duplicate, click: () => "duplicate" },
				{ label: t.menu.cut, click: () => "cut" },
				{ label: t.common.copy, click: () => "copy" },
				{ label: t.menu.paste, enabled: canPaste, click: () => "paste" },
				{ type: "separator" },
				{ label: t.menu.copyPath, click: () => "copy_path" },
				{ label: t.menu.reveal(platform), click: () => "reveal" },
				{ type: "separator" },
				{ label: t.menu.moveToTrash(platform), click: () => "trash" },
			]);
		},
	);

	ipcMain.handle(
		IPC.showFolderContextMenu,
		async (event, relativePath: string, canPaste: boolean): Promise<FolderContextAction | null> => {
			localCore.getFolderFilePath(relativePath);
			const { t, platform } = await uiCopy();
			return popupContextMenu<FolderContextAction>(event, [
				{ label: t.menu.newFolder, click: () => "new_folder" },
				{ type: "separator" },
				{ label: t.menu.rename, click: () => "rename" },
				{ label: t.menu.cut, click: () => "cut" },
				{ label: t.common.copy, click: () => "copy" },
				{ label: t.menu.paste, enabled: canPaste, click: () => "paste" },
				{ type: "separator" },
				{ label: t.menu.copyPath, click: () => "copy_path" },
				{ label: t.menu.reveal(platform), click: () => "reveal" },
				{ type: "separator" },
				{ label: t.menu.moveToTrash(platform), click: () => "trash" },
			]);
		},
	);

	ipcMain.handle(
		IPC.showLibraryContextMenu,
		async (event, canPaste: boolean): Promise<LibraryContextAction | null> => {
			const { t } = await uiCopy();
			return popupContextMenu<LibraryContextAction>(event, [
				{ label: t.menu.newFolder, click: () => "new_folder" },
				{ label: t.menu.newMdFile, click: () => "new_md_file" },
				{ label: t.menu.paste, enabled: canPaste, click: () => "paste" },
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

	ipcMain.handle(IPC.moveAssetsInto, (_event, assetIds: string[], destFolder: string) => {
		return localCore.moveAssetsInto(assetIds, destFolder);
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

	ipcMain.handle(IPC.moveFolderInto, (_event, sourceFolder: string, destFolder: string) => {
		return localCore.moveFolderInto(sourceFolder, destFolder);
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
	ipcMain.handle(IPC.pickComposerLibraryAssets, async (event): Promise<UiSelectionDraft[]> => {
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		const owner = BrowserWindow.fromWebContents(event.sender);
		const { t } = await uiCopy();
		const options = {
			title: t.menu.libraryFile,
			defaultPath: snapshot.rootPath,
			properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
		};
		const result = owner
			? await dialog.showOpenDialog(owner, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) return [];
		return composerAssetsFromPickedFiles(snapshot.rootPath, result.filePaths, snapshot.assets);
	});
	ipcMain.handle(IPC.importComposerFiles, async (_event, filePaths: unknown): Promise<UiSelectionDraft[]> => {
		if (!Array.isArray(filePaths) || filePaths.some((path) => typeof path !== "string")) {
			throw new Error("Composer files must be a list of paths");
		}
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		return draftsFromAssets(await localCore.importExternalFiles(filePaths));
	});
	ipcMain.handle(IPC.pickComposerExternalFiles, async (event): Promise<UiSelectionDraft[]> => {
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		const owner = BrowserWindow.fromWebContents(event.sender);
		const { t } = await uiCopy();
		const options = {
			title: t.menu.externalFile,
			properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
		};
		const result = owner
			? await dialog.showOpenDialog(owner, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) return [];
		return draftsFromAssets(await localCore.importExternalFiles(result.filePaths));
	});
	ipcMain.handle(IPC.followUp, async (_event, id: string, text: string) => {
		const session = await agentManager.getSession(id);
		const images = await takeComposerImages(id);
		const chips = await takeLiveComposerAssets(id);
		const attachments = implicitSelectionAttachments(chips, getUiSelection(), session.messages);
		const raw = text.replaceAll("\u200b", "");
		const body = contentWithPlacedAssets(raw.trim() ? raw : "", chips);
		await agentManager.followUp(id, body, {
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
	ipcMain.handle(IPC.getAgentInstructions, async () => {
		if (!agentInstructions) throw new Error("Settings store not started");
		return agentInstructions.load();
	});
	ipcMain.handle(IPC.saveAgentInstructions, async (_event, text: unknown) => {
		if (!agentInstructions) throw new Error("Settings store not started");
		if (typeof text !== "string") throw new Error("Instructions must be text.");
		const saved = await agentInstructions.save(text);
		agentManager.setInstructions(saved);
		return saved;
	});
	ipcMain.handle(IPC.getGeneralSettings, async () => {
		if (!generalSettings) throw new Error("Settings store not started");
		return generalSettings.load();
	});
	ipcMain.handle(IPC.saveGeneralSettings, async (_event, raw: unknown) => {
		if (!generalSettings) throw new Error("Settings store not started");
		return generalSettings.save(parseGeneralSettings(raw));
	});
	ipcMain.handle(IPC.getAgentSandbox, async () => {
		if (!agentSandbox) throw new Error("Settings store not started");
		return agentSandbox.load();
	});
	ipcMain.handle(IPC.saveAgentSandbox, async (_event, enabled: unknown) => {
		if (!agentSandbox) throw new Error("Settings store not started");
		if (typeof enabled !== "boolean") throw new Error("Sandbox setting must be on or off.");
		const saved = await agentSandbox.save(enabled);
		await applyProcessSandbox();
		return saved;
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
	ipcMain.handle(IPC.getAgentPermission, (): string => agentManager.getPermissionLevel());
	ipcMain.handle(IPC.setAgentPermission, async (_event, raw: unknown) => {
		if (!agentPermission) throw new Error("Permission store not started");
		const level = await agentPermission.save(parseAgentPermissionLevel(raw));
		agentManager.setPermissionLevel(level);
		await applyProcessSandbox();
		return level;
	});
	ipcMain.handle(IPC.resolveToolGate, (_event, toolCallId: unknown, decision: unknown) => {
		if (typeof toolCallId !== "string" || !toolCallId.trim()) throw new Error("Tool call is missing");
		if (decision !== "approve" && decision !== "reject") throw new Error("Tool decision is invalid");
		return agentManager.resolveToolGate(toolCallId, decision as ToolGateDecision);
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
		const { t, platform } = await uiCopy();
		const options = {
			type: "warning" as const,
			buttons: [t.common.cancel, t.menu.moveToTrash(platform)],
			defaultId: 0,
			cancelId: 0,
			message: t.menu.trashAsset(basename(filePath), platform),
			detail: t.menu.trashAssetDetail(platform),
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
		const { t, platform } = await uiCopy();
		const options = {
			type: "warning" as const,
			buttons: [t.common.cancel, t.menu.moveToTrash(platform)],
			defaultId: 0,
			cancelId: 0,
			message: t.menu.trashFolder(name, platform),
			detail: t.menu.trashFolderDetail(platform),
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
		applyAppIcon();
		// Development convenience: keep provider secrets in the workspace root.
		// Production will source credentials from settings/keychain instead.
		if (!app.isPackaged) {
			const envFile = resolve(app.getAppPath(), "../../.env");
			if (existsSync(envFile)) process.loadEnvFile(envFile);
		}

		modelSettings = new ModelSettingsStore(join(app.getPath("userData"), "model-settings.json"));
		agentStats = new AgentStatsStore(join(app.getPath("userData"), "agent-stats.json"));
		lastLibrary = new LastLibraryStore(join(app.getPath("userData"), "last-library.json"));
		generalSettings = new GeneralSettingsStore(join(app.getPath("userData"), "general.json"));
		agentPermission = new AgentPermissionStore(join(app.getPath("userData"), "agent-permission.json"));
		agentManager.setPermissionLevel(await agentPermission.load());
		agentInstructions = new AgentInstructionsStore(join(app.getPath("userData"), "AGENTS.md"));
		agentManager.setInstructions(await agentInstructions.load());
		agentSandbox = new AgentSandboxStore(join(app.getPath("userData"), "agent-sandbox.json"));
		await applyProcessSandbox();
		mcpSettings = new McpSettingsStore(mcpConfigPath());
		mcpHost = new McpHost();
		// Start the localhost agent server before the window loads, so the
		// renderer always finds a ready endpoint. MCP attaches in the background.
		await agentManager.setChat(await modelSettings.chat());
		let publishDevTrace: ((record: DevTraceRecord) => void) | undefined;
		if (import.meta.env.DEV) {
			const devTrace = await import("./dev-trace-window.ts");
			devTrace.registerDevTraceIpc(join(import.meta.dirname, "../preload/dev-trace.mjs"));
			publishDevTrace = devTrace.publishDevTrace;
		}
		agentServer = await startAgentServer(
			agentManager,
			getUiSelection,
			(id) => takeComposerImages(id),
			(id) => takeLiveComposerAssets(id),
			publishDevTrace,
		);
		registerAssetProtocol();
		registerIpc();
		await restoreLastLibrary();
		createWindow();
		void attachConfiguredMcp();

		app.on("activate", () => {
			const hasMain = BrowserWindow.getAllWindows().some((window) => window.getTitle() !== "Traces");
			if (!hasMain) createWindow();
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

async function takeLiveComposerAssets(sessionId: string) {
	const chips = await takeComposerAssets(sessionId);
	if (chips.length === 0) return chips;
	const snapshot = await localCore.getLibrarySnapshot();
	return composerAssetsAtSend(chips, snapshot.assets);
}

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
	if (generalSettings && !(await generalSettings.load()).reopenLastLibrary) return;
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
async function syncAgentTools(options?: { preserveRuns?: boolean }): Promise<void> {
	await agentManager.setTools([...BUILTIN_TOOLS, ...(mcpHost?.allTools() ?? [])], options);
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

async function reconnectMcp(
	configs: Awaited<ReturnType<McpSettingsStore["load"]>>,
	options?: { preserveRuns?: boolean },
): Promise<void> {
	const previous = mcpHost;
	mcpHost = new McpHost();
	await mcpHost.connect(configs);
	if (shutdownStarted || !mcpHost) return;
	await syncAgentTools(options);
	if (previous) await previous.close();
}

function notifySettingsChanged(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(IPC.settingsChanged);
	}
}

async function readPublicSettings(): Promise<PublicSettings> {
	if (!modelSettings || !mcpSettings || !agentSandbox || !agentInstructions) throw new Error("Settings store not started");
	const [models, servers, sandbox, instructions] = await Promise.all([
		modelSettings.load(),
		mcpSettings.drafts(),
		agentSandbox.load(),
		agentInstructions.load(),
	]);
	const slots = {} as PublicSettings["models"];
	for (const id of Object.keys(models) as Array<keyof typeof models>) slots[id] = publicModelSlot(models[id]);
	return { models: slots, sandbox, instructions, mcp: servers.map(publicMcpServer) };
}

async function applySettingsPatch(patch: SettingsPatch): Promise<{ notes: string[]; settings: PublicSettings }> {
	if (!modelSettings || !mcpSettings || !agentSandbox || !agentInstructions) throw new Error("Settings store not started");
	const notes: string[] = [];
	if (patch.models) {
		const before = await modelSettings.load();
		const file = await modelSettings.update(modelDraftForPatch(before, patch.models));
		notes.push(...modelChangeNotes(before, file));
		if (chatSlotChanged(before, file)) {
			agentManager.stageChat(resolveChatEndpoint(file, process.env, false));
			notes.push("Chat slot saved. This reply keeps the endpoint it started with. The next message uses the new slot.");
		}
	}
	if (patch.sandbox !== undefined) {
		await agentSandbox.save(patch.sandbox);
		await applyProcessSandbox();
		notes.push(patch.sandbox ? "Process sandbox is on. The next command uses it." : "Process sandbox is off. The next command runs directly.");
	}
	if (patch.instructions !== undefined) {
		const saved = await agentInstructions.save(patch.instructions);
		agentManager.setInstructions(saved);
		agentManager.refreshHarness();
		notes.push("Instructions saved. This reply keeps the text it started with. The next message appends the new text.");
	}
	if (patch.mcp) {
		const next = mergeMcpServers(await mcpSettings.drafts(), patch.mcp);
		await mcpSettings.save(next);
		await reconnectMcp(await mcpSettings.load(), { preserveRuns: true });
		notes.push("MCP servers saved and reconnected.");
	}
	notifySettingsChanged();
	return { notes, settings: await readPublicSettings() };
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


