[English](./CHAT_MODELS.md) | **简体中文**

# Chat 模型完整接入 pi-ai

> 状态：旧 Chat 端点兼容路径已移除（产品未发布）。原生运行时已接管生产启动、存储、设置/OAuth UI、Provider 登录与会话级模型选择。Windows/真实 OAuth 验收（P5）仍待完成。
> 当前实现见 [AGENT](./AGENT.zh-CN.md)、[SETTINGS](../SETTINGS.zh-CN.md)。依据项目安装的 `@earendil-works/pi-ai@1.1.0`；参考实现位于 `agent/pi/packages/ai` 和 `agent/pi/packages/coding-agent/src/core`。

## 1. 范围与确定的原则

- Chat 使用 pi-ai 的 Provider、模型目录、原生协议、鉴权和能力元数据，包含 **API Key 与 OAuth 登录**。
- **应用默认模型只影响新独立会话**；每个会话独立保存模型和思考等级，重开保留，fork 保留分叉点的选择。specialist 默认继承父会话。
- 内置 Provider 优先直接复用工厂；自定义连接用于代理、本地服务及未收录模型。不把所有连接伪装成 `loom-chat`。
- Loom 负责配置、凭据持久化、UI、选择策略；pi-ai 负责协议转换、鉴权解析、OAuth 刷新、流式事件和 usage；durable 继续负责调度、重试、压缩、取消和恢复。
- 不引入整个 pi-coding-agent，不修改 vendor 源码，不自行实现 OAuth 或 LLM 流式协议。
- 本次不改 Embedding、Rerank、VLM、Audio 的接入与凭据存储，不做模型加载/部署、自动路由/故障切换、多账号管理、独立 specialist 模型选择。

## 2. 当前缺口

| 已移除的旧实现 | 替代方案 |
|---|---|
| Chat 与其余四个槽位共用 URL / Key / Model 表单 | 设置 → Models 中独立的 Chat Provider 管理，其余槽位不变 |
| `pi-adapter.ts` 注册一个 `loom-chat`，固定 Chat Completions | 内置 Provider 原生行为 + 显式配置的自定义协议 |
| 默认 128k、输出 8192、支持图片、不支持思考、价格为 0 | 内置模型元数据来自 pi-ai；自定义模型显式声明，未知能力不猜 |
| API Key 明文写入 `model-settings.json` 并返回设置 UI | Chat 凭据独立加密（`chat-credentials.json`，safeStorage），普通查询只返回状态 |
| 修改 Chat 时批量 configure 所有会话 | 应用默认值只影响新独立会话 |
| `/models` 返回 JSON 即连接成功 | 通过原生运行时查询 Provider 鉴权状态 |

## 3. 架构与模块边界

```text
Renderer：Provider 设置 / 登录交互 / 会话模型选择
    │ IPC：配置、非敏感目录与状态、登录事件
Main：ChatModelService + 配置/凭据/目录存储
    │ @loom/agent 的纯模型装配与配置契约
pi-ai Models：内置 Provider + 自定义 Provider
    │ 注入现有 LibraryAgentHost / LibraryAgent
pi-durable Harness：会话选择、生成、压缩与恢复
```

命名为拟定职责，不要求机械地按表拆文件：

| 位置 | 职责 |
|---|---|
| `packages/agent/src` | 替换现有 endpoint-only adapter：Provider 装配、自定义模型校验、模型元数据与思考等级；不依赖 Electron、app 存储或 UI |
| `packages/app/src/main` | 一个应用级、长期存在的 Chat 模型运行时；配置、加密凭据、目录缓存、登录生命周期与 IPC |
| `packages/app/src/main/library-agent-host.ts` | 接收 `Models` 与新会话默认值；配置指定会话，不再临时构造单模型集合或批量改历史会话 |
| `packages/app/src/shared` | JSON 配置/目录/鉴权状态/登录交互 DTO；不得携带 Provider、durable 句柄或凭据对象 |
| `packages/app/src/renderer` | 设置与会话 UI，网络请求和鉴权在 Main 执行 |

保持现有 AG-UI、trace 和工具链路。应用级运行时可由每个 Harness 外侧的 trace wrapper 观察，但不复制凭据存储或 Provider 集合。

## 4. 配置、目录与鉴权

### 4.1 三类数据分离

拟放在 Electron `userData`，不放素材库：

| 数据 | 拟定文件/存储 | 内容 |
|---|---|---|
| 非敏感配置 | `chat-models.json`，带 schema version | Provider 启用状态、地址覆盖、自定义模型、能力/compat overrides、生成默认值、应用默认 `{ provider, modelId, thinkingLevel }` |
| Chat 凭据 | 独立加密存储，实现 `CredentialStore` | 按 Provider ID 保存一份 API Key 或 OAuth credential；敏感 headers 等也通过秘密引用保存 |
| 动态目录 | `chat-model-catalog.json`，实现 `ModelsStore` | 可恢复的动态目录与来源；不包含凭据 |
| 会话选择 | 库内 durable `pi.agent` | 模型引用、thinking level；不保存密钥 |

- 使用稳定的原生 Provider ID；新增自定义连接分配稳定 ID，改显示名不改身份，同名模型在不同 Provider 下不冲突。
- 每个 Provider 一份 credential，符合 pi-ai 契约；切换 API Key / OAuth 是替换鉴权方式，不是同时保留多账号。
- 默认选择、会话选择和 Provider 启用状态分开。禁用/删除 Provider 或注销不改写历史选择，也不偷偷切备用模型；按剩余配置与鉴权显示实际可用状态。
- 新会话创建时写入明确的模型和思考等级，不依赖以后会变化的应用默认值。

### 4.2 内置与自定义 Provider

- 内置 Provider 保留工厂的 auth、过滤策略、动态目录行为、协议分发和完整模型元数据。覆盖地址/headers/模型参数时采用薄组合，不用手工复制工厂实现。
- 使用 pi-ai 内置 Provider 集合供用户浏览；SDK 保持 lazy，只有启用的 Provider 注册到执行集合。Chat picker 只列 chat/tool-capable 模型，不混入 image/classifier 模型。
- 自定义连接明确配置协议。至少覆盖 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；特殊云端协议优先通过原生 Provider 接入。
- 自定义模型可按 ID 手工添加，声明文本/图片、reasoning、上下文窗口、输出上限，支持高级 headers、compat、thinking-level map 和价格覆盖。普通表单不暴露全部高级字段。
- 未知模型不继承“支持图片/思考”的假设；自定义服务若列出 `/models`，仅可用来辅助选 ID，缺失能力仍须补齐。无价格显示“未知”，不是“免费”；若 pi-ai 结构要求以 0 占位，另存价格是否已知/来源，不能把占位费用当实际费用。
- 覆盖内置模型时保留未覆盖的字段；代理价格覆盖与官方目录价格区分。不要因为模型名相同就自动借用官方协议或能力。

### 4.3 目录读取与刷新

- 随包静态目录保证离线浏览。只有具有 refresh 能力的 Provider 才通过 `Models.refresh()` 获取动态目录，缓存恢复可用 `allowNetwork: false`。
- **pi-ai 1.1.0 并非所有内置 Provider 都具有联网目录刷新能力。** 不将 pi CLI 的在线目录覆盖能力误当成 pi-ai 的通用 API；不在本次另建目录服务。
- 刷新、登录完成、凭据替换后更新可用模型；网络失败保留旧目录并显示错误/来源，不清空选择。查询与刷新支持取消和超时。
- 目录存在、鉴权已配置、实际调用成功是三个不同状态。失效模型可保留在会话 DTO 中，但标记不可用。

### 4.4 凭据与 OAuth

- 用 Electron `safeStorage` 加密持久化 Chat credential；加密不可用或解密失败明确报错，不退回明文。文件权限、原子写入、锁和替换在 macOS / Windows 分别验证。
- `CredentialStore.modify()` / `delete()` 串行化，防止 OAuth 并发刷新与登录/注销互相覆盖；跨进程写入必须协调，不能只依赖内存锁。
- 内置 Provider 的环境/ambient 鉴权由 pi-ai 解析；UI 显示来源。已存凭据解析失败不静默回退环境变量。注销只删除已存凭据，环境鉴权可能仍在，禁用 Provider 才阻止新调用。
- Renderer 不收到已保存的 Key、access/refresh token；只提交新 Key，或消费脱敏状态。鉴权解析错误、IPC、trace、诊断和目录缓存均不得泄露秘密。
- OAuth 用 `Models.login()` / `logout()`，转接 `AuthInteraction` 的 text/secret/select/manual_code prompt 与 info/auth_url/device_code/progress event；支持取消、窗口关闭、app 退出和手工回调。
- 登录/注销独立于设置草稿立即执行并明确提示，取消设置不撤销已完成的登录。注册 Provider 不等于所有 OAuth 流程已验收；逐项检查安装版本与 Electron 打包支持。
- Loom 的设备标识/应用名通过 pi-ai 提供的登录参数传入；不替换上游 OAuth 客户端协议。回调和浏览器打开只处理经过校验的登录 URL。

## 5. 会话与请求语义

| 操作 | 行为 |
|---|---|
| 修改设置页默认模型/思考等级 | 只影响之后的新独立会话 |
| 当前会话选择模型/思考等级 | 通过 native configure 保存该会话；下一次请求生效 |
| 重开/恢复 | 恢复该会话已有选择，不覆盖为当前默认值 |
| fork/编辑旧问题 | 保留分叉点的模型与思考等级，不修改源会话 |
| specialist 创建/重放 | 默认继承父会话；已有子会话保持其已保存选择 |
| Provider 不可用、凭据失效 | 显示原因并要求配置或手动选择，不自动换模型 |

- 用户不能在会话前台工作、相关子任务或压缩尚在运行时切换该会话模型；显示忙碌原因，不另建调度队列。Provider 编辑/禁用/删除与目录发布也必须保护正在使用它的请求。
- 当前请求对象保持不变，相关工作 busy 时阻止 Provider 修改。沿用 durable 原生恢复：checkpoint 保留模型引用/思考等级，重发时解析当前可用 Provider 元数据与默认参数；不承诺跨重启快照，不向 checkpoint 写入鉴权。正常 OAuth 刷新不属于模型切换。
- 思考等级用 `getSupportedThinkingLevels()` / `clampThinkingLevel()` 校验并持久化有效值，不自行维护厂商映射。现有 durable thinking 与 AG-UI reasoning 事件继续复用。
- 区分模型 `maxTokens`（能力上限）和用户生成预算。生成默认值按连接/模型配置；本次会话选择只单独保存模型与思考等级，不增加一套会话级采样参数编辑器。
- 当前 `ConversationStreamOptions` 未暴露 `maxTokens` / `temperature`。通过公开 Provider 请求 API 注入默认值，显式请求值优先，保留压缩自身的 token 预算。按已确认的 A 语义，恢复时重新应用当前默认值；不用私有 API，不修改 vendor。
- 新图片附件在非图片模型下拒绝并说明；已有图片历史和工具图片不改写，沿用 pi-ai/durable 的兼容处理并提示限制。上下文圆环按当前所选模型窗口计算，模型变化后不复用旧模型 usage。
- 保留真实 usage/cost；官方目录价格标为估算，订阅访问不冒充按量账单，未知价格不显示零费用。无需本次重做整个 Stats 面板，但不得继续把模型价格全部清零。

## 6. UI、连接测试与设置工具

- Models 设置内 Chat 独立区域：Provider 列表、启用与鉴权状态、API Key / OAuth 操作、模型搜索与刷新、默认模型/思考等级、自定义连接高级配置。其他四个槽位沿用当前表单。
- 会话输入区域提供模型与思考等级选择，并显示当前实际选择、能力和不可用原因；切换 tab 不串状态。
- Chat 用显式“测试连接”，不将启用开关或 `/models` 成功等同于推理可用。通过同一个 runtime 的 `completeSimple()` 发小请求，检查 terminal result、超时和取消；提示可能产生少量费用。
- 连接测试验证所选模型的基本调用，不承诺工具/图片/OAuth 所有能力已验证；这些使用独立验收。测试草稿不覆盖已保存 Provider，不把未保存的 Key 写入凭据存储。
- 更新 `get_settings` / `update_settings` 的 Chat schema：默认值变更只影响新会话，返回脱敏 Provider 与模型状态。保留现有写入审批；不支持用聊天工具发起交互式 OAuth 或读取秘密。
- 登录属于独立即时操作；普通配置仍在 Save 后生效。保存多文件时校验完整配置并使用可恢复的提交过程，失败不得出现“默认模型已指向未保存 Provider”。

## 7. 旧配置清理（已完成）

- 产品未发布，不做旧兼容：`LoomChatEndpoint`、`buildChatModels`、`pi-adapter.ts`、Host 旧 `setChat`/批量 configure 路径与分阶段 `chat-migration.ts` 已删除。
- `model-settings.json` 只保留四个非 Chat 槽位；旧文件中的 Chat 条目直接忽略，引用 `loom-chat` 的旧中断请求不保证续跑。
- 不改写历史/transcript。引用已移除模型的旧会话保留记录，存在匹配 Provider 时才重新解析模型。
- 无已保存配置时，环境引导启用原生 DeepSeek Provider 与目录默认 `deepseek-flash`（来自 `DEEPSEEK_API_KEY`，仅环境生效、不持久化）。新鉴权走 pi-ai 原生环境支持。

## 8. 验证与实施状态

### 已验证

- pi-ai 1.1.0 共 42 个内置 Provider，其中 41 个具有 Chat 模型；**只有 Radius 有原生动态目录刷新**。OAuth 工厂有 9 个：Anthropic、GitHub Copilot、Kimi Coding、Meta、OpenAI、OpenAI Codex、OpenRouter、Radius、xAI。
- 薄模型覆盖可保留原生 auth、OAuth 可用模型过滤、动态发布/离线缓存、混合协议分发与未覆盖的能力/价格字段。Copilot 等 OAuth 的鉴权派生地址优先于静态模型地址；代理配置不能偷偷覆盖它。
- OpenAI Responses、Anthropic Messages、Google Generative AI、DeepSeek Chat Completions 和 Copilot 的三种协议完成离线 payload 构造测试；这些不是远端推理验收。
- `Provider.headers` 在安装版本中只是元数据，不能仅修改这个字段就认为 headers 已发送；需要通过模型 headers 或公开请求选项应用，保留 pi-ai 的合并优先级。
- 生成默认值可以注入 `streamSimple()`，显式参数优先；真实 durable 压缩仍使用自己的 800-token 预算，不被 4096-token 默认值覆盖。
- macOS arm64 / Electron 38.2.2 上 `safeStorage` 加密及另一个 Electron 进程解密通过。9 个 OAuth 模块与 4 个原生协议 SDK 在保留 npm 包的构建中可 lazy 加载；OpenAI 的模拟 loopback 登录验证错误 state 拒绝、正确回调、Loom 设备标识/应用名、取消及监听器关闭。没有打开浏览器或访问真实服务。

### 打包

打平 pi-ai 会破坏 OAuth 的 opaque 相对 import；隔离构建已复现旧布局并验证完整 npm 包可解决。P1 已将 pi-ai 1.1.0 加入 app 直接依赖，启用现有 externalization 策略，app 构建通过。最终安装包及内容验证仍属 P2/P5，OAuth import 不能指向 app 的 `out/main`。Windows 实机与真实登录尚未验证。

### 已确认的请求语义（A）

沿用 durable 原生恢复，不修改 vendor。checkpoint 保存模型引用、思考等级与有限 stream options，不保存完整模型元数据/默认参数。重开测试保留引用及 memo 预算 64，但重发使用当前预算 256、窗口 32000；不承诺跨重启固定参数/元数据。

公开 busy 测试通过 `Harness.inspect()` 观察运行中的生成任务，并验证当前请求保留已捕获的模型/参数。**原生 `configure()` 不会因忙碌而拒绝切模型。** P2/P4 必须在调用原生修改 API 前，由 Loom 检查会话/子任务/压缩及 Provider 发布边界。

### P1 存储

- `@loom/agent/chat-models` 定义 v1 schema、自定义能力/协议、生成默认值、可选价格覆盖与 header 秘密引用；shared 目录/鉴权 DTO 不携带凭据。未知自定义价格保持缺省，不写成 0。
- Main 分开保存配置、OS 加密凭据/header 值与原生目录。凭据修改在整个 OAuth refresh 期间持有带心跳的跨进程锁。JSON 用同目录临时文件、文件 sync、受限权限及 Windows 重试替换；无效数据/解密失败不静默重置。
- 目录测试覆盖全部 42 个原生工厂，包括混合操作类型、ambient 云端空地址、原生未知价格负值标记与 Radius 的路由鉴权来源字面引用。缓存不保存 headers，后续 runtime 必须重新应用。
- **已确认的引导：** 首次运行且无已保存配置时，用 `DEEPSEEK_API_KEY` 启用原生 DeepSeek Provider 与 `deepseek-flash`；环境密钥仅环境生效、从不持久化。

### P2 运行时基础

- `packages/agent/src/chat-provider.ts` 装配原生工厂与四种显式自定义协议。薄覆盖保留 auth/filter/refresh/dispatch，仅合并已声明的元数据/默认值；自定义无鉴权连接需明确允许，自定义 ID 不得与内置 ID 冲突。
- `packages/app/src/main/chat-model-service.ts` 持有一个长期执行集合，注册已启用 Provider，恢复/刷新原生目录并返回无凭据视图。未知价格不返回费率；只改默认值时保留 Provider 对象与动态状态。Headers 仅在 Main 内存解析，不进入普通 DTO 或缓存。
- 注入式 `LibraryAgentHost` 仅为新独立会话写入默认模型/思考等级，fork/reopen 保留原选择。Provider 编辑/发布在公开 Session commit 内检查 live tasks/inbox，覆盖压缩；直接请求活动也受保护。会话级变更使用同一 busy 检查（`setSessionModel`）。
- 已知请求/鉴权秘密传给 trace 脱敏，并在 durable 记账前从 Provider 错误文本中移除。真实旧请求 checkpoint 恢复与 800-token 压缩上限已通过新服务验证。
- **生产启动已切换：** `app.whenReady()` 用 `createChatStorage(userData)` 构建 `ChatModelService`，初始化（首跑环境引导）后把长期 `Models` 与默认值注入 `LibraryAgentHost`。Host 不再构建 Provider；秘密经 `onSecrets` 传入 trace 脱敏。
- Chat IPC：`getChatSettings`/`saveChatSettings`（无凭据视图）、`chatProviderCatalog`、`chatLogin`/`chatLoginPrompt`/`chatLoginResponse`/`chatCancelLogin`（API Key + OAuth 交互桥接到 renderer）、`chatRefresh`、`chatSettingsChanged`。设置工具不再暴露 Chat 槽位。
- Renderer：设置 → Models 的 `SettingsChat` 管理 Provider（添加/移除、API Key/OAuth 登录弹窗）、默认模型/思考等级与刷新；即时保存，不参与四槽位批量 Save。
- eval/smoke 脚本与 vendor 测试通过 `createChatCustomProvider` + 内存凭据构建自定义 Provider；`LoomChatEndpoint` 消费者已移除。

### 可复现入口

```bash
pnpm typecheck
pnpm --filter @loom/agent test                 # 152 项通过
pnpm --filter @loom/app test                   # 247 项通过
pnpm --filter @loom/app build
pnpm --filter @loom/app check:chat-platform    # 独立临时 userData、假凭据、模拟回调；需本机 Electron/OS 加密
```

P0 原型仍仅用于测试；生产启动已切换到原生运行时，旧 Chat 端点路径已删除。

## 9. 实施顺序与验收清单

### P0：接口验证与最小原型

- [x] 核对已安装 pi-ai 的 Provider/auth/refresh/协议与 OAuth 能力，不以参考仓库更新版本的行为代替。
- [x] 验证内置 Provider 薄覆盖仍保留 auth、模型过滤、动态目录和混合协议分发。
- [x] 确认原生恢复（A）；验证当前请求快照、公开 busy 检查/configure 行为、显式参数优先与真实压缩预算。生产 busy 限制留在 P2/P4 实现。
- [x] macOS Electron 的 lazy SDK/OAuth、模拟浏览器回调与 `safeStorage` 验证完成；打包修正与 Windows/真实登录待后续阶段。

### P1：配置与存储

- [x] 定义独立的版本化 Chat 配置与脱敏目录/鉴权 DTO，其余槽位不变。
- [x] 实现并测试加密 `CredentialStore`、`ModelsStore`、原子持久化及跨进程写入协调（macOS；Windows 实测仍属 P5）。
- [x] 实现并测试旧配置分阶段迁移/cutover、失败/重启恢复、已确认的环境引导及真实旧请求 checkpoint 恢复；生产启动切换仍列在下方。

### P2：模型运行时

- [x] 建立应用级 `Models`，复用内置工厂，校验自定义协议/能力/默认值，返回安全的目录/鉴权/可用状态。
- [x] 接入原生刷新/缓存/超时/取消，保留元数据/思考/费用；普通费率不返回未知价格占位值。
- [x] Host 注入路径已测试；生产启动已切换到原生运行时，旧 endpoint 构造/批量 configure 已移除。安装包内容检查仍属 P5。
- [x] 验证生产 wrapper 的默认/显式参数优先级、真实压缩预算与已知鉴权/错误脱敏；完整 trace/真实服务回归仍属 P5。

### P3：Provider 设置与登录

- [x] Provider 列表/添加/移除、自定义 OpenAI 兼容连接、默认模型/思考等级 UI，中英文文案。
- [x] 通过 IPC prompt 桥接 API Key/OAuth 交互（文本/密码/选择/手工代码/授权 URL/设备码），支持取消。注销语义仍属 P5。
- [x] 设置工具不再暴露 Chat 槽位；Provider 状态来自运行时。显式连接测试仍属 P5。

### P4：会话选择

- [x] `LoomSessionRecord.model` 暴露持久化选择；`setSessionModel` IPC 按运行时校验模型与思考等级，再经原生 `conversation.configure()` 生效。
- [x] 输入区工具栏的 `ChatModelSelect`：模型列表来自实时目录（不可用模型禁用），思考等级在支持等级间循环；忙碌时禁用，变更从下一次请求生效。
- [x] Host 测试覆盖会话级持久化（重开保留）、默认值只影响新会话、流式请求中 busy 拒绝；smoke E2E 覆盖 IPC 链路含未知模型拒绝。
- [ ] 切模型后的上下文圆环刷新与图片能力提示留作 P5 打磨；Provider 失效不自动换模型。

### P5：回归与交付

- [ ] 单元测试：配置/覆盖/协议选择、能力/思考校验、鉴权来源、缓存、迁移、未知价格。
- [ ] 鉴权测试：并发刷新只执行一次，失败不丢凭据，取消、登录/注销竞态、加密失败；秘密不进入 DTO/日志/trace。
- [ ] 本地 mock 集成：Chat Completions、Responses、Anthropic、Google 的文本/工具/usage/取消与跨 Provider 历史转换。
- [ ] durable/Electron：并行会话、独立模型、specialist、图片、阈值/溢出压缩、fork/reload、请求中 SIGKILL 恢复，无重复输入或 unsafe 工具重放。
- [ ] 授权的真实服务验收：现有 DeepSeek 路径、OpenAI/Anthropic/Google 原生路径，以及已声明支持的 OAuth 登录/刷新；未实测项标明，不宣称全 Provider 均通过。
- [ ] macOS 和 Windows 的登录回调、加密重开、文件锁/替换、lazy SDK 打包与运行测试。
- [ ] agent/app/vendor 类型检查和现有测试通过；更新当前架构、设置文档与本清单，删除过渡实现。

完成标准：用户能从内置目录或自定义连接配置 Chat，使用 API Key/OAuth，创建与恢复各自选择模型的会话；工具、思考、usage、压缩、取消与恢复继续走 pi-ai/durable 原生链路，秘密不落素材库或普通查询。文档未勾选的项不视为已完成。
