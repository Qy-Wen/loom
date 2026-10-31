import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.error("pnpm dist runs on a Mac and produces the macOS and Windows installers.");
	process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

await run(process.execPath, [join(root, "scripts/download-ffmpeg.mjs"), "--all"]);
await run("pnpm", ["--filter", "@loom/app", "build"]);
await run("pnpm", ["--filter", "@loom/app", "exec", "electron-builder", "--mac", "--win", "--publish", "never"]);

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "null"}`));
		});
	});
}
