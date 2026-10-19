[English](./SETTINGS.md) | **简体中文**

# 设置

> 应用级的模型端点。检索规则见 [TEXT.md](./RAG/TEXT.zh-CN.md)。待办见 [TODO.md](./TODO.zh-CN.md)。
>
> 这里只记结论。

---

## Chat 模型

设置 → Models 的 Chat 区域只有一个外框，与其他四个模型槽位共用滚动条。每个模型只有启用开关，不设置默认模型或思考等级。服务商标题旁用状态点表示鉴权状态，红点悬停显示错误；API 密钥/OAuth、编辑、移除按钮位于模型列表下方。Chat 修改即时保存；凭据用系统加密存于 `chat-credentials.json`，普通读取不返回凭据。明确打开 API 密钥编辑时，通过专用登录提示预填已存或环境密钥，不显示 OAuth token。输入默认掩码，小眼睛切换明文，取消不改变凭据。

“添加服务商”下拉框包含“自定义服务商”。内联编辑器支持名称、完整请求 URL、模型 ID/显示名、模型增删；高级配置声明上下文/输出上限及图片/思考能力。只有“保存服务商”才发布草稿，取消不会创建占位条目。编辑保留服务商身份、凭据与未暴露的元数据。保存后通过独立按钮配置 API 密钥；不校验鉴权的本地服务可使用占位密钥。

自定义 Chat 根据完整 URL 的路径识别协议：`/chat/completions`、`/responses`、`/v1/messages` 或 `/models/{model-id}:streamGenerateContent`。标准路径只显示识别结果，不显示协议下拉框。Loom 提取基础地址，路径拼接、鉴权与流式解析仍由 pi-ai/SDK 负责。Gemini 地址会预填空白的首个模型 ID，调用使用各模型配置的 ID。未知路径可明确切换到 Base URL + 手选协议模式，仍由 SDK 追加路径。不支持的查询参数会报错而非被丢弃；接受原生 `beta=true` / `alt=sse` 标志。

会话输入区的模型菜单选择模型。悬停支持思考的模型或点击右侧箭头，在二级菜单中选择思考强度；键盘右方向键展开，左方向键返回。新会话及尚未选模型的已有会话优先沿用上次启用且可用的选择，否则按配置顺序选第一个启用且可用的文字模型；没有可用模型时留空。已有会话/fork 保存的选择不变。配置与记忆选择存于 `chat-models.json`。首次 `DEEPSEEK_API_KEY` 引导启用原生 DeepSeek，其模型可参与自动选择。见 [CHAT_MODELS](./agent/CHAT_MODELS.zh-CN.md)。

历史编辑框与输入框共用样式和模型/思考强度菜单，默认沿用当前会话模型；修改先保留为草稿，发送时写入新分支，取消不改变原会话模型。权限仍使用当前应用级设置。

## 模型槽位

其余四个槽位（Embedding、Rerank、VLM、Audio）共用一套表单：

一个设置页。每种角色同一套表单。本地和远程字段相同：URL 指本机就是本地；远程供应商是同一套 HTTP，外加 API key。

| 槽位 | 用途 | 报文 |
|---|---|---|
| Text embedding | 文本 RAG 索引 | OpenAI 兼容 `POST /v1/embeddings` |
| Rerank | Hybrid Search 融合后再排一次 | Cohere/Jina `POST /v1/rerank`（`query` + `documents`）。百炼 `qwen3-rerank` 走 `POST .../compatible-api/v1/reranks`。可选。 |
| VLM | 图片 caption / 标签；视频文件级说明 | 和 Chat 一样走 OpenAI 兼容 `POST /v1/chat/completions`。图片用 `image_url`。视频能 native 就带 video 部分；否则 FFmpeg 抽帧再当 `image_url`。只做视觉。 |
| Audio | 音频文件级说明（音乐、环境声，有人声再转写） | OpenAI 兼容 `POST /v1/chat/completions`，消息里带音频部分。托管 Qwen-Omni 发 `input_audio` + `modalities: ["text"]` + `stream: true`。不走 VLM 槽位。 |

每个槽位存：

- `requestUrl`：完整 HTTP(S) **请求 URL**，包含接口路径及可选查询参数。不补版本/路径，不改写地址。例如 `https://…/v1/embeddings`、`https://…/v2/rerank`、`https://…/v1/chat/completions`。
- `apiKey`（远程托管一般要填；本地服务常常不需要）
- `model`
- `enabled`（每个槽位右边的开关）

打开开关会向填写的请求 URL 发一个很小的 POST，不查询 `/models`，不尝试替代路径。Embedding/Rerank 使用各自的请求/响应格式；VLM/Audio 只发送文本，不证明媒体能力。检查通过绿灯，失败红灯显示原因。保存只持久化配置，禁用槽位运行时不会用。不迁移旧的基础地址，请重新填写完整请求 URL。

Loom 不加载、不运行模型。只当 HTTP 客户端。

TEI 原生存根（字段叫 `texts` 不叫 `documents`）不做第一家。只讲 TEI 的服务需要代理，或以后再加适配。

### 托管 Rerank

LM Studio 没有 `/v1/rerank`。槽位空着就保持 RRF。

- **百度千帆：** 请求 URL `https://qianfan.baidubce.com/v2/rerank`，模型 `bce-reranker-base`，用千帆的 key。
- **阿里云百炼：** 请求 URL `https://dashscope.aliyuncs.com/compatible-api/v1/reranks`（或国际站），模型 `qwen3-rerank`。`gte-rerank-v2` 填 `https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank`，保留其原生报文格式。地址不再改写。Key 和 Audio 同一把 DashScope key。

Rerank 开关会发一次很小的 rerank POST。绿灯表示这条路径通了，不是 `GET /v1/models`。

### 托管 Audio（Qwen-Omni）

LM Studio 和常见本地 OpenAI 兼容服务的 `/v1/chat/completions` 只收 `text` / `image_url`。百度千帆兼容 chat 没有音频部分。能用的远程是 **阿里云 DashScope compatible-mode**（用户自己填，不是产品默认）：

- 国内：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- 国际：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- 模型：例如 `qwen3-omni-flash`（或 `qwen3.5-omni-plus` / `qwen3.8-omni-flash`）
- API key：DashScope 的 key

开关绿灯只表示向该完整接口地址发送的小文本 POST 成功，不表示音频部分可用。DashScope 编码后音频上限 10 MB；Loom 仍先把超过 32 MB 的文件压一遍。

---

## 存储

- 落在应用用户数据目录，不进 `<library>/.loom/`。拷贝素材库时不能把 API key 一起拷走。
- 上次打开的素材库路径记在应用用户数据 `last-library.json`。通用设置允许时，启动会在目录还在的情况下自动打开；目录没了就保持空库，路径仍留下（移动硬盘拔掉再插回来还能认）。E2E 用独立 userData，不会打开本机上次的库。
- `<library>/.loom/config.json` 只放库级偏好。
- 密钥留在应用用户数据，不进素材库。每个非 Chat 槽位提供 API 密钥按钮，点击弹出预填已有密钥的掩码输入框，小眼睛切换明文；确认即可保存，不再需要设置页统一保存。取消/Escape 丢弃弹窗改动，确认空值可清除密钥。存储方式不变，这四个槽位的系统钥匙串存储仍待后续处理。

---

## 界面

- 一个设置窗口，五个 tab：**通用**、**模型**、**MCP**、**Agent**、**统计**。不再提供页级保存/取消按钮，关闭不会撤销已保存的改动。写入串行执行，失败保留输入及上一份有效配置。
- 主进程串行处理 UI/工具修改及其运行时应用。模型和通用设置只合并变更字段，Chat/MCP 按服务商或服务器提交；共用文件锁保护跨实例读改写，临时文件原子替换已保存文件，并处理 Windows 占用重试。MCP 环境变量引用原样留在磁盘。
- 通用：界面语言（跟随系统、English、简体中文），以及启动时是否重新打开上次的素材库。语言会切换应用界面，包括右键菜单。追踪窗口仍是英文。语言和启动选项修改即时保存。存在应用用户数据 `general.json`。重新打开默认开启，和之前的启动行为一致。
- Models：Chat 与四个槽位在同一页。非 Chat 的 URL/模型 ID 在失焦或 Enter 时保存，开关即时保存；已启用槽位的有效提交会检查连通性，不在每次输入时发请求。无效草稿不覆盖其他槽位。API 密钥弹窗确认即保存，自定义 Chat 保留自己的保存服务商/取消操作。
- 改 embedding 的 `model` 会使已有文本 RAG 行作废，见 [TEXT.md](./RAG/TEXT.zh-CN.md)。改 VLM 的 `model` 会使已有图 / 视频说明作废，见 [MEDIA.md](./RAG/MEDIA.zh-CN.md)。改 Audio 的 `model` 会使已有音频说明作废。
- MCP：增删服务器，配置命令/参数或 URL，Advanced 放 env/headers/cwd。保存服务器只提交该条目，其他未完成草稿保持本地。开关和移除即时保存并应用连接。启动时只连接启用的服务器。存在应用用户数据 `mcp.json`（或 `LOOM_MCP_CONFIG`）。
- Agent：进程沙箱开关，默认开，存在应用用户数据 `agent-sandbox.json`。包住什么、Full permission 如何盖过它，见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。下面仍是自由输入的常驻说明，存在应用用户数据 `AGENTS.md`，不进素材库。下一轮会话把它接到系统提示末尾。空着就不加。已经开着的会话仍用开始时的那份。沙箱开关即时保存。常驻说明停顿 500 ms 后保存，切换 tab 或关闭时立即保存待提交文本；超过 40000 字保留输入但不持久化。检索专职和生成专职拿不到这段。
- Stats：应用级累计的 Chat usage。Prompt-cache 命中率是 `cacheRead / (input + cacheRead + cacheWrite)`，和 agent eval 同一公式。同时展示 pi `SessionStats.usage` 的合计（input、output、cache read/write、轮次）。不展示费用；目录价格只是估算，未知价格不写成 0。
- `get_settings` 和 `update_settings` 可读取并修改界面语言、Chat 服务商/模型、其他四个模型槽位、MCP、沙箱与常驻说明。读取不返回密钥、秘密 headers/env。Basic 和 Standard 写入前需确认，界面自动同步；常驻说明从下一条消息生效。启动偏好、权限、统计、OAuth 登录及会话模型/Thinking 选择不纳入这些工具。见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。
- 语言使用 `language: "system" | "en" | "zh-CN"`。Chat 使用 `chat.upsert` / `chat.remove` 和服务商 ID，可选 `chat.refresh`。`get_settings({chatProvider: "openai"})` 返回该服务商的模型目录。自定义服务商提供 `kind: "custom"`、`models`（ID、reasoning、input、contextWindow、maxTokens），以及完整 `requestUrl` 或原生 `baseUrl` + `api`。模型列表整体替换，`modelEnabled` 开关按 ID 合并。已有会话保持原选择，不自动替换模型。
- Chat 条目可设置 `apiKey` 或 `clearApiKey: true`。Chat 密钥加密保存；清除不删除 OAuth/header 秘密，也无法移除环境变量密钥。非 Chat 密钥写入保持原存储方式。工具参数中的密钥会留在对话历史中，建议优先使用设置里的密钥弹窗。
