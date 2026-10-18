import { emptyChatConfig, parseChatConfig, type ChatModelsConfig } from "@loom/agent/chat-models";
import { ChatJsonFile, type StorageOptions } from "./chat-file.ts";

export class ChatConfigStore {
	readonly file: ChatJsonFile<ChatModelsConfig>;
	constructor(path: string) { this.file = new ChatJsonFile(path, parseChatConfig); }
	async load(options?: StorageOptions): Promise<ChatModelsConfig> { return await this.file.read(options) ?? emptyChatConfig(); }
	async save(config: ChatModelsConfig, options?: StorageOptions): Promise<void> {
		const validated = parseChatConfig(config);
		await this.file.update(async () => ({ value: validated, result: undefined }), options);
	}
}
