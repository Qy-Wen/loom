import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	defineExtension, hook, ToolTask,
	type ToolExecutionResult,
} from "./durable-adapter.ts";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const PREVIEW_BYTES = 2 * 1024;

export function createToolResultStorage(root: string) {
	const storageRoot = resolve(root, ".agents", "tool-results");
	return defineExtension({
		name: "loom.tool-result-storage",
		hooks: [hook(ToolTask, {
			afterTool: async (call, result, api, context) => {
				if (call.name === "read" || result.diagnostics?.some((diagnostic) => diagnostic.code === "full_output")) return undefined;
				const text = (result.output ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
				const bytes = Buffer.byteLength(text, "utf8");
				if (bytes <= MAX_BYTES && text.split("\n").length - (text.endsWith("\n") ? 1 : 0) <= MAX_LINES) return undefined;
				const directory = join(storageRoot, String(api.conversationId));
				let path = join(directory, `${api.taskId}.txt`);
				const temporary = join(directory, `.${api.taskId}-${randomUUID()}.tmp`);
				try {
					context.abortSignal?.throwIfAborted();
					await mkdir(directory, { recursive: true });
					await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600, signal: context.abortSignal });
					context.abortSignal?.throwIfAborted();
					await rename(temporary, path);
					path = await realpath(path);
				} catch (error) {
					context.abortSignal?.throwIfAborted();
					return {
						...result,
						diagnostics: [...(result.diagnostics ?? []), {
							severity: "warn", code: "full_output_failed",
							message: `Could not save full output: ${error instanceof Error ? error.message : String(error)}. The output will be truncated without a full copy.`,
						}],
					};
				} finally {
					await rm(temporary, { force: true }).catch(() => undefined);
				}
				const preview = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(text).subarray(0, PREVIEW_BYTES), { stream: true });
				const output: NonNullable<ToolExecutionResult["output"]> = [];
				let shown = false;
				for (const part of result.output ?? []) {
					if (part.type !== "text") output.push(part);
					else if (!shown) {
						output.push({ type: "text", text: preview });
						shown = true;
					}
				}
				return {
					...result,
					output,
					diagnostics: [...(result.diagnostics ?? []), {
						severity: "info", code: "full_output",
						message: `Output too large (${bytes} bytes). Showing a preview of up to ${PREVIEW_BYTES} bytes. Full output: ${path}\nUse read with offset/limit for specific portions. For a long single line, use bash to select byte ranges or query JSON with jq instead of reading the whole file.`,
					}],
				};
			},
		})],
	});
}
