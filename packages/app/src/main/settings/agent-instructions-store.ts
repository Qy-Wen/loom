import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { INSTRUCTIONS_CHAR_LIMIT, instructionCharacterCount } from "../../shared/agent-instructions.ts";

export class AgentInstructionsStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<string> {
		try {
			return (await readFile(this.filePath, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	async save(text: string): Promise<string> {
		const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		const count = instructionCharacterCount(normalized);
		if (count > INSTRUCTIONS_CHAR_LIMIT) {
			throw new Error(
				`Instructions are ${count}/${INSTRUCTIONS_CHAR_LIMIT} characters. Shorten them, then save.`,
			);
		}
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, normalized, "utf8");
		return normalized;
	}
}
