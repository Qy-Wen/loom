const { cpSync, existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = join(__dirname, "../..");
const archName = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** @type {import("electron-builder").Configuration} */
const config = {
	appId: "com.loom.app",
	productName: "Loom",
	artifactName: "Loom-${version}-${os}-${arch}.${ext}",
	...(process.env.LOOM_RELEASE_VERSION ? { extraMetadata: { version: process.env.LOOM_RELEASE_VERSION } } : {}),
	directories: {
		output: process.env.LOOM_RELEASE_DIR || "release",
	},
	files: [
		"out/**/*",
		"package.json",
		"resources/icon.png",
		// @loom/core and @loom/agent are bundled into out/main. Leave them out so the
		// package does not also carry their source and the vendored FFmpeg tree.
		"!node_modules/@loom/**",
		"!**/*.map",
		// Ladybug publishes browser, sync, and multithreaded builds. The app loads nodejs only.
		"!**/node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js",
		"!**/node_modules/@ladybugdb/wasm-core/sync/**",
		"!**/node_modules/@ladybugdb/wasm-core/multithreaded/**",
		// chord's bundler depends on esbuild. Loom does not call it.
		"!**/node_modules/esbuild/**",
		"!**/node_modules/@esbuild/**",
		// The tokenizer is bundled into out/main.
		"!**/node_modules/js-tiktoken/**",
		// Prebuilds are loaded; the SQLite C sources and non-target binaries are not.
		"!**/node_modules/better-sqlite3/deps/**",
		"!**/node_modules/better-sqlite3/prebuilds/linux-*",
		"!**/node_modules/better-sqlite3/prebuilds/linuxmusl-*",
		"!**/node_modules/better-sqlite3/prebuilds/win32-arm64*",
	],
	asarUnpack: [
		"**/node_modules/better-sqlite3/**",
		"**/node_modules/sqlite-vec/**",
		"**/node_modules/sqlite-vec-*/**",
		"**/node_modules/@ladybugdb/wasm-core/**",
		// The Ladybug worker runs from the unpacked tree, so its requires must be unpacked too.
		"**/node_modules/threads/**",
		"**/node_modules/tiny-worker/**",
		"**/node_modules/uuid/**",
		"**/node_modules/callsites/**",
		"**/node_modules/debug/**",
		"**/node_modules/ms/**",
		"**/node_modules/is-observable/**",
		"**/node_modules/observable-fns/**",
		"**/node_modules/esm/**",
		"**/node_modules/@anthropic-ai/sandbox-runtime/**",
		"**/node_modules/@pondwader/socks5-server/**",
		"**/node_modules/commander/**",
		"**/node_modules/node-forge/**",
		"**/node_modules/zod/**",
		"**/*.{node,dll,dylib,so}",
	],
	npmRebuild: false,
	// Legacy NSIS 3.0.4.1 ships an x86_64 makensis. 1.2.1 is the arm64-capable bundle.
	toolsets: {
		nsis: "1.2.1",
	},
	buildDependenciesFromSource: false,
	mac: {
		identity: null,
		category: "public.app-category.productivity",
		icon: "resources/icon.png",
		target: [{ target: "dmg", arch: ["arm64", "x64"] }],
	},
	win: {
		icon: "resources/icon.png",
		target: [{ target: "nsis", arch: ["x64"] }],
	},
	nsis: {
		oneClick: false,
		perMachine: false,
		allowElevation: false,
		allowToChangeInstallationDirectory: true,
	},
	afterPack(context) {
		const platform = context.electronPlatformName;
		const arch = archName[context.arch];
		if (!arch) throw new Error(`Unknown electron-builder arch ${context.arch}`);
		const id = `${platform}-${arch}`;
		const binary = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
		const source = join(repoRoot, "packages/core/vendor/ffmpeg", id);
		if (!existsSync(join(source, binary))) {
			throw new Error(`FFmpeg for ${id} is missing. Run pnpm vendor:ffmpeg --all.`);
		}
		const resourcesRoot =
			platform === "darwin"
				? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
				: join(context.appOutDir, "resources");
		cpSync(source, join(resourcesRoot, "ffmpeg"), { recursive: true });
		keepSqlitePrebuild(resourcesRoot, id);
	},
};

function keepSqlitePrebuild(resourcesRoot, id) {
	const prebuilds = join(resourcesRoot, "app.asar.unpacked/node_modules/better-sqlite3/prebuilds");
	if (!existsSync(prebuilds)) throw new Error(`better-sqlite3 prebuilds are missing under ${prebuilds}`);
	const keep = `${id}.node`;
	for (const name of readdirSync(prebuilds)) {
		if (name !== keep) rmSync(join(prebuilds, name), { recursive: true, force: true });
	}
	if (!existsSync(join(prebuilds, keep))) {
		throw new Error(`better-sqlite3 prebuild ${keep} is missing.`);
	}
}

module.exports = config;
