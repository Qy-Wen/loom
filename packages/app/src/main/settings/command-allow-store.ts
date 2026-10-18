import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	commandAllowId,
	parseCommandAllows,
	type CommandAllow,
	type CommandAllowView,
} from "@loom/agent/tool-permission";

/** Remembered commands for one library. The file lives in `<library>/.loom/`. */
export class CommandAllowStore {
	private root: string | null = null;
	private allows: CommandAllow[] = [];

	async bind(root: string | null): Promise<CommandAllowView> {
		this.root = root;
		if (!root) {
			this.allows = [];
			return this.view();
		}
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath(root), "utf8"));
			this.allows = parseCommandAllows(parsed);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
			this.allows = [];
		}
		return this.view();
	}

	view(): CommandAllowView {
		return {
			allows: this.allows.map((allow) => ({ ...allow })),
			libraryOpen: this.root !== null,
			root: this.root,
		};
	}

	async add(allow: CommandAllow): Promise<CommandAllowView> {
		const root = this.requireRoot();
		const id = commandAllowId(allow);
		if (!this.allows.some((row) => commandAllowId(row) === id)) {
			this.allows = [...this.allows, { ...allow }];
			await this.write(root);
		}
		return this.view();
	}

	async remove(allow: CommandAllow): Promise<CommandAllowView> {
		const root = this.requireRoot();
		const id = commandAllowId(allow);
		const next = this.allows.filter((row) => commandAllowId(row) !== id);
		if (next.length !== this.allows.length) {
			this.allows = next;
			await this.write(root);
		}
		return this.view();
	}

	private requireRoot(): string {
		if (!this.root) throw new Error("Open a library first.");
		return this.root;
	}

	private filePath(root: string): string {
		return join(root, ".loom", "command-allows.json");
	}

	private async write(root: string): Promise<void> {
		await mkdir(join(root, ".loom"), { recursive: true });
		await writeFile(this.filePath(root), `${JSON.stringify({ allows: this.allows }, null, "\t")}\n`, "utf8");
	}
}
