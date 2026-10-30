// Run a command with extra environment variables, the same way on macOS and Windows.
// Usage: node scripts/with-env.mjs NAME=value [NAME=value ...] -- <command> [args...]
import { spawn } from "node:child_process";

const split = process.argv.indexOf("--");
const assignments = process.argv.slice(2, split < 0 ? undefined : split);
const command = split < 0 ? [] : process.argv.slice(split + 1);
if (command.length === 0 || assignments.some((item) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item))) {
	console.error("usage: with-env.mjs NAME=value [NAME=value ...] -- <command> [args...]");
	process.exit(2);
}

const env = { ...process.env };
for (const item of assignments) {
	const at = item.indexOf("=");
	env[item.slice(0, at)] = item.slice(at + 1);
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: process.platform === "win32", env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exit(127); });
child.on("close", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
