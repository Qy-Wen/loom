/** Typed contract shared by Electron main, preload, and renderer. */
import type { LibraryChange, LibrarySnapshot } from "@loom/core";

export interface AgentEndpoint {
	runtimeUrl: string;
	agentId: string;
}

export const IPC = {
	getAgentEndpoint: "loom:getAgentEndpoint",
	openLibrary: "loom:openLibrary",
	getLibrarySnapshot: "loom:getLibrarySnapshot",
	libraryChanged: "loom:libraryChanged",
} as const;

export interface LoomApi {
	getAgentEndpoint: () => Promise<AgentEndpoint>;
	openLibrary: () => Promise<LibrarySnapshot | null>;
	getLibrarySnapshot: () => Promise<LibrarySnapshot>;
	onLibraryChanged: (listener: (change: LibraryChange) => void) => () => void;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
