import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { ensureWindowsSandboxInstalled, setProcessSandboxEnabled, setProcessSandboxFailureHandler } from "@loom/core/sandbox";
import { processSandboxActive } from "../shared/agent-sandbox.ts";
import {
	LocalCore,
	resolveMediaBinary,
	type DescribeOptions,
	type EmbedOptions,
	type EmbeddingProvider,
	type RerankProvider,
	type LibraryChange,
	type LibrarySnapshot,
	type PropertyType,
	type PropertyValue,
} from "@loom/core";
import {
	gradeSiblingRelative,
	gradeVideoSiblingRelative,
	isGradeableVideo,
	isGradeExportPath,
	isGradeVideoExportPath,
} from "@loom/core/grade";
import { sweepStaleTemp, TEMP_ROOT_NAME } from "@loom/core/temp";
import {
	parseAgentPermissionLevel,
	type LoomAgentOptions,
} from "@loom/agent";
import { appendAppLog, appLogDirectory } from "./desktop/app-log.ts";
import { ChatService } from "./chat/chat-service.ts";
import { chatRecord } from "./chat/chat-record.ts";
import { composerAssetsAtSend, takeComposerAssets } from "./composer/composer-assets.ts";
import { composerAssetsFromPickedFiles, draftsFromAssets } from "./composer/composer-library-pick.ts";
import { stageComposerInput, takeComposerImages } from "./composer/composer-images.ts";
import { importComposerFiles } from "./composer/composer-import.ts";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { applyAppIcon, loadAppIcon } from "./desktop/app-icon.ts";
import { clipboardHasFiles, readFileClipboard } from "./desktop/file-clipboard.ts";
import { type AgentServer, startAgentServer } from "./chat/agent-server.ts";
import { systemPromptForLibrary } from "./chat/agent-prompt.ts";
import { createAssetTools } from "./tools/asset-tools.ts";
import { createFfmpegTools } from "./tools/ffmpeg-tools.ts";
import { createPropertyTools } from "./tools/property-tools.ts";
import { createRelationTools } from "./tools/relation-tools.ts";
import { WebToolsService } from "./web/web-service.ts";
import {
	createSettingsTools,
	mergeMcpServers,
	modelChangeNotes,
	publicMcpServer,
	publicModelSlot,
	type PublicSettings,
	type SettingsPatch,
} from "./tools/settings-tools.ts";
import { McpHost } from "./mcp/host.ts";
import { McpSettingsStore } from "./mcp/store.ts";
import { SerialQueue } from "./storage/serial-queue.ts";
import { AgentInstructionsStore } from "./settings/agent-instructions-store.ts";
import { AgentSandboxStore } from "./settings/agent-sandbox-store.ts";
import { AgentStatsStore } from "./chat/agent-stats-store.ts";
import { parseByteRange } from "./desktop/byte-range.ts";
import { type AgentEndpoint, type AssetContextAction, type FolderContextAction, type LibraryContextAction, type UiSelectionDraft, IPC } from "../shared/ipc.ts";
import { getUiSelection, parseUiSelectionDraft, setUiSelection } from "./composer/ui-selection.ts";
import { parseGeneralSettingsPatch, resolveAppLanguage } from "../shared/general-settings.ts";
import { messagesFor, uiPlatform, type Messages, type UiPlatform } from "../shared/locale.ts";
import type { McpServerDraft, McpSettingsPatch } from "../shared/mcp-settings.ts";
import type { ModelProbeDraft, ModelSettingsPatch } from "../shared/model-settings.ts";
import { createHttpEmbeddingProvider } from "./models/embedding-provider.ts";
import { createHttpRerankProvider } from "./models/rerank-provider.ts";
import { createHttpAudioProvider, createHttpVideoVlmProvider, createHttpVlmProvider } from "./models/vlm-provider.ts";
import { probeModelSlot } from "./models/model-probe.ts";
import { configFromDraft } from "./mcp/store.ts";
import { AgentPermissionStore } from "./settings/agent-permission-store.ts";
import { CommandAllowStore } from "./settings/command-allow-store.ts";
import type { CommandAllowView } from "@loom/agent/tool-permission";
import { GeneralSettingsStore } from "./settings/general-settings-store.ts";
import { LastLibraryStore, lastLibraryStillOpenable } from "./desktop/last-library-store.ts";
import { ModelSettingsStore, settingsView } from "./models/model-settings-store.ts";
import { createChatStorage } from "./models/chat-storage.ts";
import { DeviceIdStore } from "./models/device-id-store.ts";
import { ChatModelService } from "./models/chat-model-service.ts";
import { applyChatSettingsPatch, parseChatSettingsPatch, publicChatSettings } from "./tools/chat-settings-tools.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const ASSET_SCHEME = "loom-asset";
const DEFAULT_CDP_PORT = "9344";

let writeAppLog = (_message: string): void => {};

function appLog(message: string): void {
	writeAppLog(message);
}

function logErrorText(error: unknown): string {
	if (error instanceof Error) return error.stack ?? error.message;
	return String(error);
}

function logMediaBinaries(): void {
	for (const program of ["ffmpeg", "ffprobe"] as const) {
		try {
			appLog(`${program} ${resolveMediaBinary(program)}`);
		} catch (error) {
			appLog(`${program} unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function configureAutomation(): void {
	if (process.env.LOOM_E2E === "1") {
		app.setPath("userData", process.env.LOOM_E2E_USER_DATA?.trim() || join(tmpdir(), TEMP_ROOT_NAME, "e2e", String(process.pid)));
		// A test run opens and closes many windows. On macOS a "prohibited" app never becomes the frontmost
		// one, so it cannot pull the user away from what they are doing. LOOM_E2E_VISIBLE=1 turns this off.
		if (process.platform === "darwin" && process.env.LOOM_E2E_VISIBLE !== "1") app.setActivationPolicy("prohibited");
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
// Multiple windows share one main-process owner; another app process must not open the same durable store.
const ownsAppInstance = app.requestSingleInstanceLock();
if (!ownsAppInstance) app.exit(0);
app.on("second-instance", () => { BrowserWindow.getAllWindows()[0]?.focus(); });

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
		read: (chatProvider) => readPublicSettings(chatProvider),
		apply: (patch) => applySettingsPatch(patch),
	}),
];
const AGENT_OPTIONS: LoomAgentOptions = {
	systemPrompt: systemPromptForLibrary(null),
	tools: [...BUILTIN_TOOLS],
};
const settingsWrites = new SerialQueue();
let modelSettings: ModelSettingsStore | null = null;
let chatModels: ChatModelService | null = null;
let mcpSettings: McpSettingsStore | null = null;
let lastLibrary: LastLibraryStore | null = null;
let generalSettings: GeneralSettingsStore | null = null;
let agentPermission: AgentPermissionStore | null = null;
let commandAllows: CommandAllowStore | null = null;
let agentInstructions: AgentInstructionsStore | null = null;
let agentSandbox: AgentSandboxStore | null = null;
let agentStats: AgentStatsStore | null = null;
let mcpHost: McpHost | null = null;
let agentServer: AgentServer | null = null;
let shutdownStarted = false;
let gradePreview: AbortController | null = null;
// Keep the library agent owner and LocalCore on the same root across overlapping open requests.
let libraryTransition: Promise<void> = Promise.resolve();
let openingLibrary = false;
let pendingLibraryChanges: LibraryChange[] = [];
let chat: ChatService | null = null;

function requireChat(): ChatService {
	if (!chat) throw new Error("Agent runtime not started");
	return chat;
}

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
	".tif": "image/tiff",
	".tiff": "image/tiff",
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
			if (url.hostname === "chat-image") {
				const match = /^\/([1-9]\d*)\/([1-9]\d*)\/(\d+)$/.exec(url.pathname);
				const image = match ? await requireChat().getChatImage(match[1]!, match[2]!, Number(match[3])) : undefined;
				if (!image || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) return new Response("Image not found", { status: 404 });
				return new Response(Buffer.from(image.data, "base64"), { headers: { "Content-Type": image.mimeType, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
			}
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
	const mac = process.platform === "darwin";
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 860,
		minHeight: 600,
		icon: loadAppIcon(),
		// Test runs open and close many windows. Keep them off the user's desktop (see LOOM_E2E_VISIBLE).
		show: !(process.env.LOOM_E2E === "1" && process.env.LOOM_E2E_VISIBLE !== "1"),
		titleBarStyle: mac ? "hiddenInset" : "hidden",
		...(mac
			? { trafficLightPosition: { x: 14, y: 13 } }
			: { titleBarOverlay: { color: "#f3f3f1", symbolColor: "#202124", height: 40 } }),
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

	const sendFullscreen = (fullscreen: boolean) => {
		if (!win.isDestroyed()) win.webContents.send(IPC.fullscreenChanged, fullscreen);
	};
	win.on("enter-full-screen", () => sendFullscreen(true));
	win.on("leave-full-screen", () => sendFullscreen(false));
}

async function applyProcessSandbox(): Promise<void> {
	if (!agentSandbox) throw new Error("Settings store not started");
	const setting = await agentSandbox.load();
	await setProcessSandboxEnabled(processSandboxActive(setting, requireChat().getPermissionLevel()));
	// Dev installs the sandbox from pnpm install. A packaged app has no
	// postinstall, so Windows asks for the one-time administrator consent here.
	if (!app.isPackaged) return;
	const note = await ensureWindowsSandboxInstalled();
	if (note) appLog(note);
}

function requireChatModels(): ChatModelService {
	if (!chatModels) throw new Error("Chat runtime not started");
	return chatModels;
}

function notifyChatSettingsChanged(): void {
	// Keys and providers change the web tools; sync is a no-op unless availability flipped.
	if (chatModels && generalSettings) void syncWebTools().catch((error) => appLog(`Failed to sync web tools: ${logErrorText(error)}`));
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(IPC.chatSettingsChanged);
	}
}

/** One pending prompt at a time; a login flow stays inside a single renderer request. */
const loginPromptState = {
	pending: undefined as ((value: string) => void) | undefined,
	reject: undefined as ((reason: Error) => void) | undefined,
	signal: undefined as AbortController | undefined,
};

function askLoginPrompt(window: Electron.BrowserWindow | undefined, providerId: string, type: "api_key" | "oauth", prompt: import("@earendil-works/pi-ai").AuthPrompt & { initialValue?: string }, signal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		loginPromptState.pending = resolve;
		loginPromptState.reject = reject;
		const abort = () => { loginPromptState.pending = undefined; loginPromptState.reject = undefined; reject(new Error("Login canceled")); };
		if (signal) signal.addEventListener("abort", abort, { once: true });
		const target = window ?? BrowserWindow.getAllWindows()[0];
		if (!target || target.isDestroyed()) { abort(); return; }
		target.webContents.send(IPC.chatLoginPrompt, { ...prompt, providerId, authType: type });
	});
}

function registerChatIpc(): void {
	ipcMain.handle(IPC.getChatSettings, async () => await requireChatModels().view());
	ipcMain.handle(IPC.saveChatSettings, async (_event, raw: unknown) => settingsWrites.run(async () => {
		const service = requireChatModels();
		await service.save(raw as Parameters<ChatModelService["save"]>[0]);
		notifyChatSettingsChanged();
		return service.view();
	}));
	ipcMain.handle(IPC.patchChatSettings, async (_event, raw: unknown) => settingsWrites.run(async () => {
		const service = requireChatModels();
		await applyChatSettingsPatch(service, parseChatSettingsPatch(raw));
		notifyChatSettingsChanged();
		return service.view();
	}));
	ipcMain.handle(IPC.chatProviderCatalog, (): import("../shared/ipc.ts").ChatProviderCatalogEntry[] =>
		builtinProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			apiKeyAuth: !!provider.auth.apiKey?.login,
			oauthAuth: !!provider.auth.oauth,
		})),
	);
	ipcMain.handle(IPC.chatLogin, async (event, providerId: string, type: "api_key" | "oauth") => {
		if (typeof providerId !== "string" || (type !== "api_key" && type !== "oauth")) throw new Error("Invalid login request");
		const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const controller = new AbortController();
		loginPromptState.signal?.abort();
		loginPromptState.signal = controller;
		const notify = (value: import("@earendil-works/pi-ai").AuthEvent): void => {
			const target = window ?? BrowserWindow.getAllWindows()[0];
			if (!target || target.isDestroyed()) return;
			target.webContents.send(IPC.chatLoginPrompt, { ...value, providerId, authType: type });
		};
		try {
			await requireChatModels().login(providerId, type, {
				signal: controller.signal,
				prompt: (prompt) => askLoginPrompt(window, providerId, type, prompt, controller.signal),
				notify,
			}, { signal: controller.signal });
			notifyChatSettingsChanged();
		} finally {
			loginPromptState.pending = undefined;
			loginPromptState.reject = undefined;
			if (loginPromptState.signal === controller) loginPromptState.signal = undefined;
		}
	});
	ipcMain.handle(IPC.chatLoginResponse, async (_event, value: unknown) => {
		if (typeof value !== "string") throw new Error("Login answer must be text");
		const resolve = loginPromptState.pending;
		if (!resolve) throw new Error("No login prompt is waiting");
		loginPromptState.pending = undefined;
		loginPromptState.reject = undefined;
		resolve(value);
	});
	ipcMain.handle(IPC.chatLogout, async (_event, providerId: unknown) => {
		if (typeof providerId !== "string") throw new Error("Invalid logout request");
		await requireChatModels().logout(providerId);
		notifyChatSettingsChanged();
	});
	ipcMain.handle(IPC.chatCancelLogin, async () => {
		const reject = loginPromptState.reject;
		loginPromptState.pending = undefined;
		loginPromptState.reject = undefined;
		loginPromptState.signal?.abort();
		loginPromptState.signal = undefined;
		reject?.(new Error("Login canceled"));
	});
	ipcMain.handle(IPC.chatRefresh, async () => {
		const service = requireChatModels();
		await service.refresh({ allowNetwork: true });
		notifyChatSettingsChanged();
		return service.view();
	});
}

function registerIpc(): void {
	ipcMain.handle(IPC.getAgentEndpoint, (): AgentEndpoint => {
		if (!agentServer) throw new Error("Agent server not started");
		return { runtimeUrl: agentServer.runtimeUrl, agentId: agentServer.agentId };
	});

	ipcMain.handle(IPC.isFullscreen, (event): boolean => {
		return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
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
		async (event, assetId: string, canPaste: boolean, single: boolean): Promise<AssetContextAction | null> => {
			if (!(await localCore.getAssetFilePath(assetId))) throw new Error("Asset not found");
			const favorite = (await localCore.getLibrarySnapshot()).favoriteAssetIds.includes(assetId);
			const { t, platform } = await uiCopy();
			return popupContextMenu<AssetContextAction>(event, [
				{ label: t.menu.openInNewTab, click: () => "open_in_new_tab" },
				{ label: t.menu.addToChat, click: () => "add_to_chat" },
				{
					label: favorite ? t.menu.removeFromFavorites : t.menu.addToFavorites,
					click: () => favorite ? "unfavorite" : "favorite",
				},
				{ type: "separator" },
				{ label: t.menu.newFolder, click: () => "new_folder" },
				{ type: "separator" },
				{ label: t.menu.rename, enabled: single, click: () => "rename" },
				{ label: t.menu.duplicate, click: () => "duplicate" },
				{ label: t.menu.cut, click: () => "cut" },
				{ label: t.common.copy, click: () => "copy" },
				{ label: t.menu.paste, enabled: canPaste || await clipboardHasFiles(), click: () => "paste" },
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
		async (event, relativePath: string, canPaste: boolean, single: boolean): Promise<FolderContextAction | null> => {
			localCore.getFolderFilePath(relativePath);
			const { t, platform } = await uiCopy();
			return popupContextMenu<FolderContextAction>(event, [
				{ label: t.menu.newFolder, click: () => "new_folder" },
				{ type: "separator" },
				{ label: t.menu.rename, enabled: single, click: () => "rename" },
				{ label: t.menu.cut, click: () => "cut" },
				{ label: t.common.copy, click: () => "copy" },
				{ label: t.menu.paste, enabled: canPaste || await clipboardHasFiles(), click: () => "paste" },
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
				{ label: t.menu.paste, enabled: canPaste || await clipboardHasFiles(), click: () => "paste" },
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

	ipcMain.handle(IPC.readFileClipboard, () => readFileClipboard());

	ipcMain.handle(IPC.placePathsInto, async (_event, absolutePaths: string[], destFolder: string, move: boolean) => {
		const placed = await localCore.placePathsInto(absolutePaths, destFolder, move);
		if (move) {
			try {
				clipboard.clear();
			} catch {
				// The files are already in the library. A second paste skips paths that are gone.
			}
		}
		return placed;
	});

	ipcMain.handle(IPC.copyLibraryPaths, async (_event, assetIds: string[], folders: string[]): Promise<void> => {
		const lines: string[] = [];
		for (const folder of folders) lines.push(localCore.getFolderFilePath(folder));
		for (const assetId of assetIds) {
			const filePath = await localCore.getAssetFilePath(assetId);
			if (filePath) lines.push(filePath);
		}
		clipboard.writeText(lines.join("\n"));
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
	ipcMain.handle(IPC.getTextEmbedStatus, (_event, assetId: string) => localCore.runLibraryTask(async (signal) => {
		const modelId = modelSettings ? (await modelSettings.load()).embedding.model.trim() : "";
		signal.throwIfAborted();
		return localCore.getTextEmbedStatus(assetId, modelId || undefined);
	}));
	ipcMain.handle(IPC.embedAsset, (_event, assetId: string, force?: boolean) => embedAssetWithSettings(assetId, undefined, { force: force === true }));
	ipcMain.handle(IPC.getImageVlmStatus, (_event, assetId: string) => localCore.runLibraryTask(async (signal) => {
		const modelId = modelSettings ? (await modelSettings.load()).vlm.model.trim() : "";
		signal.throwIfAborted();
		return localCore.getImageVlmStatus(assetId, modelId || undefined);
	}));
	ipcMain.handle(IPC.describeImage, (_event, assetId: string) => describeThenIndex(assetId, () => describeImageWithSettings(assetId, undefined, { force: true })));
	ipcMain.handle(IPC.getVideoVlmStatus, (_event, assetId: string) => localCore.runLibraryTask(async (signal) => {
		const modelId = modelSettings ? (await modelSettings.load()).vlm.model.trim() : "";
		signal.throwIfAborted();
		return localCore.getVideoVlmStatus(assetId, modelId || undefined);
	}));
	ipcMain.handle(IPC.describeVideo, (_event, assetId: string) => describeThenIndex(assetId, () => describeVideoWithSettings(assetId, undefined, { force: true })));
	ipcMain.handle(IPC.getAudioWriteupStatus, (_event, assetId: string) => localCore.runLibraryTask(async (signal) => {
		const modelId = modelSettings ? (await modelSettings.load()).audio.model.trim() : "";
		signal.throwIfAborted();
		return localCore.getAudioWriteupStatus(assetId, modelId || undefined);
	}));
	ipcMain.handle(IPC.describeAudio, (_event, assetId: string) => describeThenIndex(assetId, () => describeAudioWithSettings(assetId, undefined, { force: true })));
	ipcMain.handle(IPC.listSessions, () => requireChat().listSessions());
	ipcMain.handle(IPC.createSession, async () => {
		return chatRecord(await requireChat().createSession());
	});
	ipcMain.handle(IPC.openSession, async (_event, id: string) => chatRecord(await requireChat().openSession(id)));
	ipcMain.handle(IPC.getSession, async (_event, id: string, afterEntryId?: string) => chatRecord(await requireChat().getSession(id, afterEntryId)));
	ipcMain.handle(IPC.stageComposerAssets, async (_event, id: string, assets: unknown) => {
		if (typeof id !== "string" || !id.trim()) throw new Error("Session is missing");
		await stageComposerInput(id, assets, (assetId) => localCore.getAssetFilePath(assetId));
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
	ipcMain.handle(IPC.importComposerFiles, async (_event, filePaths: unknown, images: unknown): Promise<UiSelectionDraft[]> => {
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		return draftsFromAssets(await importComposerFiles(filePaths, images, (paths) => localCore.importExternalFiles(paths)));
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
	ipcMain.handle(IPC.followUp, (_event, id: string, text: string, clientMessageId?: string) => requireChat().followUp(id, text, clientMessageId));
	ipcMain.handle(IPC.cancelFollowUp, (_event, id: string, clientMessageId: string) => requireChat().cancelFollowUp(id, clientMessageId));
	ipcMain.handle(IPC.branchBefore, async (_event, id: string, entryId: string, raw: unknown) => {
		const model = raw === undefined ? undefined : requireChatModels().validateSelection(raw);
		return chatRecord(await requireChat().branchBefore(id, entryId, model));
	});
	ipcMain.handle(IPC.setSessionModel, async (_event, id: string, raw: unknown) => {
		if (typeof id !== "string") throw new Error("Invalid conversation ID");
		const service = requireChatModels();
		const selection = service.validateSelection(raw);
		const record = await requireChat().setSessionModel(id, selection);
		await service.rememberSelection(selection);
		notifyChatSettingsChanged();
		return chatRecord(record);
	});
	ipcMain.handle(IPC.forkBefore, async (_event, id: string, entryId: string) => chatRecord(await requireChat().forkBefore(id, entryId)));
	ipcMain.handle(IPC.archiveSession, (_event, id: string) => requireChat().archiveSession(id));
	ipcMain.handle(IPC.unarchiveSession, (_event, id: string) => requireChat().unarchiveSession(id));
	ipcMain.handle(IPC.getModelSettings, async () => {
		if (!modelSettings) throw new Error("Settings store not started");
		return modelSettings.view();
	});
	ipcMain.handle(IPC.getMcpSettings, async () => mcpSettingsView());
	ipcMain.handle(IPC.saveMcpSettings, async (_event, patch: McpSettingsPatch) => settingsWrites.run(async () => {
		if (!mcpSettings) throw new Error("Settings store not started");
		const configs = await mcpSettings.patch(patch);
		await reconnectMcp(configs);
		return mcpSettingsView();
	}));
	ipcMain.handle(IPC.setMcpServerLive, async (_event, draft: McpServerDraft) => settingsWrites.run(async () => {
		return setMcpServerLive(draft);
	}));
	ipcMain.handle(IPC.probeModelSlot, async (_event, draft: ModelProbeDraft) => {
		return probeModelSlot(draft);
	});
	ipcMain.handle(IPC.getAgentInstructions, async () => {
		if (!agentInstructions) throw new Error("Settings store not started");
		return agentInstructions.load();
	});
	ipcMain.handle(IPC.saveAgentInstructions, async (_event, text: unknown) => settingsWrites.run(async () => {
		if (!agentInstructions) throw new Error("Settings store not started");
		if (typeof text !== "string") throw new Error("Instructions must be text.");
		const saved = await agentInstructions.save(text);
		await requireChat().setInstructions(saved);
		return saved;
	}));
	ipcMain.handle(IPC.getGeneralSettings, async () => {
		if (!generalSettings) throw new Error("Settings store not started");
		return generalSettings.load();
	});
	ipcMain.handle(IPC.saveGeneralSettings, async (_event, raw: unknown) => settingsWrites.run(async () => {
		if (!generalSettings) throw new Error("Settings store not started");
		const saved = await generalSettings.save(parseGeneralSettingsPatch(raw));
		await syncWebTools().catch((error) => appLog(`Failed to sync web tools: ${logErrorText(error)}`));
		return saved;
	}));
	ipcMain.handle(IPC.getProcessSandboxNotice, async () => {
		if (!agentSandbox) throw new Error("Settings store not started");
		return agentSandbox.pendingNotice();
	});
	ipcMain.handle(IPC.acknowledgeProcessSandboxNotice, async (_event, id: unknown) => {
		if (!agentSandbox) throw new Error("Settings store not started");
		if (typeof id !== "string") throw new Error("Sandbox notice ID must be text.");
		await agentSandbox.acknowledgeNotice(id);
	});
	ipcMain.handle(IPC.getAgentSandbox, async () => {
		if (!agentSandbox) throw new Error("Settings store not started");
		return agentSandbox.load();
	});
	ipcMain.handle(IPC.saveAgentSandbox, async (_event, enabled: unknown) => settingsWrites.run(async () => {
		if (!agentSandbox) throw new Error("Settings store not started");
		if (typeof enabled !== "boolean") throw new Error("Sandbox setting must be on or off.");
		const saved = await agentSandbox.save(enabled);
		await applyProcessSandbox();
		return saved;
	}));
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
	ipcMain.handle(IPC.getAgentPermission, (): string => requireChat().getPermissionLevel());
	ipcMain.handle(IPC.setAgentPermission, async (_event, raw: unknown) => settingsWrites.run(async () => {
		if (!agentPermission) throw new Error("Permission store not started");
		const level = await agentPermission.save(parseAgentPermissionLevel(raw));
		requireChat().setPermissionLevel(level);
		await applyProcessSandbox();
		return level;
	}));
	ipcMain.handle(IPC.getCommandAllows, () => {
		if (!commandAllows) throw new Error("Permission store not started");
		return commandAllows.view();
	});
	ipcMain.handle(IPC.resolveToolGate, async (_event, toolCallId: unknown, decision: unknown) => {
		if (typeof toolCallId !== "string" || !toolCallId.trim()) throw new Error("Tool call is missing");
		if (decision !== "approve" && decision !== "reject" && decision !== "approve_always") throw new Error("Tool decision is invalid");
		if (decision === "approve_always") {
			if (!commandAllows) throw new Error("Permission store not started");
			const allow = requireChat().pendingCommandAllow(toolCallId);
			if (!allow) throw new Error("This command cannot be remembered.");
			const view = await commandAllows.add(allow);
			requireChat().setCommandAllows(view.allows);
			const resolved = requireChat().resolveToolGate(toolCallId, "approve");
			notifyCommandAllows(view);
			return resolved;
		}
		return requireChat().resolveToolGate(toolCallId, decision);
	});
	ipcMain.handle(IPC.previewImageGrade, async (_event, assetId: unknown, grade: unknown, lut: unknown, force: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		gradePreview?.abort();
		const controller = new AbortController();
		gradePreview = controller;
		try {
			return await localCore.previewImageGrade(
				assetId,
				grade,
				typeof lut === "string" && lut.trim() ? lut : undefined,
				force === true,
				controller.signal,
			);
		} catch (error) {
			if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return null;
			throw error;
		}
	});
	ipcMain.handle(IPC.saveImageGrade, async (_event, assetId: unknown, grade: unknown, lut: unknown, output: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		const source = await localCore.getAsset(assetId);
		if (!source) throw new Error("Asset not found");
		const chosen = typeof output === "string" && output.trim() ? await gradeOutputPath(output, source.relativePath, false) : undefined;
		const result = await localCore.gradeImage({
			path: source.relativePath,
			grade,
			lut: typeof lut === "string" && lut.trim() ? lut : undefined,
			output: chosen,
			beside: !chosen,
		});
		if (result.sourceAssetId && result.sourceAssetId !== result.assetId) {
			await localCore.createRelation(result.assetId, result.sourceAssetId, "derived from");
		}
		return { assetId: result.assetId, path: result.output };
	});
	ipcMain.handle(IPC.getVideoGradeInfo, async (_event, assetId: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		return localCore.getVideoGradeInfo(assetId);
	});
	ipcMain.handle(IPC.previewVideoGrade, async (_event, assetId: unknown, timeSeconds: unknown, grade: unknown, lut: unknown, force: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		if (typeof timeSeconds !== "number" || !Number.isFinite(timeSeconds)) throw new Error("Time is missing");
		gradePreview?.abort();
		const controller = new AbortController();
		gradePreview = controller;
		try {
			return await localCore.previewVideoGrade(
				assetId,
				timeSeconds,
				grade,
				typeof lut === "string" && lut.trim() ? lut : undefined,
				force === true,
				controller.signal,
			);
		} catch (error) {
			if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return null;
			throw error;
		}
	});
	ipcMain.handle(IPC.saveVideoGrade, async (_event, assetId: unknown, grade: unknown, lut: unknown, output: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		const source = await localCore.getAsset(assetId);
		if (!source) throw new Error("Asset not found");
		const chosen = typeof output === "string" && output.trim() ? await gradeOutputPath(output, source.relativePath, true) : undefined;
		const result = await localCore.gradeVideo({
			path: source.relativePath,
			grade,
			lut: typeof lut === "string" && lut.trim() ? lut : undefined,
			output: chosen,
			beside: !chosen,
		});
		if (result.sourceAssetId && result.sourceAssetId !== result.assetId) {
			await localCore.createRelation(result.assetId, result.sourceAssetId, "derived from");
		}
		return { assetId: result.assetId, path: result.output };
	});
	ipcMain.handle(IPC.pickGradeOutput, async (event, assetId: unknown) => {
		if (typeof assetId !== "string" || !assetId.trim()) throw new Error("Asset is missing");
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		const source = await localCore.getAsset(assetId);
		if (!source) throw new Error("Asset not found");
		const video = isGradeableVideo(source.relativePath);
		const suggested = freeGradeSibling(snapshot.rootPath, source.relativePath, video);
		const owner = BrowserWindow.fromWebContents(event.sender);
		const { t } = await uiCopy();
		const options = {
			title: t.grade.saveAs,
			defaultPath: join(snapshot.rootPath, ...suggested.split("/")),
			buttonLabel: t.common.save,
			filters: video ? videoGradeSaveFilters() : gradeSaveFilters(extname(suggested).slice(1)),
			properties: ["createDirectory", "showOverwriteConfirmation"] as Array<"createDirectory" | "showOverwriteConfirmation">,
		};
		const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) return null;
		return gradeOutputPath(result.filePath, source.relativePath, video);
	});
	ipcMain.handle(IPC.pickGradeLut, async (event) => {
		const snapshot = await localCore.getLibrarySnapshot();
		if (!snapshot.rootPath) throw new Error("Open a library first.");
		const owner = BrowserWindow.fromWebContents(event.sender);
		const { t } = await uiCopy();
		const options = {
			title: t.grade.importLut,
			filters: [{ name: "3D LUT", extensions: ["cube"] }],
			properties: ["openFile"] as Array<"openFile">,
		};
		const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) return null;
		return localCore.importGradeLut(result.filePaths[0]);
	});

	ipcMain.handle(IPC.saveModelSettings, async (_event, draft: ModelSettingsPatch) => settingsWrites.run(async () => {
		if (!modelSettings) throw new Error("Settings store not started");
		const file = await modelSettings.update(draft);
		return settingsView(file);
	}));

	ipcMain.handle(IPC.deleteSession, (_event, id: string) => requireChat().deleteSession(id));

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
		if (!event.sender.isDestroyed()) event.sender.send(IPC.trashStarted);

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
		if (!event.sender.isDestroyed()) event.sender.send(IPC.trashStarted);

		await shell.trashItem(folderPath);
		await localCore.forgetFolder(relativePath);
		return true;
	});

	ipcMain.handle(IPC.trashLibraryItems, async (event, assetIds: string[], folders: string[]): Promise<boolean> => {
		const count = assetIds.length + folders.length;
		if (count === 0) return false;
		const owner = BrowserWindow.fromWebContents(event.sender);
		const { t, platform } = await uiCopy();
		const options = {
			type: "warning" as const,
			buttons: [t.common.cancel, t.menu.moveToTrash(platform)],
			defaultId: 0,
			cancelId: 0,
			message: t.menu.trashItems(count, platform),
			detail: t.menu.trashItemsDetail(platform),
		};
		const result = owner
			? await dialog.showMessageBox(owner, options)
			: await dialog.showMessageBox(options);
		if (result.response !== 1) return false;
		if (!event.sender.isDestroyed()) event.sender.send(IPC.trashStarted);
		for (const relativePath of folders) {
			await shell.trashItem(localCore.getFolderFilePath(relativePath));
			await localCore.forgetFolder(relativePath);
		}
		for (const assetId of assetIds) {
			const filePath = await localCore.getAssetFilePath(assetId);
			if (!filePath) continue;
			await shell.trashItem(filePath);
			await localCore.forgetAsset(assetId);
		}
		return true;
	});

	localCore.subscribeLibrary((change: LibraryChange) => {
		if (openingLibrary) pendingLibraryChanges.push(change);
		else sendLibraryChange(change);
	});
	requireChat().subscribeSessions((sessions) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send(IPC.sessionsChanged, sessions);
		}
	});
}

app
	.whenReady()
	.then(async () => {
		const logDirectory = appLogDirectory();
		writeAppLog = (message) => appendAppLog(logDirectory, message);
		process.on("uncaughtException", (error) => appLog(`uncaught exception: ${logErrorText(error)}`));
		process.on("unhandledRejection", (reason) => appLog(`unhandled rejection: ${logErrorText(reason)}`));
		logMediaBinaries();
		void sweepStaleTemp();
		applyAppIcon();
		// Development convenience: keep provider secrets in the workspace root.
		// Production will source credentials from settings/keychain instead.
		if (!app.isPackaged) {
			const envFile = resolve(app.getAppPath(), "../../.env");
			if (existsSync(envFile)) process.loadEnvFile(envFile);
		}

		modelSettings = new ModelSettingsStore(join(app.getPath("userData"), "model-settings.json"));
		const chatStores = createChatStorage(app.getPath("userData"));
		const deviceId = new DeviceIdStore(join(app.getPath("userData"), "device-id.json"));
		chatModels = new ChatModelService(chatStores, { deviceId: () => deviceId.get(), withIdleProviders: (ids, operation) => requireChat().withIdleChatProviders(ids, operation) });
		chat = new ChatService({ ...AGENT_OPTIONS, models: chatModels.models, chatDefault: () => requireChatModels().selectionForNewSession(), composer: {
			getSelection: getUiSelection,
			takeImages: takeComposerImages,
			takeAssets: takeLiveComposerAssets,
		} }, (usage) => { void agentStats?.record(usage); });
		await chatModels.initialize(process.env);
		chatModels.onSecrets((values) => requireChat().setChatSecrets(values));
		agentStats = new AgentStatsStore(join(app.getPath("userData"), "agent-stats.json"));
		lastLibrary = new LastLibraryStore(join(app.getPath("userData"), "last-library.json"));
		generalSettings = new GeneralSettingsStore(join(app.getPath("userData"), "general.json"));
		agentPermission = new AgentPermissionStore(join(app.getPath("userData"), "agent-permission.json"));
		commandAllows = new CommandAllowStore();
		requireChat().setPermissionLevel(await agentPermission.load());
		agentInstructions = new AgentInstructionsStore(join(app.getPath("userData"), "AGENTS.md"));
		await requireChat().setInstructions(await agentInstructions.load());
		agentSandbox = new AgentSandboxStore(join(app.getPath("userData"), "agent-sandbox.json"));
		setProcessSandboxFailureHandler(async (reason) => {
			const store = agentSandbox!;
			let message = reason.message;
			try {
				// Retain the notice before broadcasting: restore/recovery may run
				// before any window exists or its renderer has subscribed.
				await store.recordFailure(message);
			} catch (error) {
				message += ` Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`;
			}
			appLog(`Windows sandbox disabled: ${message}`);
			const notice = await store.pendingNotice();
			notifySettingsChanged();
			if (notice) for (const window of BrowserWindow.getAllWindows()) {
				if (!window.isDestroyed()) window.webContents.send(IPC.processSandboxDisabled, { ...notice, reason: message });
			}
		});
		await applyProcessSandbox();
		mcpSettings = new McpSettingsStore(mcpConfigPath());
		mcpHost = new McpHost();
		if (import.meta.env.DEV || (process.env.LOOM_E2E === "1" && process.env.LOOM_E2E_TRACE === "1")) {
			const devTrace = await import("./dev-trace-window.ts");
			requireChat().setTracePublisher(devTrace.publishDevTrace);
			devTrace.registerDevTraceIpc(join(import.meta.dirname, "../preload/dev-trace.mjs"), (limit, before) => requireChat().listTraces(limit, before));
		}
		agentServer = await startAgentServer(requireChat());
		registerAssetProtocol();
		registerIpc();
		registerChatIpc();
		await restoreLastLibrary();
		createWindow();
		void attachConfiguredMcp().finally(() => syncWebTools().catch((error) => appLog(`Failed to sync web tools: ${logErrorText(error)}`)));

		app.on("activate", () => {
			const hasMain = BrowserWindow.getAllWindows().some((window) => window.getTitle() !== "Traces");
			if (!hasMain) createWindow();
		});
	})
	.catch((error) => {
		appLog(`Failed to start Loom: ${logErrorText(error)}`);
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
	void localCore.stopLibraryTasks().then(() => libraryTransition).then(() => Promise.allSettled([
		server?.close() ?? Promise.resolve(),
		requireChat().close(),
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

async function embedAssetWithSettings(assetId: string, signal?: AbortSignal, options?: EmbedOptions) {
	if (openingLibrary || shutdownStarted) throw new Error("Library is changing or closing");
	return localCore.runLibraryTask(async (jobSignal) => {
		const provider = await embeddingProviderFromSettings();
		if (!provider) throw new Error("Enable the Embedding slot in Settings first.");
		jobSignal.throwIfAborted();
		return localCore.embedTextAsset(assetId, provider, jobSignal, options);
	}, signal);
}

async function embeddingProviderFromSettings(): Promise<EmbeddingProvider | undefined> {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).embedding;
	if (!slot.enabled || !slot.requestUrl.trim() || !slot.model.trim()) return undefined;
	return createHttpEmbeddingProvider(slot);
}

async function rerankProviderFromSettings(): Promise<RerankProvider | undefined> {
	if (!modelSettings) throw new Error("Settings store not started");
	const slot = (await modelSettings.load()).rerank;
	if (!slot.enabled || !slot.requestUrl.trim() || !slot.model.trim()) return undefined;
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
		// Cancel Core jobs before awaiting tool shutdown, while storage still belongs to the old root.
		await localCore.stopLibraryTasks();
		await requireChat().close();
		const snapshot = await localCore.openLibrary(rootPath);
		if (snapshot.rootPath) {
			requireChat().setSystemPrompt(systemPromptForLibrary(snapshot.rootPath));
			await requireChat().openLibrary(snapshot.rootPath);
			await lastLibrary?.remember(snapshot.rootPath);
			await bindCommandAllows(snapshot.rootPath);
		} else {
			await bindCommandAllows(null);
		}
		setUiSelection(null);
		return snapshot;
	} catch (error) {
		appLog(`Failed to open library: ${logErrorText(error)}`);
		await requireChat().close();
		await bindCommandAllows(null);
		throw error;
	} finally {
		const vecNote = localCore.sqliteVecNote();
		if (vecNote) appLog(vecNote);
		openingLibrary = false;
		const reset = pendingLibraryChanges.findLastIndex((change) => change.type === "reset");
		const changes = reset < 0 ? [] : pendingLibraryChanges.slice(reset);
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

/**
 * The Details button always asks the model again (the renderer confirms first when a fresh
 * description exists) and then indexes, in one step. Agent tools keep calling the
 * single-step functions. An unusable Embedding slot only skips indexing; it never fails the description.
 */
async function describeThenIndex<T extends { status: string }>(assetId: string, describe: () => Promise<T>): Promise<T> {
	const status = await describe();
	if (status.status !== "ready" || openingLibrary || shutdownStarted) return status;
	try {
		if (await embeddingProviderFromSettings()) await embedAssetWithSettings(assetId);
	} catch (error) {
		appLog(`Indexing after describe failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return status;
}

async function describeImageWithSettings(assetId: string, signal?: AbortSignal, options?: DescribeOptions) {
	if (openingLibrary || shutdownStarted) throw new Error("Library is changing or closing");
	return localCore.runLibraryTask(async (jobSignal) => {
		if (!modelSettings) throw new Error("Settings store not started");
		const slot = (await modelSettings.load()).vlm;
		if (!slot.enabled || !slot.requestUrl.trim() || !slot.model.trim()) {
			throw new Error("Enable the VLM slot in Settings first.");
		}
		jobSignal.throwIfAborted();
		return localCore.describeImageAsset(assetId, createHttpVlmProvider(slot), jobSignal, options);
	}, signal);
}

async function describeVideoWithSettings(assetId: string, signal?: AbortSignal, options?: DescribeOptions) {
	if (openingLibrary || shutdownStarted) throw new Error("Library is changing or closing");
	return localCore.runLibraryTask(async (jobSignal) => {
		if (!modelSettings) throw new Error("Settings store not started");
		const slot = (await modelSettings.load()).vlm;
		if (!slot.enabled || !slot.requestUrl.trim() || !slot.model.trim()) {
			throw new Error("Enable the VLM slot in Settings first.");
		}
		jobSignal.throwIfAborted();
		return localCore.describeVideoAsset(assetId, createHttpVideoVlmProvider(slot), jobSignal, options);
	}, signal);
}

async function describeAudioWithSettings(assetId: string, signal?: AbortSignal, options?: DescribeOptions) {
	if (openingLibrary || shutdownStarted) throw new Error("Library is changing or closing");
	return localCore.runLibraryTask(async (jobSignal) => {
		if (!modelSettings) throw new Error("Settings store not started");
		const slot = (await modelSettings.load()).audio;
		if (!slot.enabled || !slot.requestUrl.trim() || !slot.model.trim()) {
			throw new Error("Enable the Audio slot in Settings first.");
		}
		jobSignal.throwIfAborted();
		return localCore.describeAudioAsset(assetId, createHttpAudioProvider(slot), jobSignal, options);
	}, signal);
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

/** Replace registry tools without reopening the library or interrupting durable work. */
async function syncAgentTools(): Promise<void> {
	await requireChat().setTools([...BUILTIN_TOOLS, ...(await webTools.tools()), ...(mcpHost?.allTools() ?? [])]);
}

const webTools = new WebToolsService({
	enabled: async () => generalSettings ? (await generalSettings.load()).webTools : false,
	apiKey: (chatProviderId, signal) => requireChatModels().providerApiKey(chatProviderId, signal),
});

/** Re-register tools only when the web vendor just appeared, changed, or went away, so unrelated edits keep the prompt cache. */
async function syncWebTools(): Promise<void> {
	if (await webTools.changed()) await syncAgentTools();
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
): Promise<void> {
	const previous = mcpHost;
	mcpHost = new McpHost();
	await mcpHost.connect(configs);
	if (shutdownStarted || !mcpHost) return;
	await syncAgentTools();
	if (previous) await previous.close();
}

async function bindCommandAllows(root: string | null): Promise<void> {
	if (!commandAllows) return;
	const view = await commandAllows.bind(root);
	requireChat().setCommandAllows(view.allows);
	notifyCommandAllows(view);
}

function notifyCommandAllows(view: CommandAllowView): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(IPC.commandAllowsChanged, view);
	}
}

function notifySettingsChanged(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(IPC.settingsChanged);
	}
}

async function readPublicSettings(chatProvider?: string): Promise<PublicSettings> {
	if (!modelSettings || !mcpSettings || !agentSandbox || !agentInstructions || !generalSettings) throw new Error("Settings store not started");
	const [models, servers, sandbox, instructions, general, chat] = await Promise.all([
		modelSettings.load(),
		mcpSettings.drafts(),
		agentSandbox.load(),
		agentInstructions.load(),
		generalSettings.load(),
		publicChatSettings(requireChatModels(), chatProvider),
	]);
	const slots = {} as PublicSettings["models"];
	for (const id of Object.keys(models) as Array<keyof typeof models>) slots[id] = publicModelSlot(models[id]);
	return { language: general.language, chat, models: slots, sandbox, instructions, mcp: servers.map(publicMcpServer) };
}

async function applySettingsPatch(patch: SettingsPatch): Promise<{ notes: string[]; settings: PublicSettings }> {
	return settingsWrites.run(async () => {
		if (!modelSettings || !mcpSettings || !agentSandbox || !agentInstructions) throw new Error("Settings store not started");
		const notes: string[] = [];
		if (patch.language !== undefined) {
			if (!generalSettings) throw new Error("Settings store not started");
			await generalSettings.save({ language: patch.language });
			notes.push("Interface language saved.");
			notifySettingsChanged();
		}
		if (patch.chat) {
			const service = requireChatModels();
			try { notes.push(...await applyChatSettingsPatch(service, patch.chat)); }
			finally {
				notifyChatSettingsChanged();
			}
		}
		if (patch.models) {
			const before = await modelSettings.load();
			const file = await modelSettings.update(patch.models);
			notes.push(...modelChangeNotes(before, file));
		}
		if (patch.sandbox !== undefined) {
			await agentSandbox.save(patch.sandbox);
			await applyProcessSandbox();
			notes.push(patch.sandbox ? "Process sandbox is on. The next command uses it." : "Process sandbox is off. The next command runs directly.");
		}
		if (patch.instructions !== undefined) {
			const saved = await agentInstructions.save(patch.instructions);
			await requireChat().setInstructions(saved);
			notes.push("Instructions saved. This reply keeps the text it started with. The next message appends the new text.");
		}
		if (patch.mcp) {
			const configs = await mcpSettings.update((current) => mergeMcpServers(current, patch.mcp!));
			await reconnectMcp(configs);
			notes.push("MCP servers saved and reconnected.");
		}
		notifySettingsChanged();
		return { notes, settings: await readPublicSettings() };
	});
}

async function gradeOutputPath(input: string, sourceRelativePath: string, video: boolean): Promise<string> {
	const snapshot = await localCore.getLibrarySnapshot();
	if (!snapshot.rootPath) throw new Error("Open a library first.");
	const { t } = await uiCopy();
	let absolute = isAbsolute(input) ? input : resolve(snapshot.rootPath, ...input.replaceAll("\\", "/").split("/"));
	if (!extname(absolute)) {
		absolute += extname(video ? gradeVideoSiblingRelative(sourceRelativePath) : gradeSiblingRelative(sourceRelativePath));
	}
	const relativePath = containedLibraryPath(snapshot.rootPath, absolute);
	if (!relativePath) throw new Error(t.grade.saveOutside);
	if (video ? !isGradeVideoExportPath(relativePath) : !isGradeExportPath(relativePath)) {
		throw new Error(video ? t.grade.saveVideoType : t.grade.saveType);
	}
	if (relativePath === sourceRelativePath) throw new Error(t.grade.saveOriginal);
	await assertNotSourceFile(snapshot.rootPath, relativePath, sourceRelativePath, t.grade.saveOriginal);
	return relativePath;
}

async function assertNotSourceFile(root: string, relativePath: string, sourceRelativePath: string, message: string): Promise<void> {
	try {
		const [chosen, source] = await Promise.all([
			stat(join(root, ...relativePath.split("/"))),
			stat(join(root, ...sourceRelativePath.split("/"))),
		]);
		if (chosen.ino === source.ino && chosen.dev === source.dev) throw new Error(message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function freeGradeSibling(root: string, sourceRelativePath: string, video = false): string {
	for (let copy = 1; copy < 1000; copy += 1) {
		const relativePath = video ? gradeVideoSiblingRelative(sourceRelativePath, copy) : gradeSiblingRelative(sourceRelativePath, copy);
		if (!existsSync(join(root, ...relativePath.split("/")))) return relativePath;
	}
	return gradeSiblingRelative(sourceRelativePath, 999);
}

function containedLibraryPath(root: string, absolutePath: string): string | null {
	const value = relative(root, resolve(absolutePath));
	if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return null;
	const posix = value.split(sep).join("/");
	if (posix === ".loom" || posix.startsWith(".loom/") || basename(posix) === ".DS_Store") {
		return null;
	}
	return posix;
}

function videoGradeSaveFilters(): Array<{ name: string; extensions: string[] }> {
	return [
		{ name: "MP4", extensions: ["mp4", "m4v"] },
		{ name: "QuickTime", extensions: ["mov"] },
		{ name: "Matroska", extensions: ["mkv"] },
	];
}

function gradeSaveFilters(extension: string): Array<{ name: string; extensions: string[] }> {
	const filters = [
		{ name: "PNG", extensions: ["png"] },
		{ name: "JPEG", extensions: ["jpg", "jpeg"] },
		{ name: "WebP", extensions: ["webp"] },
		{ name: "TIFF", extensions: ["tiff", "tif"] },
		{ name: "BMP", extensions: ["bmp"] },
	];
	const index = filters.findIndex((filter) => filter.extensions.includes(extension.toLowerCase()));
	if (index <= 0) return filters;
	return [filters[index], ...filters.slice(0, index), ...filters.slice(index + 1)];
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


