# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.md)，Agent 方案见 [AGENT.md](./AGENT.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：vendor pi-agent，纯 Node 跑通一轮 agent loop ✅

先消掉最大不确定性：把 pi 的 agent 引擎源码级引入，喂一句话跑通一轮 tool calling。
不碰 Electron / UI / DB。

- [x] 建 pnpm workspace，`@loom/agent` 一个包
- [x] `vendor-pi-agent/`（在 `@loom/agent` 包内）+ `sync.sh`，同步 pi `packages/agent` @ `v0.85.1`，写 `UPSTREAM`
- [x] npm 装 `@earendil-works/{pi-ai,chord,pi-telemetry}` + `diff`/`ignore`/`typebox`/`yaml`（版本对齐 0.85.1）
- [x] `tsconfig.base.json` 对齐 pi 编译开关（`.ts` 后缀 import / 装饰器 / Node16）
- [x] vendor 引用用 node `imports` 字段 `#vendor/pi-agent`（typecheck + 运行时都认，非 TS 路径别名）
- [x] `src/{types.ts, pi-adapter.ts}`：`LoomAgent` 接口 + 唯一 vendor 入口
- [x] `scripts/try-agent.ts`：DeepSeek + echo 工具 + 订阅打印事件
- [x] 跑通：`agent_start → tool_start → tool_end → text → agent_end`

> 实测：DeepSeek 模型 id 是 `deepseek-v4-flash`（provider `deepseek`，读 `DEEPSEEK_API_KEY`）。

## 第二步：Electron 骨架 + 三层解耦

把 agent 引擎挂进 Electron 外壳，立起三层架子。

- [ ] 加 `@loom/app`（Electron 客户端）包
- [ ] 三层解耦：Renderer / Main / LocalCore + 类型化 IPC（Renderer 不碰 DB）
- [ ] `MetadataStore` / `GraphStore` 接口，先用内存 stub
- [ ] Library / LibraryPaths / LibraryWatcher（chokidar，忽略 `.loom/`）
- [ ] React 三栏 UI 骨架（File Tree / Preview / Properties + 底部 Agent 栏）
- [ ] agent 事件经 `AgUiTranslator` → 前端展示
- [ ] typecheck / build 全通过

## 第三步：SQLite MetadataStore

用 better-sqlite3 实现 `MetadataStore` 接口，替换内存 stub。

- [ ] 建表：`assets`、`properties`、`asset_properties`
- [ ] 实现增删改查（upsert / get / remove / list）
- [ ] 数据库文件落在库根目录的 `.loom/metadata.db`

---

## 后续（概述）

- **打通链路**：原生文件夹选择 → 扫描写入 SQLite → 左侧列表 → 中间预览（图/视频/文本）→ watcher 实时更新
- **自定义属性**：用户创建属性字段并赋值，新增 Table 视图（排序/过滤）
- **检索**：FTS 全文检索 + sqlite-vec 向量检索 + 属性过滤，融合成 Hybrid Search
- **富化**：ffprobe/exif/文本提取（本地），Embedding 与 VLM 语义分析（可选、按需）
- **前端协议**：AgUiTranslator 把 AgentEvent 翻成 AG-UI（thinking/富输出先留占位，见 AGENT.md）
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
