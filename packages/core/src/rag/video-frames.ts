import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProbeArgs, buildVlmStillArgs } from "../media/operations.ts";
import { parseFfprobeJson } from "../media/probe.ts";
import { runMediaProcess } from "../media/run.ts";
import type { VideoVlmFrame } from "../model/video-vlm.ts";

/** 10% / 50% / 90% when the clip is long enough; fewer stills for short files. */
export function vlmFrameTimes(durationSeconds: number): number[] {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
	if (durationSeconds < 2) return [Math.min(0.1, durationSeconds * 0.5)];
	if (durationSeconds < 6) return [durationSeconds * 0.2, durationSeconds * 0.8];
	return [durationSeconds * 0.1, durationSeconds * 0.5, durationSeconds * 0.9];
}

/** Temp JPEGs for the VLM. Not written into the library. */
export async function extractVideoFramesForVlm(
	absolutePath: string,
	signal?: AbortSignal,
): Promise<VideoVlmFrame[]> {
	const probe = await runMediaProcess({
		program: "ffprobe",
		args: buildProbeArgs(absolutePath),
		signal,
	});
	const duration = parseFfprobeJson(probe.stdout).duration ?? 0;
	const times = vlmFrameTimes(duration);
	const dir = await mkdtemp(join(tmpdir(), "loom-vlm-frames-"));
	try {
		const frames: VideoVlmFrame[] = [];
		for (const [index, time] of times.entries()) {
			const filename = `frame-${index}.jpg`;
			const output = join(dir, filename);
			await runMediaProcess({
				program: "ffmpeg",
				args: buildVlmStillArgs(absolutePath, output, time),
				signal,
			});
			frames.push({ filename, bytes: await readFile(output) });
		}
		if (frames.length === 0) throw new Error("FFmpeg extracted no frames");
		return frames;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
