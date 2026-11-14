import type { LoomTool } from "../types.ts";

export type ToolAudience = "agent" | "external";

export interface ToolDefinition {
	tool: LoomTool;
	scope: "library" | "application";
	/** Undecided tools stay internal until their external contract has been reviewed. */
	exposure: "external" | "internal" | "undecided";
}

/** Application-owned definitions shared by Agent, MCP, and HTTP adapters. */
export class ToolCatalog {
	readonly #definitions = new Map<string, ToolDefinition>();

	constructor(definitions: readonly ToolDefinition[]) {
		for (const definition of definitions) {
			const name = definition.tool.name;
			if (this.#definitions.has(name)) throw new Error(`Duplicate tool: ${name}`);
			this.#definitions.set(name, definition);
		}
	}

	list(audience: ToolAudience): readonly ToolDefinition[] {
		return [...this.#definitions.values()].filter((definition) => audience === "agent" || definition.exposure === "external");
	}

	get(name: string, audience: ToolAudience): ToolDefinition {
		const definition = this.#definitions.get(name);
		if (!definition || (audience === "external" && definition.exposure !== "external")) {
			throw new Error(`Tool is not available: ${name}`);
		}
		return definition;
	}
}
