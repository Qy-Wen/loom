import type { UiSelectionAttachment } from "@loom/agent";
import { parseComposerAssetInputs } from "@loom/agent/composer-asset";

const staged = new Map<string, UiSelectionAttachment[]>();

export function stageComposerAssets(sessionId: string, value: unknown): void {
	const assets = parseComposerAssetInputs(value);
	if (assets.length === 0) staged.delete(sessionId);
	else staged.set(sessionId, assets);
}

/** Take the library assets staged for the next user message. Stored on that message's attachments. */
export async function takeComposerAssets(sessionId: string): Promise<UiSelectionAttachment[]> {
	const inputs = staged.get(sessionId) ?? [];
	staged.delete(sessionId);
	return inputs;
}
