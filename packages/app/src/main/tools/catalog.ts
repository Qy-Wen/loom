import type { LocalCore } from "@loom/core";
import { ToolCatalog } from "@loom/agent/tools";
import { createAssetTools, type AssetToolOptions } from "./asset-tools.ts";
import { createFfmpegTools } from "./ffmpeg-tools.ts";
import { createPropertyTools } from "./property-tools.ts";
import { createRelationTools } from "./relation-tools.ts";
import { createTagTools } from "./tag-tools.ts";
import { createSettingsTools, type SettingsToolHost } from "./settings-tools.ts";
import { createLibraryTools } from "./library-tools.ts";
import { CanvasStore } from "../canvas/store.ts";
import { createCanvasTools } from "./canvas-tools.ts";

export function createAppToolCatalog(core: LocalCore, host: { assets: AssetToolOptions; settings: SettingsToolHost }, canvases = new CanvasStore(core)): ToolCatalog {
	const library = [
		...createLibraryTools(core),
		...createCanvasTools(core, canvases),
		...createAssetTools(core, host.assets),
		...createFfmpegTools(core),
		...createRelationTools(core),
		...createPropertyTools(core),
		...createTagTools(core),
	];
	return new ToolCatalog([
		...library.map((tool) => ({ tool, scope: "library" as const, exposure: "external" as const })),
		...createSettingsTools(host.settings).map((tool) => ({ tool, scope: "application" as const, exposure: "external" as const })),
	]);
}
