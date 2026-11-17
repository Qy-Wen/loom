import COS from "cos-nodejs-sdk-v5";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CosCloudConfig, CosCloudConnection } from "../../shared/cloud-providers/cos.ts";
import type { ObjectInfo, ObjectStore } from "./object-store.ts";

/** Do not surface SDK error bodies/URLs: they can contain signed request credentials. */
function cosError(error: unknown, operation: string): Error {
	const value = error as { code?: string; statusCode?: number };
	const code = typeof value?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value.code) ? value.code : "RequestFailed";
	return new Error(`COS ${operation}: ${code}${typeof value?.statusCode === "number" ? ` (HTTP ${value.statusCode})` : ""}`);
}

export class CosObjectStore implements ObjectStore {
	readonly #client: COS;
	readonly #config: CosCloudConfig;
	constructor(config: CosCloudConnection, client?: COS) {
		this.#config = config;
		this.#client = client ?? new COS({ SecretId: config.credentials.secretId, SecretKey: config.credentials.secretKey, Protocol: "https:", Timeout: 30_000, ChunkRetryTimes: 3, ChunkParallelLimit: 3, FileParallelLimit: 3, UploadCheckContentMd5: true });
	}
	#params(key: string) { return { Bucket: this.#config.bucket, Region: this.#config.region, Key: `${this.#config.prefix}/${key}` }; }
	async head(key: string, signal: AbortSignal): Promise<ObjectInfo | undefined> {
		signal.throwIfAborted();
		try {
			const result = await this.#client.headObject(this.#params(key));
			signal.throwIfAborted();
			const size = Number(result.headers?.["content-length"]), etag = result.headers?.etag;
			if (!Number.isSafeInteger(size) || size < 0 || typeof etag !== "string" || !etag) throw new Error("Invalid COS object metadata");
			return { size, etag };
		}
		catch (error) {
			signal.throwIfAborted();
			if ((error as { statusCode?: number }).statusCode === 404) return undefined;
			throw cosError(error, "HeadObject");
		}
	}
	async remove(key: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		try { await this.#client.deleteObject(this.#params(key)); signal.throwIfAborted(); }
		catch (error) {
			signal.throwIfAborted();
			if ((error as { statusCode?: number }).statusCode !== 404) throw cosError(error, "DeleteObject");
		}
	}
	async upload(key: string, file: string, signal: AbortSignal, progress?: (bytes: number) => void): Promise<void> {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			let taskId: string | undefined;
			const abort = () => { if (taskId) this.#client.cancelTask(taskId); reject(signal.reason); };
			signal.addEventListener("abort", abort, { once: true });
			this.#client.uploadFile({ ...this.#params(key), FilePath: file, SliceSize: 8 * 1024 * 1024, ChunkSize: 8 * 1024 * 1024,
				onTaskReady: (id) => { taskId = id; if (signal.aborted) this.#client.cancelTask(id); },
				onProgress: ({ loaded }) => { if (!signal.aborted) progress?.(loaded); },
			}, (error) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else if (error) reject(cosError(error, "UploadFile")); else resolve();
			});
		});
	}
	async download(key: string, file: string, signal: AbortSignal, limit: number, progress?: (bytes: number) => void): Promise<void> {
		// The SDK signs the request locally. Fetch supplies cancellable, bounded streaming without buffering videos.
		const url = await new Promise<string>((resolve, reject) => {
			this.#client.getObjectUrl({ ...this.#params(key), Sign: true, Expires: 3600 }, (error, data) => error ? reject(cosError(error, "GetObject")) : resolve(data.Url));
		});
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			const timeout = new AbortController();
			let timer: ReturnType<typeof setTimeout>;
			const touch = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(), 30_000); };
			const transferSignal = AbortSignal.any([signal, timeout.signal]);
			touch();
			try {
				const response = await fetch(url, { signal: transferSignal, redirect: "error" });
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error(`COS download failed (HTTP ${response.status})`);
				}
				let received = 0;
				await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({ transform(chunk, _encoding, callback) {
					touch();
					received += chunk.length;
					if (received > limit) { callback(new Error("Cloud object exceeds the backup's declared size")); return; }
					progress?.(received); callback(null, chunk);
				} }), createWriteStream(file, { mode: 0o600 }), { signal: transferSignal });
				return;
			} catch (error) {
				signal.throwIfAborted();
				if (attempt >= 2) throw new Error(error instanceof Error && error.message.startsWith("COS download failed") ? error.message : "COS download failed or object size is invalid");
			} finally { clearTimeout(timer!); }
		}
	}
	async *list(prefix: string, signal: AbortSignal): AsyncIterable<string> {
		let marker: string | undefined;
		const base = `${this.#config.prefix}/`;
		do {
			signal.throwIfAborted();
			let result: COS.GetBucketResult;
			try { result = await this.#client.getBucket({ Bucket: this.#config.bucket, Region: this.#config.region, Prefix: `${base}${prefix}`, Marker: marker, MaxKeys: 1000 }); }
			catch (error) { throw cosError(error, "GetBucket"); }
			for (const object of result.Contents ?? []) {
				signal.throwIfAborted();
				if (!object.Key.startsWith(`${base}${prefix}`)) throw new Error("Unexpected COS listing prefix");
				yield object.Key.slice(base.length);
			}
			const truncated = String(result.IsTruncated) === "true";
			const next = truncated ? result.NextMarker : undefined;
			if (truncated && (!next || next === marker)) throw new Error("Invalid COS listing pagination");
			marker = next;
		} while (marker);
	}
}
