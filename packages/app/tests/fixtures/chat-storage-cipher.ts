import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ChatSecretCipher } from "../../src/main/models/chat-credential-store.ts";

/** Authenticated encryption for tests; production uses OS-backed Electron safeStorage only. */
export function testChatCipher(key = randomBytes(32)): ChatSecretCipher {
	return {
		available: () => true,
		encrypt(value) {
			const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
			const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), body]);
		},
		decrypt(value) {
			const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
			cipher.setAuthTag(value.subarray(12, 28));
			return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
		},
	};
}
