[English](./SETTINGS.md) | **简体中文**

# 设置

> 应用级的模型端点。检索规则见 [TEXT.md](./RAG/TEXT.zh-CN.md)。待办见 [TODO.md](./TODO.zh-CN.md)。
>
> 这里只记结论。

---

## Chat 模型

设置 → Models 的 Chat 区域只有一个外框，与其他四个模型槽位共用滚动条。每个模型只有启用开关，不设置默认模型或思考等级。服务商标题旁用状态点表示鉴权状态，红点悬停显示错误；API 密钥/OAuth、编辑、移除按钮位于模型列表下方。Chat 修改即时保存；凭据用系统加密存于 `chat-credentials.json`，普通读取不返回凭据。

“添加服务商”下拉框包含“自定义服务商”。内联编辑器支持名称、完整请求 URL、模型 ID/显示名、模型增删；高级配置声明上下文/输出上限及图片/思考能力。只有“保存服务商”才发布草稿，取消不会创建占位条目。编辑保留服务商身份、凭据与未暴露的元数据。保存后通过独立按钮配置 API 密钥；不校验鉴权的本地服务可使用占位密钥。

自定义 Chat 根据完整 URL 的路径识别协议：`/chat/completions`、`/responses`、`/v1/messages` 或 `/models/{model-id}:streamGenerateContent`。标准路径只显示识别结果，不显示协议下拉框。Loom 提取基础地址，路径拼接、鉴权与流式解析仍由 pi-ai/SDK 负责。Gemini 地址会预填空白的首个模型 ID，调用使用各模型配置的 ID。未知路径可明确切换到 Base URL + 手选协议模式，仍由 SDK 追加路径。不支持的查询参数会报错而非被丢弃；接受原生 `beta=true` / `alt=sse` 标志。

模型与思考等级在会话输入区选择。新独立会话仅在上次明确选择仍启用且可用时沿用它，否则要求手动选择；既有会话/fork 保留原选择，不自动换模型。配置与记忆选择存于 `chat-models.json`。首次 `DEEPSEEK_API_KEY` 引导只启用原生 DeepSeek，不自动选择模型。见 [CHAT_MODELS](./agent/CHAT_MODELS.zh-CN.md)。

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

- `baseUrl`：完整 HTTP(S) **请求 URL**，包含接口路径及可选查询参数。不补版本/路径，不改写地址。例如 `https://…/v1/embeddings`、`https://…/v2/rerank`、`https://…/v1/chat/completions`。
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
- 密钥留在应用用户数据，不进素材库。每个非 Chat 槽位提供 API 密钥按钮，点击弹出掩码输入框；确认更新草稿，设置页保存才持久化。取消/Escape 丢弃弹窗改动，确认空值可清除密钥。存储方式不变，这四个槽位的系统钥匙串存储仍待后续处理。

---

## 界面

- 一个设置窗口，五个 tab：**通用**、**模型**、**MCP**、**Agent**、**统计**。
- 通用：界面语言（跟随系统、English、简体中文），以及启动时是否重新打开上次的素材库。语言会切换应用界面，包括右键菜单。追踪窗口仍是英文。改语言会立即预览，取消则回到已保存的语言。存在应用用户数据 `general.json`。重新打开默认开启，和之前的启动行为一致。
- Models：五个槽位在同一页。Rerank / VLM / Audio 可以空着。开关负责 ping；**Save** 同时写入通用、Models、MCP 和 Agent，然后关掉设置。
- 改 embedding 的 `model` 会使已有文本 RAG 行作废，见 [TEXT.md](./RAG/TEXT.zh-CN.md)。改 VLM 的 `model` 会使已有图 / 视频说明作废，见 [MEDIA.md](./RAG/MEDIA.zh-CN.md)。改 Audio 的 `model` 会使已有音频说明作废。
- MCP：加减 server。表单按 Cursor `mcp.json` 来：名字，然后本地填 `command` + `args`，远程填 `url`。Env / headers / cwd 放在 Advanced。开关连接或断开那一台。**Save** 同时写入通用、Models、MCP 和 Agent。启动时只连已开启的 server。存在应用用户数据 `mcp.json`（或 `LOOM_MCP_CONFIG`）。默认空列表；ComfyUI 只是其中一种，不是内置。
- Agent：进程沙箱开关，默认开，存在应用用户数据 `agent-sandbox.json`。包住什么、Full permission 如何盖过它，见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。下面仍是自由输入的常驻说明，存在应用用户数据 `AGENTS.md`，不进素材库。下一轮会话把它接到系统提示末尾。空着就不加。已经开着的会话仍用开始时的那份。大约 40000 字，超出则 Save 拒绝。检索专职和生成专职拿不到这段。**Save** 同时写入通用、Models、MCP 和 Agent。
- Stats：应用级累计的 Chat usage。Prompt-cache 命中率是 `cacheRead / (input + cacheRead + cacheWrite)`，和 agent eval 同一公式。同时展示 pi `SessionStats.usage` 的合计（input、output、cache read/write、轮次）。不展示费用；目录价格只是估算，未知价格不写成 0。
- `get_settings` 和 `update_settings` 读取并修改四个模型槽位、MCP、Agent。读取不返回 API key，也不返回 MCP 的 env / headers。写进 `update_settings` 的钥匙会保存，同时留在那条对话里。Basic 和 Standard 在写入前要确认。设置窗口开着时会重新加载。Chat Provider 在设置 → Models 配置，不走这两个工具；Instructions 从下一条消息起生效。权限档位和用量不走这两个工具。见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。
