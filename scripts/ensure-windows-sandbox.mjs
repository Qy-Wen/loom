import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// One-time machine setup for the process sandbox during development.
// A packaged app repeats this check at startup (ensureWindowsSandboxInstalled).
// Re-running the installer rotates the sandbox password and always shows UAC,
// so an existing install is left alone. Cancelling UAC does not fail pnpm install.
if (process.platform !== "win32") process.exit(0);
if (process.env.CI) {
	console.log("CI: skipping Windows sandbox install.");
	process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/core/package.json"));
const entry = require.resolve("@anthropic-ai/sandbox-runtime");
const {
	VENDORED_SRT_WIN_EXE,
	resolveSrtWin,
	getWindowsSandboxUserStatusAsync,
	verifyWindowsWfpEgress,
	installWindowsSandboxAsync,
} = await import(pathToFileURL(entry).href);

// Keep in sync with WINDOWS_PROXY_PORT_RANGE in process-sandbox.ts.
// The package default 60080–60089 is often inside a Windows excluded port range.
const PROXY_PORT_RANGE = [20080, 20089];

const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
if (await sandboxReady(srtWin)) {
	console.log("Windows sandbox already installed.");
	process.exit(0);
}

console.log("Windows sandbox is not installed. Approve the UAC prompt to install it once.");
try {
	const result = await installWindowsSandboxAsync({ srtWin, proxyPortRange: PROXY_PORT_RANGE });
	if (result.cancelled) {
		console.warn("UAC was cancelled. The sandbox is not installed. Run pnpm install again to retry.");
		process.exit(0);
	}
	console.log("Windows sandbox installed.");
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

async function sandboxReady(spawn) {
	const user = await getWindowsSandboxUserStatusAsync({ srtWin: spawn });
	if (!user.provisioned || !user.credPresent) return false;
	try {
		await verifyWindowsWfpEgress({ srtWin: spawn });
		return true;
	} catch {
		return false;
	}
}
