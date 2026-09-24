import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	DEFAULT_SESSION_TITLE,
	isTranscriptMessage,
	type LoomTranscriptMessage,
	type SessionRecord,
	type SessionStatus,
	type SessionSummary,
} from "../model/session.ts";

const FORMAT = 1;

type SessionLine =
	| { v: typeof FORMAT; kind: "header"; id: string; createdAt: number }
	| { kind: "name"; name: string; timestamp: number }
	| { kind: "status"; status: SessionStatus; timestamp: number }
	| { kind: "message"; message: LoomTranscriptMessage; timestamp: number };

export class SessionOpenError extends Error {
	constructor(id: string) {
		super(`Session is open: ${id}`);
		this.name = "SessionOpenError";
	}
}

/** Append-only JSONL session repo, shaped after pi's JsonlSessionRepo. */
export class JsonlSessionRepo {
	private readonly directory: string;
	private readonly openIds = new Set<string>();

	constructor(directory: string) {
		this.directory = directory;
	}

	async create(id = randomUUID()): Promise<SessionRecord> {
		await mkdir(this.directory, { recursive: true });
		if (await this.findPath(id)) throw new Error(`Session already exists: ${id}`);
		const createdAt = Date.now();
		const path = join(this.directory, sessionFileName(createdAt, id));
		const lines: SessionLine[] = [
			{ v: FORMAT, kind: "header", id, createdAt },
			{ kind: "name", name: DEFAULT_SESSION_TITLE, timestamp: createdAt },
			{ kind: "status", status: "open", timestamp: createdAt },
		];
		await appendFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
		this.openIds.add(id);
		return {
			id,
			title: DEFAULT_SESSION_TITLE,
			status: "open",
			createdAt,
			updatedAt: createdAt,
			messages: [],
		};
	}

	async list(): Promise<SessionSummary[]> {
		const records = await this.readAll();
		return records
			.map((record) => ({
				id: record.id,
				title: record.title,
				status: record.status,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			}))
			.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
	}

	async get(id: string): Promise<SessionRecord> {
		const found = (await this.readAll()).find((record) => record.id === id);
		if (!found) throw new Error(`Session not found: ${id}`);
		return found;
	}

	async open(id: string): Promise<SessionRecord> {
		const record = await this.get(id);
		this.openIds.add(id);
		return record;
	}

	closeHandle(id: string): void {
		this.openIds.delete(id);
	}

	resetHandles(): void {
		this.openIds.clear();
	}

	isOpen(id: string): boolean {
		return this.openIds.has(id);
	}

	async appendMessages(id: string, messages: LoomTranscriptMessage[]): Promise<void> {
		if (messages.length === 0) return;
		const path = await this.requirePath(id);
		const timestamp = Date.now();
		const chunk = messages.map((message) => JSON.stringify({ kind: "message", message, timestamp } satisfies SessionLine)).join("\n");
		await appendFile(path, `${chunk}\n`);
	}

	async setName(id: string, name: string): Promise<void> {
		const path = await this.requirePath(id);
		const timestamp = Date.now();
		await appendFile(path, `${JSON.stringify({ kind: "name", name, timestamp } satisfies SessionLine)}\n`);
	}

	async setStatus(id: string, status: SessionStatus): Promise<void> {
		const path = await this.requirePath(id);
		const timestamp = Date.now();
		await appendFile(path, `${JSON.stringify({ kind: "status", status, timestamp } satisfies SessionLine)}\n`);
		if (status === "archived") this.openIds.delete(id);
		if (status === "open") this.openIds.add(id);
	}

	async delete(id: string): Promise<void> {
		if (this.openIds.has(id)) throw new SessionOpenError(id);
		const path = await this.findPath(id);
		if (!path) throw new Error(`Session not found: ${id}`);
		await unlink(path);
	}

	private async requirePath(id: string): Promise<string> {
		const path = await this.findPath(id);
		if (!path) throw new Error(`Session not found: ${id}`);
		return path;
	}

	private async findPath(id: string): Promise<string | undefined> {
		await mkdir(this.directory, { recursive: true });
		const names = await readdir(this.directory);
		return names
			.filter((name) => name.endsWith(".jsonl") && name.includes(`_${id}.jsonl`))
			.map((name) => join(this.directory, name))[0];
	}

	private async readAll(): Promise<SessionRecord[]> {
		await mkdir(this.directory, { recursive: true });
		const names = await readdir(this.directory);
		const records: SessionRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const parsed = await this.parseFile(join(this.directory, name));
			if (parsed) records.push(parsed);
		}
		return records;
	}

	private async parseFile(path: string): Promise<SessionRecord | undefined> {
		const text = await readFile(path, "utf8");
		let id = "";
		let createdAt = 0;
		let title = DEFAULT_SESSION_TITLE;
		let status: SessionStatus = "open";
		let updatedAt = 0;
		const messages: LoomTranscriptMessage[] = [];
		for (const raw of text.split(/\r?\n/)) {
			if (!raw.trim()) continue;
			let line: SessionLine;
			try {
				line = JSON.parse(raw) as SessionLine;
			} catch {
				continue;
			}
			if (line.kind === "header") {
				id = line.id;
				createdAt = line.createdAt;
				updatedAt = Math.max(updatedAt, line.createdAt);
			} else if (line.kind === "name") {
				title = line.name;
				updatedAt = Math.max(updatedAt, line.timestamp);
			} else if (line.kind === "status") {
				status = line.status;
				updatedAt = Math.max(updatedAt, line.timestamp);
			} else if (line.kind === "message" && isTranscriptMessage(line.message)) {
				messages.push(line.message);
				updatedAt = Math.max(updatedAt, line.timestamp);
			}
		}
		if (!id) return undefined;
		return { id, title, status, createdAt, updatedAt, messages };
	}
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}
