import { parseComposerImageInputs, type ComposerImageInput } from "@loom/agent";

const staged = new Map<string, ComposerImageInput[]>();

export function stageComposerImages(sessionId: string, value: unknown): void {
	const images = parseComposerImageInputs(value);
	if (images.length === 0) staged.delete(sessionId);
	else staged.set(sessionId, images);
}

/** Take the images staged for the next user message. They are stored on that message's content. */
export async function takeComposerImages(sessionId: string): Promise<ComposerImageInput[]> {
	const inputs = staged.get(sessionId) ?? [];
	staged.delete(sessionId);
	return inputs;
}
