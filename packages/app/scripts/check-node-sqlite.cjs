// Run with plain Node; it launches the installed Electron binary as a real main process.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function launch(executable, args) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(executable, [__filename, ...args], { env, stdio: "inherit" });
		const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron SQLite probe timed out")); }, 30_000);
		child.once("error", (error) => { clearTimeout(timeout); reject(error); });
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error(`Electron SQLite probe exited: ${code ?? signal}`));
		});
	});
}

async function probe() {
	const { DatabaseSync } = require("node:sqlite");
	const workerIndex = process.argv.indexOf("--sqlite-worker");
	if (workerIndex !== -1) {
		const database = new DatabaseSync(process.argv[workerIndex + 1]);
		try {
			database.exec("PRAGMA busy_timeout = 1000; INSERT INTO probe(value) VALUES ('second process')");
		} finally {
			database.close();
		}
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), "loom-electron-sqlite-"));
	let database;
	let other;
	try {
		const file = join(directory, "probe.sqlite");
		database = new DatabaseSync(file);
		database.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('main process')");
		assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
		assert.equal(database.prepare("SELECT value FROM probe").get().value, "main process");
		// WAL allows another process to commit while this connection holds a read snapshot.
		database.exec("BEGIN");
		assert.equal(database.prepare("SELECT count(*) AS count FROM probe").get().count, 1);
		await launch(process.execPath, ["--sqlite-worker", file]);
		assert.equal(database.prepare("SELECT count(*) AS count FROM probe").get().count, 1);
		database.exec("COMMIT");
		assert.equal(database.prepare("SELECT count(*) AS count FROM probe").get().count, 2);
		// Two writers cannot hold a transaction concurrently, even in WAL mode.
		other = new DatabaseSync(file);
		other.exec("PRAGMA busy_timeout = 10");
		database.exec("BEGIN IMMEDIATE");
		assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked/);
		database.exec("ROLLBACK");
		other.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('after lock'); COMMIT");
		other.close();
		other = undefined;
		database.close();
		database = new DatabaseSync(file);
		assert.equal(database.prepare("SELECT count(*) AS count FROM probe").get().count, 3);
		console.log(`PASS: Electron ${process.versions.electron}, Node ${process.versions.node}: node:sqlite read/write/reopen, cross-process WAL read snapshot, writer exclusion`);
	} finally {
		other?.close();
		database?.close();
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.versions.electron) {
	const { app } = require("electron");
	app.whenReady().then(probe).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
} else {
	launch(require("electron"), []).catch((error) => { console.error(error); process.exitCode = 1; });
}
