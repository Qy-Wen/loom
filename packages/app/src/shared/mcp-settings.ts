export type McpTransport = "stdio" | "http";

export type McpServerDraft = {
	id: string;
	transport: McpTransport;
	command: string;
	argsText: string;
	envText: string;
	cwd: string;
	url: string;
	headersText: string;
	enabled: boolean;
};

export type McpServerStatus = {
	id: string;
	tools: string[];
	error?: string;
};

export type McpSettingsView = {
	path: string;
	servers: McpServerDraft[];
	status: McpServerStatus[];
};

export function emptyMcpServerDraft(): McpServerDraft {
	return {
		id: "",
		transport: "stdio",
		command: "",
		argsText: "",
		envText: "",
		cwd: "",
		url: "",
		headersText: "",
		enabled: false,
	};
}

export function linesOf(text: string): string[] {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseEnvText(text: string): Record<string, string> | undefined {
	const mapped: Record<string, string> = {};
	for (const line of linesOf(text)) {
		const cut = line.indexOf("=");
		if (cut <= 0) continue;
		mapped[line.slice(0, cut).trim()] = line.slice(cut + 1);
	}
	return Object.keys(mapped).length ? mapped : undefined;
}

export function envToText(value: Record<string, string> | undefined): string {
	if (!value) return "";
	return Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n");
}

export function draftToRawServer(draft: McpServerDraft): Record<string, unknown> {
	const id = draft.id.trim();
	if (draft.transport === "http") {
		return {
			id,
			url: draft.url.trim(),
			enabled: draft.enabled,
			...(parseEnvText(draft.headersText) ? { headers: parseEnvText(draft.headersText) } : {}),
		};
	}
	const args = linesOf(draft.argsText);
	return {
		id,
		command: draft.command.trim(),
		enabled: draft.enabled,
		...(args.length ? { args } : {}),
		...(parseEnvText(draft.envText) ? { env: parseEnvText(draft.envText) } : {}),
		...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
	};
}

/** Change one server without replacing unrelated servers or fields. */
export interface McpSettingsPatch {
	upsert?: Array<{ previousId?: string; server: Partial<McpServerDraft> & { id: string } }>;
	remove?: string[];
}
