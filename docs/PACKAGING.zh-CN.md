[English](./PACKAGING.md) | **简体中文**

# 打包

做成 macOS 和 Windows 的安装包。electron-builder 打包现有的 `electron-vite build` 产物。在 Mac 上运行 `pnpm dist`，打出下面的全部安装包。

## 产物

| 目标 | 安装包 |
| --- | --- |
| macOS arm64、macOS x64 | `.dmg` |
| Windows x64 | 当前用户的 NSIS 安装程序 |

平台和捆绑的 FFmpeg 一致：`darwin-arm64`、`darwin-x64`、`win32-x64`。`.dmg` 用 macOS 的磁盘工具生成，所以 `dist` 在 Mac 上跑，同一次打出 Windows 的 NSIS 安装程序。签名、公证和自动更新留到对外发布。

应用 id 是 `com.loom.app`，和 Windows 任务栏用的是同一个。产品名是 `Loom`。安装后的应用使用自己的用户数据目录。

## 包里有什么

`out/` 放进 asar。下面这些要留成真实文件，因为会按路径加载：

- `better-sqlite3` 和 sqlite-vec 的可加载扩展
- `@silvia-odwyer/photon-node` 和 `@ladybugdb/wasm-core`，以及它们在拆包后还要 `require` 的包（`threads`、`uuid` 和这条链上的其余包）
- `@anthropic-ai/sandbox-runtime`，包括 `vendor/srt-win`，以及它在拆包后要 `require` 的包

`srt-win.exe` 和 sqlite-vec 扩展的路径从包内算出来。路径落在 `app.asar` 里时，改写成 `app.asar.unpacked` 下的同一相对路径。

该平台的 FFmpeg 从 `packages/core/vendor/ffmpeg/<platform>-<arch>/` 复制到 `resources/ffmpeg/`。[binaries.ts](../packages/core/src/media/binaries.ts) 已经在那里找 `ffmpeg` 和 `ffprobe`。

`@loom/core` 和 `@loom/agent` 打进主进程。只有 `@loom/app` 的依赖会留在包外。构建之后，`out/main` 里每个运行时 `require` 都是 app 依赖。生产依赖在仓库里装好再交给 electron-builder。

`better-sqlite3` 已经带了 `darwin-arm64`、`darwin-x64` 和 `win32-x64` 的预编译文件。Photon 和 Ladybug 是 wasm。`srt-win.exe` 已经在 `sandbox-runtime` 里。sqlite-vec 每个平台一个可选包。pnpm 的 `supportedArchitectures` 包含 darwin、win32、arm64 和 x64，`@loom/app` 直接依赖 `sqlite-vec-darwin-x64` 和 `sqlite-vec-windows-x64`，这样在 arm64 Mac 上也会装上这两份。三个平台的 FFmpeg 用 `pnpm vendor:ffmpeg --all` 一次下齐。

打包后的应用已经会跳过仓库里的 `.env`，也不带开发用的 trace 窗口。

启动检查和失败原因写在本机日志里，不进素材库。macOS 是 `~/Library/Logs/Loom/main.log`，Windows 是 `%APPDATA%\Loom\logs\main.log`。单个文件超过 1 MB 就轮转，只保留 `main.log`、`main.log.1`、`main.log.2`。打开素材库后会有一行 `sqlite-vec`，带上加载到的版本，加载失败则是失败原因。

## Windows 沙箱

NSIS 安装程序按当前用户安装。开发时由 [ensure-windows-sandbox.mjs](../scripts/ensure-windows-sandbox.mjs) 在 `pnpm install` 里安装。打包后的应用没有这一步，所以 Windows 上沙箱开关打开时，启动调用 `ensureWindowsSandboxInstalled`，做同一次检查并请求管理员权限。已经装好则跳过。用户取消则沿用现有降级：关掉沙箱并记下原因。macOS 用 `sandbox-exec`，不需要额外安装。

## 步骤

1. 本文。
2. 加上 electron-builder 配置，以及在 Mac 上打出上面全部安装包的 `dist`，包含拆包规则和 FFmpeg 资源复制。把命令写进 README。
3. 装好生产依赖，包括 darwin-x64 和 win32-x64 的 sqlite-vec 包。
4. 打包后的 Windows 应用在沙箱开关打开时，于启动时安装沙箱。
5. 本机冒烟 macOS 包：打开素材库、加载 sqlite-vec、预览文件、解析 FFmpeg。在 Windows 上打开 Windows 安装包，并检查沙箱的权限提示。
6. CI 用一个 macOS runner 打出全部安装包。
