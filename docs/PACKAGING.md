**English** | [简体中文](./PACKAGING.zh-CN.md)

# Packaging

Installable macOS and Windows builds. electron-builder packs the existing `electron-vite build` output. `pnpm dist` on a Mac produces every installer below.

## Builds

| Target | Installer |
| --- | --- |
| macOS arm64, macOS x64 | `.dmg` |
| Windows x64 | per-user NSIS |

Platforms match bundled FFmpeg: `darwin-arm64`, `darwin-x64`, `win32-x64`. The `.dmg` is built with macOS disk tools, so `dist` runs on a Mac and emits the Windows NSIS installer in the same run. Signing, notarization, and auto-update wait for a public release.

App id is `com.loom.app`, the same id the Windows taskbar uses. Product name is `Loom`. The installed app keeps its own user-data directory.

## Package contents

`out/` goes in the asar. These stay real files, because something loads them by path:

- `better-sqlite3` and the sqlite-vec loadable extension
- `@ladybugdb/wasm-core`, with the Node packages its unpacked scripts require (`threads`, `uuid`, and the rest of that chain)
- `@anthropic-ai/sandbox-runtime`, including `vendor/srt-win`, and the packages it requires from the unpacked tree

`srt-win.exe` and the sqlite-vec extension are addressed from inside the package. A path that lands in `app.asar` is rewritten to the same relative path under `app.asar.unpacked`.

FFmpeg for that platform is copied from `packages/core/vendor/ffmpeg/<platform>-<arch>/` to `resources/ffmpeg/`. [binaries.ts](../packages/core/src/media/binaries.ts) already looks there for `ffmpeg` and `ffprobe`.

`@loom/core` and `@loom/agent` are bundled into the main process. Renderer packages are bundled into `out/renderer` and listed as dev dependencies of `@loom/app`, so they are not copied into the installer. Dependencies the main process loads at runtime stay in the package. Source maps are left out. Ladybug keeps only its `nodejs` build. `esbuild` and the `js-tiktoken` copy already bundled into the main process are left out. `better-sqlite3` keeps the current platform's prebuild and not the C sources. Production `node_modules` are assembled in the repo and passed to electron-builder.

`better-sqlite3` already ships `darwin-arm64`, `darwin-x64`, and `win32-x64` prebuilds. Photon and Ladybug are wasm. `srt-win.exe` is already in `sandbox-runtime`. sqlite-vec publishes one optional package per platform. pnpm `supportedArchitectures` includes darwin, win32, arm64, and x64, and `@loom/app` depends directly on `sqlite-vec-darwin-x64` and `sqlite-vec-windows-x64`, so an arm64 Mac installs those too. FFmpeg for all three platforms comes from `pnpm vendor:ffmpeg --all`.

The packaged app already skips the workspace `.env` and the dev trace window.

Startup checks and failure reasons go to a local log, outside the library. macOS writes `~/Library/Logs/Loom/main.log`. Windows writes `%APPDATA%\Loom\logs\main.log`. A file rotates past 1 MB. Only `main.log`, `main.log.1`, and `main.log.2` are kept. Opening a library adds a `sqlite-vec` line with the loaded version, or the load error.

## Windows sandbox

The NSIS installer is per-user. Development installs the sandbox from [ensure-windows-sandbox.mjs](../scripts/ensure-windows-sandbox.mjs) during `pnpm install`. A packaged app has no postinstall, so on Windows, with the sandbox setting on, startup calls `ensureWindowsSandboxInstalled` and runs the same check, which asks for administrator consent. An existing install is left alone. Cancelling uses the existing fallback: the sandbox turns off and the reason is saved. macOS uses `sandbox-exec` and needs no extra install.

## Steps

1. This document.
2. electron-builder config and a Mac `dist` that emits every installer above, including unpack rules and the FFmpeg resource copy. Add the command to the README.
3. Assemble production dependencies, including the sqlite-vec packages for darwin-x64 and win32-x64.
4. On a packaged Windows app, install the sandbox at startup when the setting is on.
5. Smoke the local macOS package: open a library, load sqlite-vec, preview a file, and resolve FFmpeg. Open the Windows installer on a Windows machine and check the sandbox consent prompt.
6. CI on one macOS runner produces every installer.
