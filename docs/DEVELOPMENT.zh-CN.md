[English](./DEVELOPMENT.md) | **简体中文**

# 开发

环境要求与启动步骤见[快速开始](../README.zh-CN.md#快速开始)。

## 包边界

- `packages/core` 负责库文件、稳定素材 ID、元数据、关系、检索和媒体处理。`LocalCore` 是领域入口，存储与内部服务不对外公开。根入口导出领域类型、provider 接口及共用的路径和二进制定位工具；调色工具与进程沙箱分别走 `@loom/core/grade`、`@loom/core/sandbox`。
- `packages/agent` 负责每库的对话运行时与 Agent 策略，依赖 `core`。
- `packages/app` 负责 Electron、UI、IPC、设置、凭据、HTTP provider、MCP 连接，以及聊天和工具接线。通过 `LocalCore` 调用领域能力，按 core 接口注入 provider，不直接访问 core 存储。

core 能力和 Agent 运行时都在 Electron 主进程运行。源文件按功能归属组织：

- `agent/src`：`runtime`、`models`、`context`、`extensions`、`tools`、`trace`；根目录保留公开入口、vendor 边界与包级契约。
- `app/src/main`：`desktop`、`chat`、`composer`、`models`、`settings`、`tools`、`mcp`；存储跟随所属功能。
- `app/src/renderer`：所有视觉取值来自 `design/tokens.css`（见[设计系统](./DESIGN.zh-CN.md)）；聊天和素材详情分别放在 `chat`、`details`，共用 UI 控件放在 `components`。`app/src/shared` 存放跨进程契约和纯函数，`preload` 桥接类型化 IPC。

## 检查

在仓库根目录运行：

```sh
pnpm test
pnpm -r typecheck
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
pnpm --filter @loom/app check:node-sqlite
pnpm --filter @loom/app check:chat-platform
```

`pnpm test` 运行工作区各包的测试，安装包发布与网站部署测试单独运行。Electron 自检需要本机 Electron；Chat 平台自检还需要系统凭据加密能力。

端到端测试构建到 `out-e2e/`，与开发应用的 `out/` 分开：

```sh
pnpm --filter @loom/app build:e2e
pnpm test:e2e
pnpm test:e2e e2e/x.spec.ts -g "名称" --repeat-each=20
pnpm test:e2e:attach
```

将 `e2e/x.spec.ts` 和「名称」替换为真实用例；`--last-failed` 可重跑失败项。attach 命令通过 9344 端口连接正在运行的 `pnpm dev`。

真实模型/工具及 SQLite 重开冒烟测试为 `pnpm --filter @loom/agent try:durable`。它需要根目录 `.env` 中的 `LOOM_CHAT_API_KEY` 或 `DEEPSEEK_API_KEY`，并会调用配置的模型服务。

## 构建与发布

`pnpm dist` 在 Mac 上构建 macOS arm64/x64 的 DMG 和 Windows x64 安装包，构建前自动下载三种目标平台的 FFmpeg；也可用 `pnpm vendor:ffmpeg --all` 单独准备这些二进制文件。

带版本号的构建、COS/GitHub 上传和网站更新见[一键发布说明](./RELEASING.zh-CN.md)。网站预览和服务器部署见 [`website/README.md`](../website/README.md)。

## Vendored pi 引擎

Loom 从上游 `v1.4.0`（`4a080252`）引入 pi durable 和 codemode，每个 vendor 目录的 `UPSTREAM` 记录来源。pi-ai、Chord、telemetry 与 codemode 版本统一为 `1.4.0`。`packages/agent/src/durable-adapter.ts` 是 import 边界，Loom 自有代码放在 vendor `src/` 之外。

打开已有库会将 durable SQLite schema v1 升到 v2，以支持休眠任务。旧版 durable 无法打开升级后的数据库。如需保留回退能力，请在首次用新版本打开前关闭 Loom，并备份库内的 `.loom/` 目录。

### 同步上游

`vendor-clean` 保持纯净上游，在该分支同步、提交，再合并到工作分支：

```sh
git switch vendor-clean
pnpm vendor:sync
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi-durable main"
git switch main
git merge vendor-clean
```

`pnpm vendor:sync` 默认同步上游 `main`，可传 ref 参数；脚本拒绝在 `vendor-clean` 之外运行。macOS 用 `rsync` 镜像源码，Windows 用 Node 文件系统操作，排除测试、`testing/` 和 benchmark。同步会删除 vendor `src/` 中的本地新增文件；同一 commit 重复同步不改变内容。

codemode 是保留上游包名与 exports 的私有工作区包，其 `quickjs-wasi` 依赖从 npm 获取。每次同步上游时需要核对外部依赖的兼容性。

### Vendor 检查

```sh
pnpm --filter @loom/agent typecheck:vendor
pnpm --filter @loom/agent test:vendor
pnpm --filter @loom/agent build:vendor
pnpm --filter @loom/agent test:vendor:build
```

源码测试无需预先构建。vendor 构建从 Node 入口开始，先构建 codemode，再构建 durable。编译产物检查通过 `--conditions=loom-vendor-build` 选择 codemode 的 JS exports，开发默认使用源码 exports。
