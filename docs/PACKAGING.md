**English** | [简体中文](./PACKAGING.zh-CN.md)

# Packaging and releasing

Installable macOS and Windows builds. electron-builder packs the existing `electron-vite build` output. `pnpm dist` on a Mac produces every installer below. `pnpm release` builds them, uploads the same files to COS and GitHub, then updates and deploys the website.

## Packaging

### Builds

| Target | Installer |
| --- | --- |
| macOS arm64, macOS x64 | `.dmg` |
| Windows x64 | per-user NSIS |

Platforms match bundled FFmpeg: `darwin-arm64`, `darwin-x64`, `win32-x64`. The `.dmg` is built with macOS disk tools, so `dist` runs on a Mac and emits the Windows NSIS installer in the same run.

App id is `com.loom.app`, the same id the Windows taskbar uses. Product name is `Loom`. The installed app keeps its own user-data directory.

### Package contents

`out/` goes in the asar. These stay real files, because something loads them by path:

- `better-sqlite3` and the sqlite-vec loadable extension
- `@ladybugdb/wasm-core`, with the Node packages its unpacked scripts require (`threads`, `uuid`, and the rest of that chain)
- `@anthropic-ai/sandbox-runtime`, including `vendor/srt-win`, and the packages it requires from the unpacked tree

`srt-win.exe` and the sqlite-vec extension are addressed from inside the package. A path that lands in `app.asar` is rewritten to the same relative path under `app.asar.unpacked`.

FFmpeg for that platform is copied from `packages/core/vendor/ffmpeg/<platform>-<arch>/` to `resources/ffmpeg/`. [binaries.ts](../packages/core/src/media/binaries.ts) already looks there for `ffmpeg` and `ffprobe`.

`@loom/core` and `@loom/agent` are bundled into the main process. Renderer packages are bundled into `out/renderer` and listed as dev dependencies of `@loom/app`, so they are not copied into the installer. Dependencies the main process loads at runtime stay in the package. Photon is a direct app dependency so the bundled image processor can resolve its WASM; its JS stays bundled, and Electron reads the WASM from the asar. Source maps are left out. Ladybug keeps only its `nodejs` build. `esbuild` and the `js-tiktoken` copy already bundled into the main process are left out. `better-sqlite3` keeps the current platform's prebuild and not the C sources. Production `node_modules` are assembled in the repo and passed to electron-builder.

`better-sqlite3` already ships `darwin-arm64`, `darwin-x64`, and `win32-x64` prebuilds. Photon and Ladybug are wasm. `srt-win.exe` is already in `sandbox-runtime`. sqlite-vec publishes one optional package per platform. pnpm `supportedArchitectures` includes darwin, win32, arm64, and x64, and `@loom/app` depends directly on `sqlite-vec-darwin-x64` and `sqlite-vec-windows-x64`, so an arm64 Mac installs those too. FFmpeg for all three platforms comes from `pnpm vendor:ffmpeg --all`.

The packaged app already skips the workspace `.env` and the dev trace window.

Startup checks and failure reasons go to a local log, outside the library. macOS writes `~/Library/Logs/Loom/main.log`. Windows writes `%APPDATA%\Loom\logs\main.log`. A file rotates past 1 MB. Only `main.log`, `main.log.1`, and `main.log.2` are kept. Opening a library adds a `sqlite-vec` line with the loaded version, or the load error.

### Windows sandbox

The NSIS installer is per-user. Development installs the sandbox from [ensure-windows-sandbox.mjs](../scripts/ensure-windows-sandbox.mjs) during `pnpm install`. A packaged app has no postinstall, so on Windows, with the sandbox setting on, startup calls `ensureWindowsSandboxInstalled` and runs the same check, which asks for administrator consent. An existing install is left alone. Cancelling uses the existing fallback: the sandbox turns off and the reason is saved. macOS uses `sandbox-exec` and needs no extra install.

## Releasing

### Setup

1. Create a dedicated COS release bucket in Shanghai (`ap-shanghai`), with public read and private write. Store only public release files there. The script does not create buckets.
2. Install Node.js 22+, pnpm, [GitHub CLI](https://cli.github.com/), and the current [COSCLI](https://cloud.tencent.com/document/product/436/63144). Existing `pnpm dist` build prerequisites still apply.
3. Run `gh auth login` and `coscli config init`. COSCLI defaults to `~/.cos.yaml`. Its credentials need upload and object ACL permissions for the release bucket. Credentials remain in local tool configuration.
4. Copy `release.config.example.json` to `release.local.json`. Fill in the complete bucket name including its APPID suffix. Shanghai and `loom/releases` are preconfigured. A null `publicBaseUrl` uses the COS HTTPS origin; optionally specify a configured custom HTTPS origin.
5. Configure `website/deploy.local.json` using the [website instructions](../website/README.md), and make SSH authentication and host-key verification work on your Mac. The current server already has the Loom ingress route.

```bash
pnpm install
npm run website:deploy -- --preflight
```

Both local JSON files are ignored by Git and should not contain credentials. Commit and push the release scripts, website, and application changes before your first release. Publish from that commit on your Mac.

### Publish

Review the plan without building, authenticating, or changing remote state:

```bash
npm run release -- --version v0.1.0-alpha.1 --dry-run
```

Publish:

```bash
npm run release -- --version v0.1.0-alpha.1
```

Keep user-facing changes under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) and [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md), one plain-text bullet per line. Before publishing, move those bullets into a `## [vX.Y.Z]` section in both files, then commit and push the changes. The script reads that version for GitHub Release, and the website displays the same entries in the visitor's selected language. Use `--notes path/to/notes.md` to override the GitHub body.

Prerelease versions are marked as GitHub prereleases. Stable releases become latest. The version is injected into the packaged app without editing source package versions.

The workflow checks committed and pushed source, COS access, and website SSH; builds three installers plus `SHA256SUMS`; prepares a GitHub draft; uploads and verifies both download sources; publishes GitHub; generates `website/release-config.js`; then deploys and verifies the website.

COSCLI uses CRC64 transfer checking and adds SHA-256 object metadata for retry verification. GitHub assets are checked against their digest; older assets without one are downloaded and hashed.

### Retry behavior

- Repeat the same command with the same version, commit, and configuration. `.release-state/<version>/` retains the exact installers and progress.
- Conflicting files stop the release. Existing completed assets are never overwritten; changed content needs a new version.
- A failed website deployment leaves already published COS/GitHub assets available for retry. Cross-service publication is not atomic.
- Commit the generated `website/release-config.js` after success so ordinary website deployments retain the download links.
- Source must be clean except for the generated website config. The script does not commit, push source, or move existing Git tags.
- `.release-state/publish.lock` blocks concurrent local publishers. Remove a stale lock only after confirming the old process has stopped.
- Artifacts and verification downloads are retained in `.release-state/`; there is no automatic pruning.

```bash
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
```

### Installer notes

Installer names carry the version (`Loom-0.1.1-mac-arm64.dmg`), so `releases/latest/download/<name>` cannot address them. Use `releases/download/<tag>/<name>`, or the links `release-config.js` hands to the website.

There is no notarization and no auto-update.
