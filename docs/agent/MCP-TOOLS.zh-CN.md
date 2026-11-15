# Agent 工具清单与 MCP 暴露

核对日期：2026-11-15。已实现本地 MCP 服务，与内置 Agent 共用业务工具目录和执行器。内置 Agent 使用自身权限等级；MCP 的工具审批由外部客户端管理，工具清单提供只读、破坏性及外部访问提示供其参考。

- `?` 表示可选；其他参数必填；`{}` 表示无业务参数。
- 「是」：已暴露；「否」：不暴露。
- 内置 Agent 固定 38 个工具，MCP 暴露其中 31 个；另有最多 2 个联网工具与动态第三方工具。Shell 按系统二选一。

在「设置 → 外部访问」启用服务，复制连接配置到支持 Streamable HTTP 的 MCP 客户端。默认端口 `19441`，仅监听 `127.0.0.1`。令牌默认留空，不启用鉴权；可手动填写或点击「自动生成」，保存后请求需携带 `Authorization: Bearer <token>`。清空令牌并保存即可关闭鉴权。非空令牌用系统凭据加密能力保存；修改服务配置会断开旧连接。复制配置会应用当前修改，未启用鉴权时不包含认证头。Loom 和素材库必须保持打开；切库后重新连接。调用记录与停止入口在同页，MCP 调用不触发 Loom 内的审批。

## 当前 Agent 工具

### 文件与命令

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `read` | `path: string; offset?: number; limit?: number` | 读取文本或图片。offset 从第 1 行开始；文本最多展示 2,000 行或 50 KiB。 | 否 |
| `edit` | `path: string; edits: Array<{ oldText: string; newText: string }>` | 精确替换文本。至少一个替换，匹配原文的唯一、不重叠区域；返回差异。 | 否 |
| `write` | `path: string; content: string` | 创建或覆盖文本文件，自动创建父目录。 | 否 |
| `bash` | `command: string; timeout?: number` | macOS 命令执行，工作目录为素材库。timeout 单位秒，省略不设默认超时。 | 否 |
| `powershell` | `command: string; timeout?: number` | Windows 命令执行，其余参数与 Bash 相同。 | 否 |

通用文件操作和命令执行交给外部 Agent 自身工具；库内内容读取使用 `read_asset`。内置文件工具支持相对 / 绝对路径；Shell 超时必须为有限正数，不超过 `2147483647 / 1000` 秒。

### 素材检索与理解

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `search_assets` | `SearchArgs` | 普通关键词检索或按条件列出素材，不调用模型、不要求索引。返回 total、assets。 | 是 |
| `deep_search_assets` | `SearchArgs（query 必填）` | 对已索引内容做全文 / 语义检索，可选 Rerank；返回片段与 indexedCount，看不到未索引素材。 | 是 |
| `inspect_asset` | `assetId: string` | 读取元数据、属性、标签、收藏、关系、媒体描述与索引状态；不返回源文件全文。 | 是 |
| `embed_asset` | `assetId: string; force?: boolean = false` | 为 .md/.txt/.csv/.json 或已有描述的媒体分块并建立索引；当前索引默认跳过，force 强制重建。 | 是 |
| `describe_image` | `assetId: string` | VLM 图片描述与标签；支持 JPEG/PNG/WebP/BMP/GIF，GIF 使用首帧。 | 是 |
| `describe_video` | `assetId: string` | VLM 视频描述与标签；优先原生视频，否则抽帧。 | 是 |
| `describe_audio` | `assetId: string` | Audio 描述、标签及可能的转录，包含音乐与环境声；支持 AAC/FLAC/M4A/MP3/OGG/WAV。 | 是 |

`SearchArgs` 完整结构见文末。`assetId` 必须非空。媒体理解与索引使用 Loom 的模型设置，可能产生服务费用，返回执行状态。

### 调色与媒体处理

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `grade_image` | `GradeImageArgs` | 静态图片旋转、镜像、裁剪、调色及 LUT，写出新素材并保存配方。完整参数见文末。 | 是 |
| `run_ffmpeg` | `args: string[]` | 使用 Loom 自带 FFmpeg 抽帧、剪辑、缩放、转码等，数组不含程序名。 | 是 |
| `run_ffprobe` | `args: string[]` | 使用 Loom 自带 ffprobe 读取时长、尺寸、编码和流信息，数组不含程序名。 | 是 |

调色支持 JPEG/PNG/WebP/GIF/BMP/TIFF；GIF 首帧输出 PNG。媒体工具不自动建关系，需另调 `create_relation`。MCP 与内置 Agent 使用相同的媒体工具实现，支持相对和绝对路径，不增加外部专属的路径或 FFmpeg 参数限制。`run_ffmpeg` 可显式传入 `-y` 覆盖已有输出；`grade_image` 沿用核心行为，不覆盖已有文件。

### 标签与收藏

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `list_tags` | `{}` | 列出全部标签及使用数量，按使用次数排序。 | 是 |
| `add_tag` | `assetId: string; name: string` | 为素材添加标签；忽略大小写，最多 64 字符，不存在则创建，重复添加无变化。 | 是 |
| `remove_tag` | `assetId: string; name: string` | 从素材移除标签；没有文件使用时标签消失，返回 removed 和最新标签。 | 是 |
| `set_favorite` | `assetId: string; favorite: boolean` | 设置或取消收藏，相同状态无变化。 | 是 |

### 素材关系

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `create_relation` | `fromAssetId: string; toAssetId: string; type: string` | 创建有向关系，返回关系记录。派生文件指向源文件；type 最多 64 字符，RELATED 保留。 | 是 |
| `remove_relation` | `relationId: string` | 按关系 ID 删除，ID 来自创建结果或素材详情。 | 是 |

### 属性列与单元格

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `list_properties` | `{}` | 列出属性列的 propertyId、name、type。 | 是 |
| `create_property` | `name: string; type: PropertyType` | 新增属性列，列名忽略大小写唯一。 | 是 |
| `update_property` | `propertyId: string; name: string; type: PropertyType` | 修改名称或类型，三个字段均必填；已有单元格值时不能改类型。 | 是 |
| `remove_property` | `propertyId: string` | 删除属性列及其全部单元格值。 | 是 |
| `set_asset_property` | `assetId: string; propertyId: string; value: PropertyValue` | 设置一个单元格，值须符合列类型。 | 是 |
| `clear_asset_property` | `assetId: string; propertyId: string` | 清空一个单元格，保留属性列。 | 是 |

`PropertyType`：`text/number/boolean/date`；`PropertyValue`：字符串、数字或布尔值。日期使用 `YYYY-MM-DD` 字符串。

### 设置与记忆

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `get_settings` | `chatProvider?: string` | 读取脱敏设置；传服务商 ID 获取其 Chat 模型目录，不返回密钥。 | 是 |
| `update_settings` | `SettingsPatch` | 增量修改语言、Chat 服务商、模型槽、沙箱、指令和 MCP；完整嵌套参数见文末。 | 是 |
| `auto_memory` | `action: "add" / "replace" / "remove"; content?: string; old_text?: string` | 保存库级事实或偏好。add 需要 content；replace 需要 content、old_text；remove 需要 old_text。外部 Agent 管理自己的记忆，不通过 MCP 暴露。 | 否 |

记忆 `old_text` 必须唯一匹配旧条目子串；禁止 `§`，总量最多 2,000 个 Unicode 字符（含分隔符）。返回当前磁盘记忆，已有会话仍使用创建时的快照。

### 子 Agent

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `run_retrieve_agent` | `goal: string` | 独立上下文检索，具备 read/search_assets/deep_search_assets/inspect_asset，不修改文件。 | 否 |
| `run_create_agent` | `goal: string` | 独立上下文创作，具备文件 / Shell、inspect_asset、调色、FFmpeg 和已连接 MCP 工具；不提供素材搜索。 | 否 |

`goal` 必须非空且自包含，所需素材 ID 写入任务。返回摘要与素材引用 / 产物路径；子 Agent 使用 Loom 的 Chat 模型，共用权限和任务生命周期。

两个工具仅供内置 Agent 使用；外部 Agent 自行管理子 Agent 与任务委派，不通过 MCP 暴露。

### 联网与第三方 MCP

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `web_search` | `query: string; count?: integer = 8` | 联网搜索，返回标题、URL、摘要。当前 DeepSeek：query 为 1–128 个 Unicode 字符，count 为 1–50。 | 否 |
| `web_fetch` | `url: string` | 抓取网页正文；HTTP(S) URL 最长 8,192 字符，不携带用户名或密码。 | 否 |
| `<serverId>__<toolName>` | `原服务的 inputSchema` | 已连接的第三方 MCP 工具，仅供内置 Agent 使用，不通过 Loom MCP 转发；参数与介绍来自原服务 tools/list。 | 否 |

联网工具仅在开关开启且配置可用服务时注册，当前使用 DeepSeek；web_fetch 还要求服务商支持抓取。第三方工具清单与参数随实际连接变化，外部客户端需直接连接对应服务。

## 素材库与文件管理工具

以下 7 个工具已注册，供内置 Agent 与 MCP 共用。

### 素材库与文件管理

| 工具 | 参数 | 介绍 | MCP 是否暴露 |
| --- | --- | --- | --- |
| `get_library` | `{}` | 返回绑定库的 libraryId、name、rootPath、folders、capabilities；无已打开库时返回错误，不切换库。 | 是 |
| `read_asset` | `assetId: string; view?: "content" / "thumbnail" = "content"; offset?: integer = 1; limit?: integer = 200` | 按素材 ID 读文本 / 图片或图片、视频缩略图。offset >= 1，limit 为 1–2000，仅用于文本；文本上限 50 KiB，返回截断与续读位置。 | 是 |
| `rename_asset` | `assetId: string; stem: string` | 同目录重命名，stem 不含扩展名，保留原扩展名和素材 ID；返回更新后的素材。 | 是 |
| `move_assets` | `assetIds: string[]; destFolder: string` | 非空 ID 数组，移入已存在目录；根目录为 ""。返回逐项结果及最终路径，允许部分成功。 | 是 |
| `create_folder` | `parentRelativePath: string; name: string` | 在已存在父目录下创建目录；根目录为 ""，返回 relativePath。 | 是 |
| `rename_folder` | `relativePath: string; name: string` | 重命名目录并更新子素材路径，不允许修改库根；返回 relativePath。 | 是 |
| `move_folder` | `sourceFolder: string; destFolder: string` | 把源目录移入目标目录，禁止移动库根、移入自身或后代；返回 relativePath。 | 是 |

目录使用库内相对路径和 `/`；名称为单个有效名称。移动遇同名按核心规则生成可用名，显式重命名冲突则拒绝；批量移动最多 100 个不同 ID。`get_library.libraryId` 当前使用库根路径。`read_asset` 不传输整个视频 / 音频，不接受任意路径；文本输入最多 32 MiB、单次返回最多 50 KiB。PNG/JPEG/WebP 原图最多 5 MiB，GIF、其他图片与大图返回静态缩略图。

连接绑定明确素材库，切库后重新连接。共用核心、参数校验、已启用的进程沙箱和任务机制；内容返回标准 MCP 文本 / 图片与结构化业务数据，`inspect_asset` 的 Electron 预览引用替换为 `read_asset` 提示。MCP 不受内置 Agent 的 Basic／Standard／Full 等级控制；工具审批由调用方负责，各工具保留核心自身的业务规则。设置工具作用于应用级配置，影响所有素材库；第三方 MCP 工具不转发。支持协议取消和本地停止；已完成的部分操作不会回滚，请查看调用记录和素材库后再决定是否重试。每次最多 16 个连接、16 个在途调用，空闲连接 30 分钟过期；最近 100 条调用记录保存在内存中，关闭服务或重启后不作持久审计。

## 参数定义

### SearchArgs

```ts
type AssetType = "image" | "video" | "audio" | "text" | "other";
type PropertyValue = string | number | boolean;
type PropertyFilter = {
  name: string; // 属性列名，忽略大小写
  operator: "eq" | "contains" | "gte" | "lte";
  value: PropertyValue;
};
type SearchArgs = {
  query?: string;
  type?: AssetType;
  properties?: PropertyFilter[];
  tags?: string[];
  favorite?: boolean;
  limit?: number;
};
```

`query` 仅对 `deep_search_assets` 必填且非空，当前 Schema 已声明必填。`limit` 默认 20，范围 1–100。`tags` 为全部匹配、忽略大小写；`favorite` 省略不筛选，false 仅未收藏。

### GradeImageArgs

| 参数 | 类型 | 必填 | 说明、有效范围与默认值 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 输入图片路径。 |
| `output` | `string` | 否 | 输出路径；省略时由核心生成。 |
| `rotation` | `integer` | 否 | 顺时针四分之一圈数：`0/1/2/3`；默认 0。 |
| `flipH` / `flipV` | `boolean` | 否 | 旋转后的水平 / 垂直镜像；默认 false。 |
| `crop` | `{ x?: number; y?: number; w?: number; h?: number }` | 否 | 旋转、镜像后的归一化裁剪区域，坐标 0–1；省略为整幅 `{ x: 0, y: 0, w: 1, h: 1 }`。 |
| `exposure` | `number` | 否 | 曝光 EV，-3–3；默认 0。 |
| `brightness` | `number` | 否 | 亮度，-1–1；默认 0。 |
| `lightness` | `number` | 否 | 明度，-1–1；默认 0。 |
| `hue` | `number` | 否 | 色相偏移角度，-180–180；默认 0。 |
| `contrast` | `number` | 否 | 对比度，0–2；默认 1。 |
| `saturation` | `number` | 否 | 饱和度，0–3；默认 1。 |
| `vibrance` | `number` | 否 | 自然饱和度，-2–2；默认 0。 |
| `temperature` | `number` | 否 | 色温，1,000–40,000 K；默认 6,500。 |
| `black` / `white` | `number` | 否 | 输入黑 / 白场，0–1；默认分别为 0 / 1。 |
| `curves` | `{ rgb?: Point[]; r?: Point[]; g?: Point[]; b?: Point[] }` | 否 | `Point = { x: number; y: number }`，每个点两字段均必填、范围 0–1；省略通道保持恒等曲线。核心归一化最多保留 16 个点。 |
| `lut` | `string` | 否 | 素材库相对路径的 `.cube` 文件，最后应用。 |

范围由核心归一化，未全部写入当前 Schema。输出省略时由核心生成；crop 省略为整图，各通道曲线省略为恒等曲线。

### SettingsPatch

下列字段直接作为 `update_settings` 参数；省略表示不修改，至少一处有效修改。

```ts
type SettingsPatch = {
  language?: "system" | "en" | "zh-CN";
  chat?: {
    upsert?: ChatProviderPatch[];
    remove?: string[]; // 配置的服务商 ID
    refresh?: boolean; // 刷新支持的目录，不是连接测试
  };
  models?: {
    embedding?: ModelSlotPatch;
    rerank?: ModelSlotPatch;
    vlm?: ModelSlotPatch;
    audio?: ModelSlotPatch;
  };
  sandbox?: boolean;
  instructions?: string;
  mcp?: { upsert?: McpServerPatch[]; remove?: string[] };
};
type ModelSlotPatch = {
  requestUrl?: string;
  model?: string;
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean; // 执行时如提供，只接受 true
};
type McpServerPatch = {
  id: string;
  transport?: "stdio" | "http";
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};
```

新增 MCP 配置需 transport；stdio 需 command，HTTP 需 url。API Key 只写不读；参数可能留在会话记录，优先使用设置界面输入。

### ChatProviderPatch

SettingsPatch.chat.upsert 的完整参数：

```ts
type ChatApi = "openai-completions" | "openai-responses"
  | "anthropic-messages" | "google-generative-ai";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Generation = {
  maxTokens?: number; // 正整数，至多 Number.MAX_SAFE_INTEGER
  temperature?: number; // 0–2
  samplingParams?: Record<string, unknown>; // JSON 对象
  cacheRetention?: "none" | "short" | "long";
};
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number }; // 均 >= 0
type Cost = Rates & { tiers?: Array<Rates & { inputTokensAbove: number }> }; // 阈值为正整数
type ModelMetadata = {
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">; // 非空、无重复，包含 text
  contextWindow?: number; // 正整数
  maxTokens?: number; // 正整数
  cost?: Cost;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Partial<Record<ThinkingLevel, Record<string, unknown>>>;
  generation?: Generation;
};
type CustomModel = ModelMetadata & {
  id: string;
  api?: ChatApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};
type ChatProviderPatch = {
  id: string; // 小写 ID，匹配 ^[a-z0-9][a-z0-9._:-]*$
  kind?: "builtin" | "custom";
  name?: string;
  clearName?: true;
  enabled?: boolean;
  requestUrl?: string;
  baseUrl?: string;
  api?: ChatApi;
  models?: CustomModel[];
  modelEnabled?: Record<string, boolean>;
  modelOverrides?: Record<string, ModelMetadata>;
  generation?: Generation;
  headers?: Record<string, string>; // header 名 -> 加密凭据引用 ID，不是明文 header 值
  allowUnauthenticated?: boolean;
  apiKey?: string;
  clearApiKey?: true;
};
```

- 新增自定义服务商需 kind=custom、models 和 requestUrl，或 baseUrl + api；requestUrl 与 baseUrl/api 互斥，仅用于自定义服务商。
- models 替换自定义模型列表；modelEnabled 按 ID 合并；modelOverrides 用于内置服务商。不能同时更新和移除同一服务商，不能更改已有 kind。
- apiKey / clearApiKey、name / clearName 分别互斥。清除 API Key 不清除 OAuth 或环境变量；移除服务商配置保留加密凭据。
- 不提供 OAuth 登录、不改变已有会话的模型与思考强度。instructions 后续生效；更换模型后不会自动重建描述或索引。

## 代码来源

- [业务工具目录](../../packages/app/src/main/tools/)：检索、媒体、标签、关系、属性与设置。
- [工作区工具](../../packages/agent/src/tools/pi-tools.ts)、[vendor 文件工具](../../packages/agent/vendor-pi-durable/src/tools/)、[子 Agent](../../packages/agent/src/extensions/specialist.ts)、[记忆](../../packages/agent/src/extensions/library-auto-memory.ts)。
- [联网工具](../../packages/app/src/main/tools/web-tools.ts)、[第三方 MCP 适配](../../packages/app/src/main/mcp/tools.ts)、[权限规则](./PERMISSION.zh-CN.md)。
