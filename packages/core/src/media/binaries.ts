import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MediaProgram = "ffmpeg" | "ffprobe";

export const MEDIA_PLATFORMS = ["win32-x64", "darwin-arm64", "darwin-x64"] as const;
export type MediaPlatformId = (typeof MEDIA_PLATFORMS)[number];

export function mediaPlatformId(platform = process.platform, arch = process.arch): MediaPlatformId {
	const id = `${platform}-${arch}`;
	if (id === "win32-x64" || id === "darwin-arm64" || id === "darwin-x64") return id;
	throw new Error(`Bundled FFmpeg is not available for ${platform}-${arch}`);
}

export function mediaBinaryName(program: MediaProgram, platform = process.platform): string {
	return platform === "win32" ? `${program}.exe` : program;
}

function vendorCandidates(): string[] {
	const candidates: string[] = [];
	if (process.env.LOOM_FFMPEG_VENDOR) candidates.push(process.env.LOOM_FFMPEG_VENDOR);

	let dir = process.cwd();
	for (let index = 0; index < 8; index += 1) {
		candidates.push(join(dir, "packages/core/vendor/ffmpeg"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	candidates.push(join(dirname(fileURLToPath(import.meta.url)), "../../vendor/ffmpeg"));
	return candidates;
}

function resolveFromRoots(program: MediaProgram): string | undefined {
	const name = mediaBinaryName(program);
	const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	if (resourcesPath) {
		const packaged = join(resourcesPath, "ffmpeg", name);
		if (existsSync(packaged)) return packaged;
	}

	let platform: MediaPlatformId;
	try {
		platform = mediaPlatformId();
	} catch {
		return undefined;
	}

	for (const root of vendorCandidates()) {
		const vendor = join(root, platform, name);
		if (existsSync(vendor)) return vendor;
	}
	return undefined;
}

export function resolveMediaBinary(program: MediaProgram): string {
	const envKey = program === "ffmpeg" ? "LOOM_FFMPEG_PATH" : "LOOM_FFPROBE_PATH";
	const fromEnv = process.env[envKey];
	if (fromEnv) return fromEnv;

	const resolved = resolveFromRoots(program);
	if (resolved) return resolved;

	throw new Error(`${program} is not bundled. Run pnpm vendor:ffmpeg or set ${envKey}.`);
}

export function tryResolveMediaBinaries(): { ffmpeg: string; ffprobe: string } | undefined {
	try {
		return {
			ffmpeg: resolveMediaBinary("ffmpeg"),
			ffprobe: resolveMediaBinary("ffprobe"),
		};
	} catch {
		return undefined;
	}
}
