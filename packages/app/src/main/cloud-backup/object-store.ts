/** Provider-independent keys are relative to the configured backup collection. */
export interface ObjectInfo { size: number; etag: string }
export interface ObjectStore {
	/** Opaque ETag changes when the stored content changes. Missing objects return undefined. */
	head(key: string, signal: AbortSignal): Promise<ObjectInfo | undefined>;
	/** Resolve after the complete object is readable. Never expose a partial object under the final key. */
	upload(key: string, file: string, signal: AbortSignal, progress?: (bytes: number) => void): Promise<void>;
	/** Stream into the caller's temporary file, enforcing the actual byte limit and cancellation. */
	download(key: string, file: string, signal: AbortSignal, limit: number, progress?: (bytes: number) => void): Promise<void>;
	/** Delete exactly this key, never a prefix or another library's objects. Missing objects are harmless. */
	remove(key: string, signal: AbortSignal): Promise<void>;
	/** Yield relative keys across all pages matching the prefix. */
	list(prefix: string, signal: AbortSignal): AsyncIterable<string>;
}
