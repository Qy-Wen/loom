import type { ComposerReference, LoomUserAttachment } from "@loom/agent";
import { splitStoredAssetText } from "@loom/agent/composer-asset";
import { transcriptText } from "../../shared/ag-ui-messages.ts";

export function messageText(message: { content?: unknown }): string {
	return transcriptText(message.content).replaceAll("\u200b", "");
}

export function editableText(text: string): boolean {
	return splitStoredAssetText(text).some((part) => part.type === "reference" || part.text.trim().length > 0);
}

export function placedChips(rows: readonly LoomUserAttachment[]): ComposerReference[] {
	return rows.filter((row): row is ComposerReference => row.type !== "ui_selection");
}
