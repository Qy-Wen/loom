import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildAudioCompactArgs } from "../media/operations.ts";
import { runMediaProcess } from "../media/run.ts";
import { AUDIO_WRITEUP_MAX_BYTES, type AudioWriteupInput } from "../model/audio-writeup.ts";

/** Send the file as-is when it fits; otherwise FFmpeg to 16 kHz mono MP3. */
export async function prepareAudioForModel(
	absolutePath: string,
	size: number,
	signal?: AbortSignal,
): Promise<AudioWriteupInput> {
	if (size > 0 && size <= AUDIO_WRITEUP_MAX_BYTES) {
		return { filename: basename(absolutePath), bytes: await readFile(absolutePath, { signal }) };
	}
	const dir = await mkdtemp(join(tmpdir(), "loom-audio-"));
	const output = join(dir, "audio.mp3");
	try {
		await runMediaProcess({
			program: "ffmpeg",
			args: buildAudioCompactArgs(absolutePath, output),
			signal,
		});
		const compact = await stat(output);
		if (compact.size > AUDIO_WRITEUP_MAX_BYTES) {
			throw new Error("Audio write-up accepts files up to 32 MB after converting");
		}
		return { filename: "audio.mp3", bytes: await readFile(output, { signal }) };
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}
