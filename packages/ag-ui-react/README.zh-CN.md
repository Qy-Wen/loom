[English](./README.md) | **简体中文**

# @loom/ag-ui-react

为 [AG-UI](https://docs.ag-ui.com/) 提供 React Hooks 和聊天组件。可以传入官方的 `HttpAgent`，也可以传入使用自定义传输层的 `AbstractAgent`。

```tsx
import { HttpAgent } from "@ag-ui/client";
import { Chat } from "@loom/ag-ui-react";
import "@loom/ag-ui-react/styles.css";

const agent = new HttpAgent({ url: "/api/agent", threadId: "conversation-1" });

export function App() {
	return <Chat agent={agent} />;
}
```

每个会话创建一个 Agent，并在重新渲染时复用同一实例。用 `useAgent(agent)` 订阅消息、状态、运行状态和错误，或用 `MessageList` 和 `MessageComposer` 组合自己的聊天界面。`transcriptItems` 会将工具调用与对应的结果配对。可选的样式表只作用于内置组件。

AG-UI 负责解析并应用协议事件。宿主应用负责鉴权、持久化、重连和工具审批界面。默认的「停止」按钮会调用传入 Agent 的 `abortRun()`。如果传输连接断开后服务端仍可能继续执行，宿主应用需要实现服务端取消。

自定义消息列表时，将 `useChatScroll()` 返回的 `scrollerProps` 展开传给可滚动的 `<div>`，并设置 `overflow-y: auto` 和 `overflow-anchor: none`。根据 `showJumpToLatest` 显示「跳到最新消息」按钮，调用 `scrollToBottom` 可恢复跟随最新消息。

## ChatView

如果消息和输入区由宿主应用管理，可以用 `ChatView` 渲染受控的消息区。使用这个支持 Markdown 的视图需要安装 `streamdown@1.3.0`。

```tsx
import { ChatView } from "@loom/ag-ui-react/chat-view";
import "@loom/ag-ui-react/styles.css";
import "@loom/ag-ui-react/markdown.css";

<ChatView messages={messages} isRunning={isRunning} threadId={threadId} />
```

通过 `slots` 自定义 Markdown 链接、消息内容或操作、工具调用和活动状态。用户和助手消息的插槽还可以把整行替换为编辑器或错误提示。通过 `--agui-chat-*` 和 `--agui-md-*` CSS 自定义属性调整主题。

`ToolCard` 是默认的工具调用行，也可以在工具插槽中复用，自定义结果内容和审批控件。用 `ChatActivity` 显示进度，用 `ChatError` 显示请求失败。主入口导出这些组件，`styles.css` 提供对应样式。

`ComposerForm` 可接入宿主应用提供的编辑器和工具栏控件，让新消息和编辑消息共用表单及发送、停止或取消按钮。草稿、附件和提交由宿主应用管理。

## Markdown

要流式渲染包含表格和代码高亮的 Markdown，请安装 `streamdown@1.3.0`，并使用支持导入 CSS 的打包工具来加载 Markdown 入口。

```tsx
import { Markdown } from "@loom/ag-ui-react/markdown";
import "@loom/ag-ui-react/markdown.css";

<Markdown content={text} />
```

传入 `linkComponent` 可处理应用内的自定义链接，添加 `dark` 类可启用深色代码主题。只显示纯文本时，可以使用主入口导出的 `Chat` 或 `MessageList`。

在 Markdown 容器上设置 `--agui-md-font-size`、`--agui-md-link-color` 和 `--agui-md-inline-code-background` 等 CSS 自定义属性，可使样式与宿主应用的主题一致。

在此目录运行 `npm pack`，即可构建并打包带 TypeScript 类型声明的独立 ESM 包。
