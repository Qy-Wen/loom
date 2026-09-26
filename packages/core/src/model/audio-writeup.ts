export const AUDIO_WRITEUP_MAX_BYTES = 32 * 1024 * 1024;

export const AUDIO_WRITEUP_SYSTEM_PROMPT =
	"You describe one audio file for a local asset library. " +
	"Reply with Markdown only, using exactly these headings:\n" +
	"## Caption\n" +
	"Two to six sentences covering what you hear: speech, music, instruments, or ambient sound.\n" +
	"## Tags\n" +
	"A short comma-separated list of tags.\n" +
	"## Transcript\n" +
	"Spoken words with approximate times if you can tell. If there is no speech, write None.";

export const AUDIO_WRITEUP_USER_PROMPT = "Describe this audio.";

export type AudioWriteupJobStatus = "describing" | "ready" | "failed";
export type AudioWriteupStatusKind = "idle" | AudioWriteupJobStatus;

export interface AudioWriteupInput {
	filename: string;
	bytes: Uint8Array;
}

export interface AudioWriteupProvider {
	modelId: string;
	describe(audio: AudioWriteupInput): Promise<string>;
}

export interface AudioWriteupRecord {
	assetId: string;
	status: AudioWriteupJobStatus;
	modelId?: string;
	sourceModifiedAt: number;
	error?: string;
	markdown?: string;
	updatedAt: number;
}

export interface AudioWriteupStatus {
	assetId: string;
	status: AudioWriteupStatusKind;
	stale: boolean;
	supported: boolean;
	modelId?: string;
	sourceModifiedAt?: number;
	error?: string;
	markdown?: string;
}

export type AudioPrepareFn = (absolutePath: string, size: number) => Promise<AudioWriteupInput>;

export function normalizeAudioWriteupMarkdown(raw: string): string {
	const text = raw.trim();
	if (!text) throw new Error("Audio model returned an empty description");
	if (/^##\s+Caption\b/im.test(text)) return text;
	return `## Caption\n${text}\n`;
}
