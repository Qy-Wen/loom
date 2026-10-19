import { atomicWrite, withFileLock, readOptionalFile } from "../storage/file.ts";
import { INSTRUCTIONS_CHAR_LIMIT, instructionCharacterCount } from "../../shared/agent-instructions.ts";

export class AgentInstructionsStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<string> {
		return ((await readOptionalFile(this.filePath)) ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	}

	async save(text: string): Promise<string> {
		const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		const count = instructionCharacterCount(normalized);
		if (count > INSTRUCTIONS_CHAR_LIMIT) {
			throw new Error(
				`Instructions are ${count}/${INSTRUCTIONS_CHAR_LIMIT} characters. Shorten them, then save.`,
			);
		}
		await withFileLock(this.filePath, (check) => atomicWrite(this.filePath, normalized, check));
		return normalized;
	}
}
