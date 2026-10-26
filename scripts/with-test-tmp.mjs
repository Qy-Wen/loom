// Run a command with TMPDIR/TEMP/TMP pointing at one throwaway directory, then delete it.
// Tests create hundreds of mkdtemp() folders and several never clean up; this keeps them
// out of the user's real temp directory. Usage: node scripts/with-test-tmp.mjs <command> [args...]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = process.argv.slice(2);
if (command.length === 0) {
	console.error("usage: with-test-tmp.mjs <command> [args...]");
	process.exit(2);
}

// Keep the path short: the process sandbox creates Unix sockets inside it, which are limited to ~104 bytes.
const root = mkdtempSync(join(tmpdir(), "lt-"));
let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	// Windows releases directory handles a moment after the child exits.
	rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
}

const child = spawn(command[0], command.slice(1), {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
	console.error(error.message);
	try { cleanup(); } catch { /* best effort */ }
	process.exit(127);
});
child.on("close", (code, signal) => {
	try { cleanup(); } catch (error) { console.error(`could not remove ${root}: ${error.message}`); }
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
