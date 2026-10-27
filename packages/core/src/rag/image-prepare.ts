import { readFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { buildImageStillArgs } from "../media/operations.ts";
import { runMediaProcess } from "../media/run.ts";
import { makeTempDir } from "../temp.ts";
import type { ImageVlmInput } from "../model/image-vlm.ts";

/** Formats sent as-is; GIF is reduced to its first frame as PNG. */
export async function prepareImageForModel(absolutePath: string, signal?: AbortSignal): Promise<ImageVlmInput> {
	if (extname(absolutePath).toLowerCase() !== ".gif") {
		return { filename: basename(absolutePath), bytes: await readFile(absolutePath, { signal }) };
	}
	const dir = await makeTempDir("image");
	const output = join(dir, "frame.png");
	try {
		await runMediaProcess({
			program: "ffmpeg",
			args: buildImageStillArgs(absolutePath, output),
			signal,
		});
		return { filename: "frame.png", bytes: await readFile(output, { signal }) };
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}
