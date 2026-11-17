// Run: node --experimental-strip-types scripts/benchmark-cloud-backup.mjs --report /tmp/loom-backup.json
// Uses generated files and an in-memory provider with simulated request latency; no cloud credentials.
import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

let io = { streamReadBytes: 0, stagedWriteBytes: 0 };
const originalRead = fs.createReadStream, originalWrite = fs.createWriteStream;
fs.createReadStream = (...args) => {
	const stream = originalRead(...args), emit = stream.emit;
	stream.emit = function (event, ...values) { if (event === "data") io.streamReadBytes += Buffer.byteLength(values[0]); return emit.call(this, event, ...values); };
	return stream;
};
fs.createWriteStream = (...args) => {
	const stream = originalWrite(...args), write = stream.write;
	stream.write = function (chunk, ...rest) { io.stagedWriteBytes += Buffer.byteLength(chunk); return write.call(this, chunk, ...rest); };
	return stream;
};
syncBuiltinESMExports();
const { captureSnapshot } = await import("../src/main/cloud-backup/snapshot.ts");
const { updateMirror } = await import("../src/main/cloud-backup/mirror.ts");
const root = await realpath(await mkdtemp(join(tmpdir(), "loom-backup-bench-")));
const signal = () => new AbortController().signal;
const MiB = 1024 * 1024;

class SimulatedStore {
	objects = new Map(); uploads = 0; uploadedBytes = 0; failKey;
	async head(key, signal) { await delay(3, undefined, { signal }); const value = this.objects.get(key); return value && { size: value.size, etag: value.etag }; }
	async upload(key, path, signal, progress) {
		await delay(3, undefined, { signal });
		if (key.endsWith(this.failKey ?? "\0")) throw new Error("Simulated connection interruption");
		const hash = createHash("sha256"), chunks = []; let size = 0;
		const json = key.startsWith(".loom/libraries/") || key.endsWith(".loom/backup/manifest.json");
		for await (const chunk of fs.createReadStream(path, { signal })) { hash.update(chunk); size += chunk.length; if (json) chunks.push(chunk); progress?.(size); }
		await delay(size / (128 * MiB) * 1000, undefined, { signal });
		this.objects.set(key, { size, etag: hash.digest("hex"), bytes: json ? Buffer.concat(chunks) : undefined });
		if (!json && !key.endsWith("/")) { this.uploads++; this.uploadedBytes += size; }
	}
	async download(key, path, signal, limit) { await delay(3, undefined, { signal }); const value = this.objects.get(key); if (!value?.bytes || value.size > limit) throw new Error("Invalid benchmark object"); await writeFile(path, value.bytes); }
	async remove(key, signal) { await delay(3, undefined, { signal }); this.objects.delete(key); }
	async *list(prefix, signal) { await delay(3, undefined, { signal }); for (const key of this.objects.keys()) if (key.startsWith(prefix)) yield key; }
}
const store = new SimulatedStore(), rows = [];
async function update(provider, resumeFile, name) {
	io = { streamReadBytes: 0, stagedWriteBytes: 0 };
	provider.uploads = 0; provider.uploadedBytes = 0;
	const started = performance.now(), snapshot = await captureSnapshot(root, signal());
	snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
	await updateMirror(snapshot, provider, "benchmark", signal(), () => {}, () => {}, () => {}, { resumeFile });
	const result = { scenario: name, ms: Math.round(performance.now() - started), streamReadMiB: +(io.streamReadBytes / MiB).toFixed(2), stagedWriteMiB: +(io.stagedWriteBytes / MiB).toFixed(2), uploadedMiB: +(provider.uploadedBytes / MiB).toFixed(2), uploadedFiles: provider.uploads };
	if (name) rows.push(result);
}
try {
	await mkdir(join(root, "images")); await mkdir(join(root, "notes"));
	for (let index = 0; index < 48; index++) await writeFile(join(root, "images", `image-${String(index).padStart(3, "0")}.bin`), Buffer.alloc(2 * MiB, index + 1));
	for (let index = 0; index < 128; index++) await writeFile(join(root, "notes", `${String(index).padStart(3, "0")}.txt`), Buffer.alloc(8192, index));
	await writeFile(join(root, "video.bin"), Buffer.alloc(32 * MiB, 111));
	const journal = join(root, ".loom/backup/benchmark-progress.jsonl");
	await update(store, journal, "initial");
	await update(store, journal, "unchanged");
	await writeFile(join(root, "images/image-000.bin"), Buffer.alloc(2 * MiB, 222));
	await update(store, journal, "one-file-changed");
	const interrupted = new SimulatedStore(); interrupted.failKey = "images/image-025.bin";
	try { await update(interrupted, journal, undefined); } catch (error) { if (!error.message.includes("Simulated connection")) throw error; }
	interrupted.failKey = undefined;
	await update(interrupted, journal, "retry-after-interruption");
	const report = { fixtureMiB: 129, latencyMs: 3, simulatedMiBPerSecondPerFile: 128, note: "Simulated provider; stream counters exclude metadata capture and direct JSON readFile/writeFile operations. Not real COS throughput.", rows };
	const reportIndex = process.argv.indexOf("--report");
	if (reportIndex !== -1) await writeFile(process.argv[reportIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
	console.table(rows);
} finally {
	fs.createReadStream = originalRead; fs.createWriteStream = originalWrite; syncBuiltinESMExports();
	await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
