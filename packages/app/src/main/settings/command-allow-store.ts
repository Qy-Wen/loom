import { atomicWrite, encodeJson, readOptionalFile, withFileLock } from "../storage/file.ts";
import { SerialQueue } from "../storage/serial-queue.ts";
import { LibraryPaths } from "@loom/core/paths";
import {
	commandAllowId,
	parseCommandAllows,
	type CommandAllow,
	type CommandAllowView,
} from "@loom/agent/tool-permission";

/** Remembered commands for one library. The file lives under `<library>/.loom/agents/command-allows/`. */
export class CommandAllowStore {
	private readonly operations = new SerialQueue();
	private root: string | null = null;
	private allows: CommandAllow[] = [];

	bind(root: string | null): Promise<CommandAllowView> {
		return this.operations.run(async () => {
			const allows = root ? await this.read(root) : [];
			this.root = root;
			this.allows = allows;
			return this.view();
		});
	}

	view(): CommandAllowView {
		return {
			allows: this.allows.map((allow) => ({ ...allow })),
			libraryOpen: this.root !== null,
			root: this.root,
		};
	}

	add(allow: CommandAllow): Promise<CommandAllowView> {
		return this.operations.run(async () => {
			if (!this.root) throw new Error("Open a library first.");
			const root = this.root;
			this.allows = await withFileLock(this.filePath(root), async (check) => {
				const allows = await this.read(root);
				if (allows.some((row) => commandAllowId(row) === commandAllowId(allow))) return allows;
				const next = [...allows, { ...allow }];
				await atomicWrite(this.filePath(root), encodeJson({ allows: next }), check);
				return next;
			});
			return this.view();
		});
	}

	private filePath(root: string): string {
		return new LibraryPaths(root).commandAllows;
	}

	private async read(root: string): Promise<CommandAllow[]> {
		try {
			const text = await readOptionalFile(this.filePath(root));
			return text === undefined ? [] : parseCommandAllows(JSON.parse(text));
		} catch (error) {
			if (error instanceof SyntaxError) return [];
			throw error;
		}
	}
}
