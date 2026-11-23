[English](./PACKAGING.md) | **简体中文**

# 打包与发布

做成 macOS 和 Windows 的安装包。electron-builder 打包现有的 `electron-vite build` 产物。在 Mac 上运行 `pnpm dist`，打出下面的全部安装包。`pnpm release` 在此基础上构建安装包，上传相同产物到 COS 与 GitHub，并更新、部署发布网站。

## 打包

### 产物

| 目标 | 安装包 |
| --- | --- |
| macOS arm64、macOS x64 | `.dmg` |
| Windows x64 | 当前用户的 NSIS 安装程序 |

平台和捆绑的 FFmpeg 一致：`darwin-arm64`、`darwin-x64`、`win32-x64`。`.dmg` 用 macOS 的磁盘工具生成，所以 `dist` 在 Mac 上跑，同一次打出 Windows 的 NSIS 安装程序。

应用 id 是 `com.loom.app`，和 Windows 任务栏用的是同一个。产品名是 `Loom`。安装后的应用使用自己的用户数据目录。

### 包里有什么

`out/` 放进 asar。下面这些要留成真实文件，因为会按路径加载：

- `better-sqlite3` 和 sqlite-vec 的可加载扩展
- `@ladybugdb/wasm-core`，以及它在拆包后还要 `require` 的包（`threads`、`uuid` 和这条链上的其余包）
- `@anthropic-ai/sandbox-runtime`，包括 `vendor/srt-win`，以及它在拆包后要 `require` 的包

`srt-win.exe` 和 sqlite-vec 扩展的路径从包内算出来。路径落在 `app.asar` 里时，改写成 `app.asar.unpacked` 下的同一相对路径。

该平台的 FFmpeg 从 `packages/core/vendor/ffmpeg/<platform>-<arch>/` 复制到 `resources/ffmpeg/`。[binaries.ts](../packages/core/src/media/binaries.ts) 已经在那里找 `ffmpeg` 和 `ffprobe`。

`@loom/core` 和 `@loom/agent` 打进主进程。界面用的包打进 `out/renderer`，在 `@loom/app` 里列为开发依赖，不进安装包。主进程运行时要加载的依赖留在包里。Photon 列为 app 的直接依赖，供打包后的图像处理器定位 WASM；它的 JS 仍打进主进程，WASM 由 Electron 从 asar 读取。source map 不进安装包。Ladybug 只留 `nodejs` 这一份。`esbuild` 和已经打进主进程的 `js-tiktoken` 不进安装包。`better-sqlite3` 只留当前平台的预编译文件，不带 C 源码。生产依赖在仓库里装好再交给 electron-builder。

`better-sqlite3` 已经带了 `darwin-arm64`、`darwin-x64` 和 `win32-x64` 的预编译文件。Photon 和 Ladybug 是 wasm。`srt-win.exe` 已经在 `sandbox-runtime` 里。sqlite-vec 每个平台一个可选包。pnpm 的 `supportedArchitectures` 包含 darwin、win32、arm64 和 x64，`@loom/app` 直接依赖 `sqlite-vec-darwin-x64` 和 `sqlite-vec-windows-x64`，这样在 arm64 Mac 上也会装上这两份。三个平台的 FFmpeg 用 `pnpm vendor:ffmpeg --all` 一次下齐。

打包后的应用已经会跳过仓库里的 `.env`，也不带开发用的 trace 窗口。

启动检查和失败原因写在本机日志里，不进素材库。macOS 是 `~/Library/Logs/Loom/main.log`，Windows 是 `%APPDATA%\Loom\logs\main.log`。单个文件超过 1 MB 就轮转，只保留 `main.log`、`main.log.1`、`main.log.2`。打开素材库后会有一行 `sqlite-vec`，带上加载到的版本，加载失败则是失败原因。

### Windows 沙箱

NSIS 安装程序按当前用户安装。开发时由 [ensure-windows-sandbox.mjs](../scripts/ensure-windows-sandbox.mjs) 在 `pnpm install` 里安装。打包后的应用没有这一步，所以 Windows 上沙箱开关打开时，启动调用 `ensureWindowsSandboxInstalled`，做同一次检查并请求管理员权限。已经装好则跳过。用户取消则沿用现有降级：关掉沙箱并记下原因。macOS 用 `sandbox-exec`，不需要额外安装。

## 发布

### 首次配置

1. 在腾讯云 COS 创建专用的 Loom 安装包桶，地域选上海 `ap-shanghai`。桶设为「公有读、私有写」，仅存放公开发布文件。脚本不会创建存储桶。
2. 本机安装 Node.js 22+、pnpm、[GitHub CLI](https://cli.github.com/) 和最新版 [COSCLI](https://cloud.tencent.com/document/product/436/63144)。构建依赖沿用 `pnpm dist`。
3. 执行 `gh auth login` 和 `coscli config init`。COSCLI 配置默认为 `~/.cos.yaml`；使用具有发布桶上传和对象 ACL 权限的凭据。密钥留在本机工具配置中。
4. 复制根目录 `release.config.example.json` 为 `release.local.json`，填完整桶名（例如 `loom-downloads-1250000000`）。地域已设为上海；`publicBaseUrl: null` 会使用 COS 默认 HTTPS 下载域名，也可填写已配置好的自定义 HTTPS 域名。`prefix` 默认 `loom/releases`。
5. 按 [网站部署说明](../website/README.md) 配置 `website/deploy.local.json`，确认 Mac 的 SSH 密钥和主机指纹可用。现有服务器已安装 Loom 路由，只需通过连接预检。

```bash
pnpm install
npm run website:deploy -- --preflight
```

`release.local.json` 和 `website/deploy.local.json` 已被 Git 忽略，不应包含密钥。首次发布前将发布脚本、网站及应用修改提交并推送到 GitHub，再在 Mac 上使用该提交发布。

### 执行发布

先检查计划；此命令不构建、不连接远端，也不修改线上内容：

```bash
npm run release -- --version v0.1.0-alpha.1 --dry-run
```

正式发布（没有 `--dry-run`）：

```bash
npm run release -- --version v0.1.0-alpha.1
```

平时把用户能感知的变化记到 [CHANGELOG.md](../CHANGELOG.md) 和 [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) 的 `## [Unreleased]` 下，每行写一条纯文本列表项。发布前把条目移到两份文件的 `## [vX.Y.Z]` 对应章节，再提交并推送。脚本读取本版条目写入 GitHub Release，官网按访问者选择的语言展示同一批条目。可通过 `--notes path/to/notes.md` 覆盖 GitHub 正文。

带预发布后缀的版本标记为 GitHub prerelease，正式版标记为 latest。应用包的内嵌版本由同一版本参数注入，源码 `package.json` 的版本无需调整。

脚本会：检查源码已提交且提交存在于 GitHub → 预检 COS 与网站 SSH → 构建三个安装包和 `SHA256SUMS` → 准备 GitHub 草稿 → 上传并验证 COS/GitHub 文件 → 发布 GitHub Release → 生成 `website/release-config.js` → 部署并验证网站。

网站的下载链接最后更新；COS 默认开启 CRC64 传输校验，并写入 SHA-256 元数据供重试核对。GitHub 使用资产 digest 校验；旧资产缺少 digest 时下载副本计算 SHA-256。

### 重试与版本

- 中断后使用相同命令、版本、提交和配置重试。`.release-state/<版本>/` 保存构建产物和进度，脚本复用原文件，核对两边已有文件。
- 同版本文件校验不一致时停止，不覆盖已上传的成品。新的应用内容使用新版本号。
- 发布网站失败时，COS 和 GitHub 上已经发布的文件保留，再次执行命令可继续；跨服务发布不是一个原子事务。
- 发布成功后提交生成的 `website/release-config.js`，保持以后普通网站部署使用相同下载地址。
- 普通发布要求工作区干净，允许生成的 `website/release-config.js` 待提交。脚本不会自动提交、推送源码或移动已有 Git 标签。
- `.release-state/publish.lock` 防止同一电脑并发发布。进程被强制结束后，只能在确认没有发布进程运行时移除遗留锁。
- 产物、上传进度和临时验证副本保留在 `.release-state/`；目前不自动清理。

```bash
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
```

### 安装包说明

安装包文件名带版本号（`Loom-0.1.1-mac-arm64.dmg`），所以 `releases/latest/download/<文件名>` 取不到它们。请用 `releases/download/<tag>/<文件名>`，或直接用 `release-config.js` 交给网站的那组链接。

安装包不签名，也不做公证和自动更新。
