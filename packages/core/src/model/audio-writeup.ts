import type { DescriptionJobStatus, DescriptionRecord, DescriptionStatus, DescriptionStatusKind } from "./description.ts";

export const AUDIO_WRITEUP_MAX_BYTES = 32 * 1024 * 1024;

export const AUDIO_WRITEUP_SYSTEM_PROMPT =
	"You describe one audio file for a local asset library. " +
	'Return only a JSON object with "caption" (non-empty plain text) and "tags" (an array of 3 to 5 concise tag names). No Markdown or code fences. ' +
	"Describe speech, music, instruments, and ambient sounds in two to six sentences. Do not invent sounds. Include a transcript field containing spoken words with approximate times when available, or null if there is no speech.";

export const AUDIO_WRITEUP_USER_PROMPT = "Describe this audio.";

export type AudioWriteupJobStatus = DescriptionJobStatus;
export type AudioWriteupStatusKind = DescriptionStatusKind;

export interface AudioWriteupInput {
	filename: string;
	bytes: Uint8Array;
}

export interface AudioWriteupProvider {
	modelId: string;
	describe(audio: AudioWriteupInput, signal?: AbortSignal): Promise<string>;
}

export type AudioWriteupRecord = DescriptionRecord;
export type AudioWriteupStatus = DescriptionStatus;

export type AudioPrepareFn = (
	absolutePath: string,
	size: number,
	signal?: AbortSignal,
) => Promise<AudioWriteupInput>;
