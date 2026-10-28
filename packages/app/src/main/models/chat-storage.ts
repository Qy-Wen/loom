import { join } from "node:path";
import { safeStorage } from "electron";
import { ChatCredentialStore, type ChatSecretCipher } from "./chat-credential-store.ts";
import { ChatConfigStore } from "./chat-config-store.ts";
import { ChatCatalogStore } from "./chat-catalog-store.ts";

/** Call in Main after app readiness. No persistence/migration occurs just by constructing stores. */
/** OS-backed encryption (Keychain on macOS, DPAPI on Windows). Only valid after the app is ready. */
export const electronSecretCipher: ChatSecretCipher = {
	available: () => safeStorage.isEncryptionAvailable(),
	encrypt: (value) => safeStorage.encryptString(value),
	decrypt: (value) => safeStorage.decryptString(value),
};

export function createChatStorage(userData: string, cipher: ChatSecretCipher = electronSecretCipher) {
	return {
		config: new ChatConfigStore(join(userData, "chat-models.json")),
		credentials: new ChatCredentialStore(join(userData, "chat-credentials.json"), cipher),
		catalog: new ChatCatalogStore(join(userData, "chat-model-catalog.json")),
	};
}
