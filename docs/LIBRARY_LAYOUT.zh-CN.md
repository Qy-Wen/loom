[English](./LIBRARY_LAYOUT.md) | **简体中文**

# 素材库目录结构

> 状态：已实现。Loom 拥有的全部内容都在一个隐藏的 `.loom/` 目录里，库根目录只剩用户素材。这些路径只由 `LibraryPaths` 决定。

## 目标结构

```
<library>/                        -- 用户所有；Loom 不强加结构
├── （用户素材）
├── Inbox/                        -- 输入框导入；普通目录，会被索引
├── outputs/                      -- 工具默认输出；普通目录，会被索引
│
└── .loom/                        -- Loom 拥有的全部内容；不被索引
    ├── metadata-db/
    │   └── metadata.db           -- SQLite：资产、属性、元数据、向量、FTS（含 -wal、-shm）
    ├── graph-db/
    │   └── graph.db/             -- LadybugDB EXPORT 目录
    ├── grades/                   -- 调色拥有的全部内容
    │   ├── records/<assetId>.json    -- 每个调色成品的配方（原 .loom/grades/*.json）
    │   └── luts/*.cube               -- 从库外导入的 LUT（原 .loom/cache/luts/）
    └── agents/                   -- 原 <library>/.agents/
        ├── sessions/
        │   └── loom.sqlite       -- 原 .loom/loom.sqlite（含 -wal、-shm）
        ├── command-allows/
        │   └── command-allows.json   -- 原 .loom/command-allows.json
        ├── skills/               -- SKILL.md 目录
        ├── memory/MEMORY.md
        ├── traces/telemetry.sqlite   -- 仅开发模式
        └── tool-results/<conversationId>/<taskId>.txt
```

`skills/`、`memory/`、`traces/`、`tool-results/` 名称和内容不变，只是随父目录一起移动。

## 变更

| 项目 | 原位置 | 新位置 |
| --- | --- | --- |
| 资产索引 | `.loom/metadata.db` | `.loom/metadata-db/metadata.db` |
| 关系图 | `.loom/graph.db/` | `.loom/graph-db/graph.db/` |
| Agent 目录 | `.agents/` | `.loom/agents/` |
| Durable 存储 | `.loom/loom.sqlite` | `.loom/agents/sessions/loom.sqlite` |
| 记住的命令 | `.loom/command-allows.json` | `.loom/agents/command-allows/command-allows.json` |
| 调色记录 | `.loom/grades/<assetId>.json` | `.loom/grades/records/<assetId>.json` |
| 导入的 LUT | `.loom/cache/luts/` | `.loom/grades/luts/` |
| 调色临时文件 | `.loom/cache/grade-preview/`、`grade-frames/` | 系统临时目录，不在库内 |
| `thumbnails/` | `.loom/thumbnails/` | 删除 |
| `cache/` | `.loom/cache/` | 删除 |

`thumbnails/` 从未被写入：渲染层直接显示原文件。`cache/` 里只有调色相关文件，其中 `luts/` 是调色记录引用的用户数据，不是缓存。调色记录和 LUT 归到 `grades/` 下，调色只有一个所有者目录。预览用的临时文件（ffmpeg 抽出的静帧）离开库，改放系统临时目录：崩溃不会在用户的素材库里留下文件，也由系统负责清理。

库根目录不再有第二个保留目录，`.agents` 变成用户可以随意使用的普通名字。

## 代码影响

- **路径只由一处决定。** `LibraryPaths.metadataDb` 和 `graphDb` 指向新位置，并新增 `agents`、`sessionsDb`、`commandAllows`、`skills`、`memory`、`traces`、`toolResults`，用 `gradeRecords`、`gradeLuts` 取代 `grades`，并删除 `thumbnails` 和 `cache`，把写死的 `".agents"` / `".loom"` 拼接都换掉。目前分散在：
  - `agent/src/runtime/library-runtime.ts`（两处）
  - `agent/src/extensions/library-skills.ts`（`LIBRARY_SKILLS_DIR`）
  - `agent/src/extensions/library-auto-memory.ts`
  - `agent/src/trace/trace-store.ts`
  - `agent/src/tools/tool-result-storage.ts`
  - `app/src/main/settings/command-allow-store.ts`
  - `core/src/library/library.ts`（打开库时创建 `.agents/memory`）
  - `core/src/stores/sqlite.ts`（`mkdir(paths.loom)` 要改为创建 `metadata-db/`）和 `core/src/stores/ladybug.ts`（已经会创建 `dirname(graphDb)`；它的 `graph.db.tmp` 暂存目录仍与 `graph.db` 并列）
  - `core/src/media/service.ts` 和 `core/src/local-core.ts`（调色临时文件、LUT 导入、`grade/store.ts` 的调用方）。临时文件放在每个媒体服务各自的私有目录里，首次使用前用 `mkdtemp(join(os.tmpdir(), "loom-grade-"))` 创建（不要用 `/tmp` 这类固定路径，沙盒不能写）。不要写死 `/tmp`；`os.tmpdir()` 会跟随 `TMPDIR`/`TEMP`，macOS 上通常是 `/var/folders/.../T`。进程沙盒本来就允许读写 `canonical(tmpdir())`。媒体服务关闭时删除整个目录，不能只靠内存里的抽帧表。开启沙盒后要实测一次：macOS 和 Windows 上 ffmpeg 都能往这个目录写 jpg
- **忽略规则。** `.loom/` 已经覆盖全部内容。删除 `isAgentsPath`；从 `isIgnoredPath`、`library.ts` `placeOnePath` 的保留名、`app/src/main/index.ts` 的 `containedLibraryPath` 里去掉 `.agents`。保留 `.loom` 与 `.DS_Store`。
- **模型可见的路径。** 工具结果预览和技能目录会显示库内路径，改为 `.loom/agents/...`。需确认 `read` 与进程沙盒允许读取 `.loom/` 内的文件。
- **沙盒。** `bash`、`ffmpeg`、`ffprobe` 本来就能写整个库，也就能写 `.loom/`。把技能和记忆移进去不增加新的暴露面，但 Agent 现在通过同一条路径也能碰到 `metadata.db` 和 `loom.sqlite`，这点和以前一样。
- **跨平台。** 一律用 `path.join`。打开任何存储前先创建好父目录。

## 迁移

不迁移。新版本只读写新路径，从不碰旧路径。已有的库打开时等同于新库：

- `.loom/metadata-db/` 新建为空，文件会重新建立索引。资产 ID 会重新生成，只存在旧 `metadata.db` 里的内容全部丢失：收藏、标签、自定义属性，以及资产关系（旧的 `graph.db`）。
- 聊天历史、技能、记忆、记住的命令和调色记录在新路径下找不到。
- 旧的 `.agents/`、`.loom/loom.sqlite*`、`.loom/command-allows.json`、`.loom/metadata.db*`、`.loom/graph.db/`、`.loom/grades/*.json` 和 `.loom/cache/` 原样保留，不会被删除。用户想要的话，可以在 Loom 关闭时手动搬过去。搬 `metadata.db` 要连同 `-wal` 和 `-shm` 一起搬；调色记录的 `lut` 字段仍指向旧的 `.loom/cache/luts/` 路径。
- 旧版本读不了新版本写过的库：它会看到一个空的 `.loom/loom.sqlite`。首次用新版本打开前，请备份 `.loom/` 和 `.agents/`。

## 需要同步的文档与测试

- 文档：PRODUCT §3.1 和 §3.2、SETTINGS（若 `config.json` 已无用就删掉相关说明）、`agent/AGENT`、`agent/MEMORY`、`agent/TRACE`、`agent/PERMISSION`、README，各有中英文两份。
- 测试：`core/tests/library-paths.test.ts`、`core/tests/library.test.ts`（两者都断言了 `.loom/metadata.db`）、`agent/tests/{library-skills,tool-result-storage,durable-trace,trace-recorder}.test.ts`、`agent/vendor-tests/library-runtime.test.ts`、`app/tests/{command-allow-store,ag-ui-adapter}.test.ts`、`app/e2e/smoke.spec.ts`，以及调色记录和 LUT 导入相关的测试。
