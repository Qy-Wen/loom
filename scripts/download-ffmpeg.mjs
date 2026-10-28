import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = join(ROOT, "packages/core/vendor/ffmpeg");
const CACHE = join(ROOT, "node_modules/.cache/ffmpeg");
const BUILDS = JSON.parse(await readFile(new URL("./ffmpeg-builds.json", import.meta.url), "utf8"));
const run = promisify(execFile);
const host = `${process.platform}-${process.arch}`;
const requested = process.argv.includes("--all") ? Object.keys(BUILDS.platforms) : [host];

for (const id of requested) {
	const archives = BUILDS.platforms[id];
	if (!archives) {
		console.error(`Unsupported platform ${id}. Use --all or run on win32-x64 / macOS.`);
		process.exitCode = 1;
		continue;
	}
	await install(id, archives);
}

async function install(id, archives) {
	const dest = join(VENDOR, id);
	const build = `${BUILDS.version}:${archives.map((archive) => archive.sha256).join(":")}`;
	const names = archives.flatMap((archive) => Object.keys(archive.files));
	if (await isInstalled(dest, build, names)) {
		console.log(`FFmpeg ${BUILDS.version} for ${id} already present -> ${dest}`);
		return;
	}

	await mkdir(VENDOR, { recursive: true });
	const work = await mkdtemp(join(VENDOR, `.${id}-`));
	const staged = join(work, "install");
	const previous = join(work, "previous");
	let keepBackup = false;
	await mkdir(staged);
	try {
		for (const [index, archive] of archives.entries()) {
			const zip = await downloadArchive(id, archive);
			const extracted = join(work, `archive-${index}`);
			await extractZip(zip, extracted);
			for (const [name, path] of Object.entries(archive.files)) {
				await copyFile(join(extracted, path), join(staged, name));
				if (id.startsWith("darwin-")) await chmod(join(staged, name), 0o755);
				if (id === host) {
					const { stdout } = await run(join(staged, name), ["-version"], { windowsHide: true, timeout: 20_000 });
					if (!stdout.startsWith(`${name.replace(/\.exe$/, "")} version ${BUILDS.version}`)) {
						throw new Error(`Unexpected ${name} version for ${id}: ${stdout.split(/\r?\n/)[0]}`);
					}
				}
			}
		}
		const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await sha256(join(staged, name))])));
		await writeFile(join(staged, "installed.json"), `${JSON.stringify({ version: BUILDS.version, build, files }, null, 2)}\n`);

		// Keep both existing binaries until the complete replacement has been verified.
		let hadPrevious = false;
		try {
			await renameWithRetry(dest, previous);
			hadPrevious = true;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		try {
			await renameWithRetry(staged, dest);
		} catch (error) {
			if (hadPrevious) {
				try {
					await renameWithRetry(previous, dest);
				} catch (restoreError) {
					keepBackup = true;
					throw new AggregateError([error, restoreError], `Could not restore FFmpeg; previous binaries remain in ${previous}`);
				}
			}
			throw error;
		}
		console.log(`Installed FFmpeg ${BUILDS.version} for ${id} -> ${dest}`);
	} finally {
		if (!keepBackup) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

async function isInstalled(dest, build, names) {
	try {
		const installed = JSON.parse(await readFile(join(dest, "installed.json"), "utf8"));
		if (installed.build !== build) return false;
		for (const name of names) {
			if (await sha256(join(dest, name)) !== installed.files[name]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function downloadArchive(id, archive) {
	await mkdir(CACHE, { recursive: true });
	const dest = join(CACHE, `${archive.sha256}.zip`);
	if (await sha256(dest).catch(() => undefined) === archive.sha256) return dest;

	const mirror = process.env.LOOM_FFMPEG_MIRROR?.replace(/\/$/, "");
	const filename = basename(new URL(archive.urls[0]).pathname);
	const urls = [...new Set([
		...(mirror ? [`${mirror}/${id}/${BUILDS.version}/${filename}`] : []),
		...archive.urls,
	])];
	let lastError;
	for (const url of urls) {
		const partial = `${dest}.${process.pid}.part`;
		try {
			console.log(`Downloading ${url}`);
			await downloadTo(url, partial);
			if (await sha256(partial) !== archive.sha256) throw new Error(`SHA-256 mismatch for ${filename}`);
			await rm(dest, { force: true });
			await rename(partial, dest);
			return dest;
		} catch (error) {
			lastError = error;
			console.warn(`  failed: ${error instanceof Error ? error.message : error}`);
		} finally {
			await rm(partial, { force: true });
		}
	}
	throw lastError ?? new Error(`Failed to download ${filename}`);
}

async function extractZip(zip, dest) {
	if (process.platform === "win32") {
		const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
		await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
			"$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:LOOM_FFMPEG_ARCHIVE -DestinationPath $env:LOOM_FFMPEG_EXTRACT -Force",
		], {
			env: { ...process.env, LOOM_FFMPEG_ARCHIVE: zip, LOOM_FFMPEG_EXTRACT: dest },
			windowsHide: true,
		});
	} else {
		await run("/usr/bin/ditto", ["-x", "-k", zip, dest]);
	}
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function renameWithRetry(from, to) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await rename(from, to);
		} catch (error) {
			if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
			await delay(Math.min(100 * (attempt + 1), 500));
		}
	}
}

async function downloadTo(url, dest) {
	const response = await fetch(url, {
		redirect: "follow",
		headers: { "User-Agent": "Mozilla/5.0 (compatible; Loom FFmpeg installer)" },
		signal: AbortSignal.timeout(180_000),
	});
	if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`);

	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	let lastLog = Date.now();
	const started = Date.now();
	const input = Readable.fromWeb(response.body);
	input.on("data", (chunk) => {
		received += chunk.length;
		const now = Date.now();
		if (now - lastLog < 1000) return;
		lastLog = now;
		const seconds = Math.max(0.001, (now - started) / 1000);
		console.log(`  ${mb(received)}${total ? ` / ${mb(total)}` : ""}  ${(received / seconds / 1024 / 1024).toFixed(2)} MB/s`);
	});
	await pipeline(input, createWriteStream(dest));
	console.log(`  done ${mb(received)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function mb(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
