import type { CloudFileChange, CloudPreview } from "../../shared/cloud-backup.ts";
import { assertMirrorReference, mirrorManifestKey, mirrorRoot, readMirrorReference, type MirrorManifest } from "./mirror.ts";
import type { ObjectStore } from "./object-store.ts";
import { hashSnapshotFile, validateRelativePath, type Progress, type Snapshot } from "./snapshot.ts";

/** Read-only cloud inspection. Hashes all snapshot files; never writes/deletes remote objects. */
export async function previewMirror(snapshot: Snapshot, store: ObjectStore, signal: AbortSignal, progress: Progress): Promise<{ preview: CloudPreview; baseline?: MirrorManifest }> {
	const { library, manifest } = await readMirrorReference(snapshot, store, signal);
	const oldFiles = new Map(manifest?.files.map((file) => [file.path, file]));
	const base = mirrorRoot(snapshot.libraryId);
	const wanted = new Set([base, mirrorManifestKey(snapshot.libraryId)]);
	const changes: CloudFileChange[] = [];
	let completedBytes = 0, uploadBytes = 0;
	const totalBytes = snapshot.files.reduce((total, file) => total + file.size, 0);
	for (const [index, file] of snapshot.files.entries()) {
		signal.throwIfAborted();
		progress({ phase: "verify", currentFile: file.path, completedFiles: index, totalFiles: snapshot.files.length, completedBytes, totalBytes });
		const contents = await hashSnapshotFile(file, signal);
		if (contents.size !== file.size) throw new Error(`File changed during preview. Retry: ${file.path}`);
		const key = `${base}${file.path}`, old = oldFiles.get(file.path);
		wanted.add(key);
		const info = old?.hash === contents.hash ? await store.head(key, signal) : undefined;
		if (!info || info.size !== file.size || info.etag !== old?.etag) {
			changes.push({ path: file.path, kind: old ? "modified" : "added", type: "file", size: file.size });
			uploadBytes += file.size;
		}
		completedBytes += file.size;
	}
	for (const path of snapshot.directories) {
		const key = `${base}${path}/`;
		wanted.add(key);
		const info = await store.head(key, signal);
		if (!info || info.size !== 0) changes.push({ path, kind: info ? "modified" : "added", type: "directory", size: 0 });
	}
	for await (const key of store.list(base, signal)) {
		if (!key.startsWith(base)) throw new Error("Unexpected cloud preview prefix");
		if (wanted.has(key)) continue;
		const directory = key.endsWith("/"), path = key.slice(base.length).replace(/\/$/, "");
		validateRelativePath(path, false);
		changes.push({ path, kind: "deleted", type: directory ? "directory" : "file", size: oldFiles.get(path)?.size ?? 0 });
	}
	await assertMirrorReference(snapshot, library, store, signal);
	progress({ completedFiles: snapshot.files.length, completedBytes, currentFile: undefined });
	return { baseline: manifest, preview: { checkedAt: new Date().toISOString(), stale: false, repair: !!library && !manifest, uploadBytes, changes: changes.sort((a, b) => a.path.localeCompare(b.path)) } };
}
