import { ChatCredentialStore } from "../../src/main/chat-credential-store.ts";
import { testChatCipher } from "./chat-storage-cipher.ts";

const [path, key] = process.argv.slice(2);
if (!path || !key) throw new Error("Missing worker args");
const store = new ChatCredentialStore(path, testChatCipher(Buffer.from(key, "hex")));
await Promise.all(Array.from({ length: 4 }, () => store.modify("oauth-test", async (current) => {
	if (!current || current.type !== "oauth") throw new Error("Missing worker credential");
	await new Promise((resolve) => setTimeout(resolve, 15));
	return { ...current, generation: Number(current.generation ?? 0) + 1 };
})));
