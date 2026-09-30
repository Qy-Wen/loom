import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = join(ROOT, "packages/core/vendor/ffmpeg");
const TAG = "b6.1.1";
const GITHUB = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}`;

function urlsFor(filename) {
	const origin = `${GITHUB}/${filename}`;
	const extra = process.env.LOOM_FFMPEG_MIRROR;
	return [
		extra ? `${extra.replace(/\/$/, "")}/${filename}` : null,
		`https://cdn.npmmirror.com/binaries/ffmpeg-static/${TAG}/${filename}`,
		`https://registry.npmmirror.com/-/binary/ffmpeg-static/${TAG}/${filename}`,
		`https://ghfast.top/${origin}`,
		`https://gh-proxy.com/${origin}`,
		origin,
	].filter(Boolean);
}

const PLATFORMS = {
	"win32-x64": { suffix: "win32-x64", exe: true },
	"darwin-arm64": { suffix: "darwin-arm64", exe: false },
	"darwin-x64": { suffix: "darwin-x64", exe: false },
};

const requested = process.argv.includes("--all")
	? Object.keys(PLATFORMS)
	: [`${process.platform}-${process.arch}`];

for (const id of requested) {
	const spec = PLATFORMS[id];
	if (!spec) {
		console.error(`Unsupported platform ${id}. Use --all or run on win32-x64 / macOS.`);
		process.exitCode = 1;
		continue;
	}
	const dest = join(VENDOR, id);
	const ffmpegName = spec.exe ? "ffmpeg.exe" : "ffmpeg";
	const ffprobeName = spec.exe ? "ffprobe.exe" : "ffprobe";
	const ffmpegPath = join(dest, ffmpegName);
	const ffprobePath = join(dest, ffprobeName);
	if (await installedBinary(ffmpegPath) && await installedBinary(ffprobePath)) {
		console.log(`FFmpeg for ${id} already present -> ${dest}`);
		continue;
	}
	await mkdir(dest, { recursive: true });
	await downloadGz(`ffmpeg-${spec.suffix}.gz`, ffmpegPath, !spec.exe);
	await downloadGz(`ffprobe-${spec.suffix}.gz`, ffprobePath, !spec.exe);
	console.log(`Installed FFmpeg for ${id} -> ${dest}`);
}

async function installedBinary(path) {
	if (!existsSync(path)) return false;
	const info = await stat(path);
	return info.isFile() && info.size > 0;
}

async function downloadGz(filename, dest, executable) {
	const urls = [...new Set(urlsFor(filename))];
	let lastError;
	for (const url of urls) {
		try {
			console.log(`Downloading ${url}`);
			await downloadTo(url, dest, executable);
			return;
		} catch (error) {
			lastError = error;
			console.warn(`  failed: ${error instanceof Error ? error.message : error}`);
			await unlink(dest).catch(() => undefined);
		}
	}
	throw lastError ?? new Error(`Failed to download ${filename}`);
}

async function downloadTo(url, dest, executable) {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(180_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	let lastLog = Date.now();
	const started = Date.now();
	const input = Readable.fromWeb(response.body);
	input.on("data", (chunk) => {
		received += chunk.length;
		const now = Date.now();
		if (now - lastLog < 500) return;
		lastLog = now;
		const seconds = Math.max(0.001, (now - started) / 1000);
		const speed = received / seconds / 1024 / 1024;
		const totalText = total ? ` / ${mb(total)}` : "";
		console.log(`  ${mb(received)}${totalText}  ${speed.toFixed(2)} MB/s`);
	});

	await pipeline(input, createGunzip(), createWriteStream(dest));
	const seconds = Math.max(0.001, (Date.now() - started) / 1000);
	console.log(`  done ${mb(received)} in ${seconds.toFixed(1)}s (${(received / seconds / 1024 / 1024).toFixed(2)} MB/s)`);
	if (executable) await chmod(dest, 0o755);
}

function mb(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
