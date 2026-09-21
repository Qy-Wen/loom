[English](./README.md) | **简体中文**

# Loom

Local-first AI creative workspace —— 一个把「文件系统作事实源、数据库作认知层、Agent 作操作层」的创意资产客户端。

设计文档见 [`docs/`](./docs)：产品 [PRODUCT.md](./docs/PRODUCT.zh-CN.md)、Agent 方案 [AGENT.md](./docs/AGENT.zh-CN.md)、待办 [TODO.md](./docs/TODO.zh-CN.md)。

## 开发

```bash
pnpm install
pnpm dev                              # Electron 客户端（需 .env 里的 DEEPSEEK_API_KEY）
pnpm --filter @loom/agent try:agent   # 冒烟测试：跑通一轮 agent loop
pnpm test                            # 全部单元 / 集成测试
pnpm -r typecheck
```

## Vendor：pi agent 引擎

Loom 的 agent 内核**源码级 vendor** 自 [pi](https://github.com/earendil-works/pi) 的 `packages/agent`，放在 `packages/agent/vendor-pi-agent/`。业务代码只通过 `packages/agent/src/pi-adapter.ts`（唯一 `#vendor/pi-agent` 入口）使用它。完整方案见 [docs/AGENT.md](./docs/AGENT.zh-CN.md)。

### 同步 / 升级上游

**心智模型**：`vendor-clean` 分支始终是上游唯一真相（只放未魔改的 pi 源码），`main` 通过 `git merge` 从它获得 vendor；所有魔改只在 `main` 上做。

**同步脚本**（`packages/agent/vendor-pi-agent/sync.sh`）：按 ref 从 GitHub 浅克隆到临时目录，`rsync --delete` 镜像覆盖 `vendor-pi-agent/src/`，把上游 `repo/directory/ref/commit` 记进 `UPSTREAM`。无需本地 pi 仓库；对同版本幂等（不写时间戳）。

```bash
# 首次：从已含 vendor 的提交分出普通分支（与 main 有共同祖先）
git branch vendor-clean

# 升级上游（固定四步）：
git checkout vendor-clean                             # 1. 回纯净分支
pnpm --filter @loom/agent vendor:sync v0.86.0         # 2. 拉新版镜像覆盖
git commit -am "vendor: pi-agent v0.86.0 (pristine)"  #    （同版本无改动时跳过）
git checkout main                                     # 3. 回主线
git merge vendor-clean                                # 4. 三方合并：上游改动 vs 魔改，只在真冲突处停下
```

**两条约束**（否则会丢魔改）：

1. `sync` 是 `rsync --delete` 镜像覆盖、不做合并——**只在 `vendor-clean` 上跑**（该分支本就只有纯上游，覆盖不丢东西）。
2. 魔改只在 `main` 做；自己新增的代码放业务层 `packages/agent/src/`，别塞进 `vendor-pi-agent/src/`（下次 sync 会被 `--delete` 删掉）。

**外部依赖**：vendor 的 agent 需要 `@earendil-works/{pi-ai,chord,pi-telemetry}`（及 `diff`/`ignore`/`typebox`/`yaml`），作为 `@loom/agent` 的 npm 依赖，版本对齐 `UPSTREAM` 记录的 pi 版本。
