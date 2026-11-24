import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, realpath, rm } from "node:fs/promises";
import type { CloudConfig, CloudLibrary, CloudPullChange, CloudPullChoice, CloudPullPreview } from "../../shared/cloud-backup.ts";
import { JsonFile } from "../storage/file.ts";
import { hashFile, hashSnapshotFile, validateBackupPath, type Progress, type Snapshot } from "./snapshot.ts";
import { mirrorRoot, readLibrary, readManifest, type MirrorManifest } from "./mirror.ts";
import type { ObjectStore } from "./object-store.ts";

export type PullNode = { path: string; type: "file" | "directory"; hash?: string; size: number; mtimeMs?: number };
type Baseline = { format: 1; libraryId: string; revision: string; nodes: PullNode[] };
export type PullPlan = { preview: CloudPullPreview; local: PullNode[]; remote: PullNode[]; library: CloudLibrary; manifest: MirrorManifest; groups: Map<string, { local: PullNode[]; remote: PullNode[] }> };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const pullKey = (path: string) => path.normalize("NFC").toLowerCase();
export const isMetadata = (path: string) => path === ".loom" || path.startsWith(".loom/");
function parseBaseline(input: unknown): Baseline {
	const value = input as Baseline;
	if (!value || value.format !== 1 || !UUID.test(value.libraryId) || !UUID.test(value.revision) || !Array.isArray(value.nodes)) throw new Error("Invalid sync baseline");
	for (const node of value.nodes) {
		validateBackupPath(node.path, false);
		if (!["file", "directory"].includes(node.type) || !Number.isSafeInteger(node.size) || node.size < 0 || (node.type === "file" && !/^[a-f0-9]{64}$/.test(node.hash ?? ""))) throw new Error("Invalid sync baseline entry");
	}
	return value;
}
export function manifestNodes(manifest: MirrorManifest): PullNode[] { return [...manifest.directories.map((path): PullNode => ({ path, type: "directory", size: 0 })), ...manifest.files.map(({ path, hash, size, mtimeMs }): PullNode => ({ path, hash, size, mtimeMs, type: "file" }))]; }
function digest(nodes: PullNode[]): string { return createHash("sha256").update(JSON.stringify(nodes.map(({ path, type, hash }) => ({ path, type, hash })).sort((a, b) => a.path.localeCompare(b.path)))).digest("hex"); }
function scope(config: CloudConfig): string { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }
export class SyncBaselines {
	readonly directory: string;
	constructor(directory: string) { this.directory = directory; }
	async #file(config: CloudConfig, id: string, root: string) {
		if (!UUID.test(id)) throw new Error("Invalid sync library ID");
		const canonical = await realpath(root), rootKey = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
		return new JsonFile<Baseline>(join(this.directory, scope(config), id, `${rootKey}.json`), parseBaseline, { recoverCorrupt: true });
	}
	async read(config: CloudConfig, id: string, root: string): Promise<Baseline | undefined> { const value = await (await this.#file(config, id, root)).read(); if (value && value.libraryId !== id) throw new Error("Sync baseline library mismatch"); return value; }
	async save(config: CloudConfig, manifest: MirrorManifest, root: string): Promise<void> { await (await this.#file(config, manifest.library.libraryId, root)).update(async () => ({ value: { format: 1, libraryId: manifest.library.libraryId, revision: manifest.library.revision, nodes: manifestNodes(manifest) }, result: undefined })); }
}

export async function planPull(snapshot: Snapshot, store: ObjectStore, baseline: Baseline | undefined, signal: AbortSignal, progress: Progress): Promise<PullPlan> {
	const library = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
	if (!library) throw new Error("This library has no cloud copy. Restore a cloud library first, then update that same library.");
	if (library.state !== "ready") throw new Error("The cloud copy is incomplete. Finish its update on the source computer first.");
	const manifest = await readManifest(library, store, snapshot.temporary, signal), remote = manifestNodes(manifest);
	const identity = manifest.files.find((file) => file.path === ".loom/backup/identity.json");
	if (!identity || identity.size > 16 * 1024) throw new Error("The cloud library identity is missing or invalid");
	const identityPath = join(snapshot.temporary, randomUUID());
	try {
		await store.download(`${mirrorRoot(snapshot.libraryId)}${identity.path}`, identityPath, signal, identity.size);
		const verified = await hashFile(identityPath, signal, identity.size);
		if (verified.hash !== identity.hash || verified.size !== identity.size || JSON.parse(await readFile(identityPath, "utf8")).id !== snapshot.libraryId) throw new Error("Cloud library identity mismatch");
	} finally { await rm(identityPath, { force: true }); }
	const local: PullNode[] = snapshot.directories.map((path) => ({ path, type: "directory", size: 0 }));
	let completedBytes = 0;
	const totalBytes = snapshot.files.reduce((sum, file) => sum + file.size, 0);
	for (const [index, file] of snapshot.files.entries()) {
		progress({ phase: "verify", totalFiles: snapshot.files.length, totalBytes, completedFiles: index, completedBytes, currentFile: file.path });
		const check = await hashSnapshotFile(file, signal); local.push({ path: file.path, type: "file", hash: check.hash, size: check.size, mtimeMs: file.mtimeMs }); completedBytes += file.size;
	}
	const localMap = new Map(local.filter((node) => !isMetadata(node.path)).map((node) => [pullKey(node.path), node]));
	const remoteMap = new Map(remote.filter((node) => !isMetadata(node.path)).map((node) => [pullKey(node.path), node]));
	const baseMap = new Map(baseline?.nodes.filter((node) => !isMetadata(node.path)).map((node) => [pullKey(node.path), node]));
	const keys = [...new Set([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()])].sort();
	// File/directory replacements, directory deletion and case renames are resolved as whole subtrees.
	const structural = new Set(keys.filter((key) => {
		const a = localMap.get(key), b = remoteMap.get(key);
		return (a?.type === "directory" || b?.type === "directory") && (!a || !b || a.type !== b.type || a.path !== b.path);
	}));
	const ancestors = (key: string) => { const parts = key.split("/"), parents: string[] = []; parts.pop(); while (parts.length) { parents.push(parts.join("/")); parts.pop(); } return parents; };
	const roots = new Set([...structural].filter((key) => !ancestors(key).some((parent) => structural.has(parent))));
	const groups = new Map<string, { local: PullNode[]; remote: PullNode[] }>(), changes: CloudPullChange[] = [];
	function subtrees(nodes: PullNode[]) {
		const result = new Map<string, PullNode[]>();
		for (const node of nodes) { const key = pullKey(node.path), root = roots.has(key) ? key : ancestors(key).find((parent) => roots.has(parent)); if (root) { const group = result.get(root) ?? []; group.push(node); result.set(root, group); } }
		return result;
	}
	const localGroups = subtrees(local), remoteGroups = subtrees(remote), baseGroups = subtrees(baseline?.nodes ?? []);
	function add(key: string, a: PullNode[], b: PullNode[], base: PullNode[] | undefined, type: CloudPullChange["type"]) {
		if (digest(a) === digest(b)) return;
		let choice: CloudPullChoice | undefined;
		if (base) { if (digest(a) === digest(base)) choice = "remote"; else if (digest(b) === digest(base)) choice = "local"; }
		else if (a.length === 0) choice = "remote";
		const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
		const bytes = (nodes: PullNode[]) => nodes.reduce((sum, node) => sum + node.size, 0);
		const localHashes = new Map(a.filter((node) => node.type === "file").map((node) => [node.path, node.hash]));
		const downloadBytes = b.filter((node) => node.type === "file" && localHashes.get(node.path) !== node.hash).reduce((sum, node) => sum + node.size, 0);
		changes.push({ id, path: (b[0] ?? a[0])!.path, type, conflict: choice === undefined, choice, localExists: a.length > 0, remoteExists: b.length > 0, localBytes: bytes(a), remoteBytes: bytes(b), downloadBytes }); groups.set(id, { local: a, remote: b });
	}
	for (const key of roots) add(key, localGroups.get(key) ?? [], remoteGroups.get(key) ?? [], baseline ? baseGroups.get(key) ?? [] : undefined, "directory");
	for (const key of keys.filter((key) => !roots.has(key) && !ancestors(key).some((parent) => roots.has(parent)))) {
		const a = localMap.get(key), b = remoteMap.get(key), base = baseMap.get(key);
		add(key, a ? [a] : [], b ? [b] : [], baseline ? base ? [base] : [] : undefined, a?.type ?? b?.type ?? "file");
	}
	add(".loom", local.filter((node) => isMetadata(node.path)), remote.filter((node) => isMetadata(node.path)), baseline?.nodes.filter((node) => isMetadata(node.path)), "metadata");
	progress({ completedFiles: snapshot.files.length, completedBytes, currentFile: undefined });
	return { preview: { id: randomUUID(), libraryId: snapshot.libraryId, rootPath: snapshot.root, checkedAt: new Date().toISOString(), changes, firstSync: !baseline }, local, remote, library, manifest, groups };
}

export function resolvePull(plan: PullPlan, input: unknown): {
	remote: PullNode[];
	remove: PullNode[];
	metadata: boolean;
	pending: boolean;
	downloads: PullNode[];
	changedContentPaths: ReadonlySet<string>;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose how to resolve each conflict");
	const choices = input as Record<string, CloudPullChoice>, conflicts = new Set(plan.preview.changes.filter((change) => change.conflict).map((change) => change.id));
	if (Object.keys(choices).some((id) => !conflicts.has(id) || !["local", "remote"].includes(choices[id]!))) throw new Error("Invalid conflict choice");
	if ([...conflicts].some((id) => !["local", "remote"].includes(choices[id]!))) throw new Error("Choose how to resolve every conflict");
	const selected: PullNode[] = [], remove: PullNode[] = [];
	let metadata = false, pending = false;
	for (const change of plan.preview.changes) {
		const choice = change.choice ?? choices[change.id], group = plan.groups.get(change.id)!;
		if (choice === "local") { pending = true; continue; }
		selected.push(...group.remote); remove.push(...group.local);
		if (change.type === "metadata") metadata = true;
	}
	const local = new Map(plan.local.filter((node) => node.type === "file").map((node) => [node.path, node]));
	const downloads = selected.filter((node) => node.type === "file" && local.get(node.path)?.hash !== node.hash);
	const changedContentPaths = new Set<string>();
	// When keeping the local database, its derived data still describes the overwritten files.
	if (!metadata) {
		for (const node of downloads) {
			if (local.has(node.path)) changedContentPaths.add(node.path);
		}
	}
	return { remote: selected, remove, metadata, pending, downloads, changedContentPaths };
}
