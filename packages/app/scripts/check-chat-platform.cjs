// P0 only. Plain Node builds isolated probes and launches real Electron main processes.
// No app settings, real credentials, browser, or hosted API requests are used.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdir, mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { builtinModules } = require("node:module");
const { pathToFileURL } = require("node:url");

const entry = join(__dirname, "../../agent/tests/fixtures/chat-platform-probe.mjs");
const aiDist = join(__dirname, "../../agent/node_modules/@earendil-works/pi-ai/dist");

function launch(file, root, mode) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.PI_OAUTH_CALLBACK_HOST;
		const child = spawn(require("electron"), [file, "--probe-root", root, "--probe-mode", mode], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			// Wait for process exit before deleting files it may still hold on Windows.
			if (timedOut) return reject(new Error(`Electron Chat probe (${mode}) timed out: ${stdout}\n${stderr}`));
			if (code !== 0) return reject(new Error(`Electron Chat probe (${mode}) exited ${code ?? signal}: ${stderr}`));
			const line = stdout.split(/\r?\n/).find((line) => line.startsWith("LOOM_CHAT_PROBE="));
			if (!line) return reject(new Error(`Probe (${mode}) did not report a result: ${stderr}`));
			try { resolve(JSON.parse(line.slice("LOOM_CHAT_PROBE=".length))); } catch (error) { reject(error); }
		});
	});
}

async function main() {
	const { build } = await import("vite");
	const { externalizeDepsPlugin } = await import("electron-vite");
	const root = await mkdtemp(join(tmpdir(), "loom-chat-platform-p0-"));
	try {
		await mkdir(join(root, "user-data"));
		console.log(await launch(entry, root, "encrypt"));
		console.log(await launch(entry, root, "decrypt"));
		for (const mode of ["bundled", "external"]) {
			const output = join(root, mode);
			await build({
				configFile: false, root: join(__dirname, ".."), logLevel: "error", resolve: { conditions: ["node"] },
				// Reproduce the old flattened build and compare it with retained pi-ai.
				plugins: [externalizeDepsPlugin({ exclude: ["@loom/agent", "@loom/core", "@earendil-works/pi-codemode", "@silvia-odwyer/photon", ...(mode === "bundled" ? ["@earendil-works/pi-ai"] : [])], include: mode === "external" ? ["@earendil-works/pi-ai"] : [] })],
				build: { outDir: output, target: "node22", minify: false, lib: { entry, formats: ["es"], fileName: () => "index.mjs" },
					rollupOptions: { external: ["electron", ...builtinModules, ...builtinModules.map((id) => `node:${id}`)], output: {
						// A temp directory has no node_modules. Resolve external pi-ai imports to
						// the retained npm package, simulating the required installed dependency.
						paths: (id) => id.startsWith("@earendil-works/pi-ai/") ? pathToFileURL(join(aiDist, `${id.slice("@earendil-works/pi-ai/".length)}.js`)).href : id,
					} },
				},
			});
			const result = await launch(join(output, "index.mjs"), root, mode);
			if (mode === "bundled") assert.equal(result.oauth, "missing-bundled-flow");
			else { assert.equal(result.oauth.length, 9); assert.equal(result.lazySDKs.length, 4); assert.equal(result.callback, "mock-callback-state-validation-and-cancel-passed"); }
			console.log(result);
		}
		console.log("PASS: OS encryption + cross-process decrypt; bundling gap reproduced; retained pi-ai loads OAuth/SDKs; mock OpenAI callback validates state and cancellation.");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
