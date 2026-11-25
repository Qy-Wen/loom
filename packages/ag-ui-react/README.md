**English** | [简体中文](./README.zh-CN.md)

# @loom/ag-ui-react

React hooks and chat components for [AG-UI](https://docs.ag-ui.com/). Supply an official `HttpAgent` or an `AbstractAgent` with your own transport.

```tsx
import { HttpAgent } from "@ag-ui/client";
import { Chat } from "@loom/ag-ui-react";
import "@loom/ag-ui-react/styles.css";

const agent = new HttpAgent({ url: "/api/agent", threadId: "conversation-1" });

export function App() {
	return <Chat agent={agent} />;
}
```

Create one stable agent per conversation. Use `useAgent(agent)` to observe messages, state, running status, and errors, or render your own UI with `MessageList` and `MessageComposer`. `transcriptItems` pairs tool calls with their results. The optional stylesheet only styles the built-in components.

AG-UI parses and applies protocol events. The host app supplies authentication, persistence, reconnection, and any tool approval UI. The default Stop invokes the supplied agent's `abortRun()`; implement server-side cancellation in the host when the transport can detach while work continues.

For a custom transcript, spread `scrollerProps` from `useChatScroll()` onto a scrollable `<div>` with `overflow-y: auto` and `overflow-anchor: none`. Use `showJumpToLatest` to show a jump button and `scrollToBottom` to resume following the transcript.

## ChatView

Use the controlled message area when the host supplies messages and manages its own composer. Install `streamdown@1.3.0` for the Markdown-backed view.

```tsx
import { ChatView } from "@loom/ag-ui-react/chat-view";
import "@loom/ag-ui-react/styles.css";
import "@loom/ag-ui-react/markdown.css";

<ChatView messages={messages} isRunning={isRunning} threadId={threadId} />
```

Pass `slots` for custom Markdown links, message content or actions, tool calls, and activity. User and assistant slots can also replace a row with an editor or error. Theme the view with `--agui-chat-*` and `--agui-md-*` CSS properties.

`ToolCard` is the default tool row and can also be used in the tool slot with custom result content and approval controls. Use `ChatActivity` for progress and `ChatError` for failed requests. These components are available from the main entry and styled by `styles.css`.

Use `ComposerForm` with a host-supplied editor and toolbar controls to share the form and its send, stop, or cancel buttons between composing and editing. The host manages the draft, attachments, and submission.

## Markdown

To render streaming Markdown with tables and highlighted code, install `streamdown@1.3.0` and use the Markdown entry with a bundler that supports CSS imports.

```tsx
import { Markdown } from "@loom/ag-ui-react/markdown";
import "@loom/ag-ui-react/markdown.css";

<Markdown content={text} />
```

Pass a `linkComponent` to handle app-specific links and use the `dark` class to select the dark code theme. Keep using `Chat` or `MessageList` from the main entry for plain text.

Set CSS properties such as `--agui-md-font-size`, `--agui-md-link-color`, and `--agui-md-inline-code-background` on the Markdown container to match the host theme.

Run `npm pack` in this directory to build and create a standalone ESM package with TypeScript declarations.
