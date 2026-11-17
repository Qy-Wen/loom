import { unsupportedCloudProvider, type CloudConfig, type CloudProviderId } from "../../shared/cloud-backup.ts";
import type { CosCloudConnection, CosCloudCredentials } from "../../shared/cloud-providers/cos.ts";
import { parseCosConfig, parseCosCredentialDraft, parseCosCredentials } from "./cos-config.ts";
import { CosObjectStore } from "./cos-store.ts";
import type { ObjectStore } from "./object-store.ts";

export type CloudConnection = CosCloudConnection;
type CloudCredentials = CosCloudCredentials;
export type ObjectStoreFactory = (connection: CloudConnection) => ObjectStore;

function record(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid cloud configuration");
	return input as Record<string, unknown>;
}

export function parseCloudConfig(input: unknown): CloudConfig {
	const value = record(input);
	switch (value.provider) {
		case "cos": return parseCosConfig(value);
		default: throw new Error("Unsupported cloud provider");
	}
}

export function parseCloudCredentialDraft(provider: CloudProviderId, input: unknown): CloudCredentials | undefined {
	switch (provider) {
		case "cos": return parseCosCredentialDraft(input);
		default: return unsupportedCloudProvider(provider);
	}
}

export function cloudConnection(config: CloudConfig, credentials: unknown): CloudConnection {
	const provider = config.provider;
	switch (provider) {
		case "cos": return { ...config, credentials: parseCosCredentials(credentials) };
		default: return unsupportedCloudProvider(provider);
	}
}

export function storedCloudConnection(config: CloudConfig, payload: unknown): CloudConnection {
	if (payload && typeof payload === "object" && "provider" in payload) {
		if (payload.provider !== config.provider || !("credentials" in payload)) throw new Error("Cloud credentials do not match the selected provider");
		return cloudConnection(config, payload.credentials);
	}
	throw new Error("Cloud credentials do not match the selected provider");
}

/** Only the composition root uses this registry; the controller and engine receive ObjectStore. */
export const createObjectStore: ObjectStoreFactory = (connection) => {
	const provider = connection.provider;
	switch (provider) {
		case "cos": return new CosObjectStore(connection);
		default: return unsupportedCloudProvider(provider);
	}
};
