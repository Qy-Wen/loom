**English** | [简体中文](./README.zh-CN.md)

# Loom

A local-first AI workbench that turns your folders into an asset library you can browse, search, and work with through conversation.

[Website](https://loom.sanzang.site) · [Quick start](#quick-start) · [Development](./docs/DEVELOPMENT.md)

Preview installers for macOS (Apple Silicon and Intel) and Windows x64 are available from the website. You can also run Loom from source using the steps below.

## What you can do

- **Browse your files.** Keep your own folder layout. Preview images, video, audio, PDFs, and Markdown; organize assets with tags and favorites.
- **Find assets by meaning.** Search names and properties directly, or configure models to describe and index selected assets for semantic search.
- **Track relationships.** Connect references, generated images, and finished videos to record how your work came together.
- **Build your own table.** Add text, number, checkbox, and date columns for project status, ratings, and other metadata. Edit them yourself or ask the agent.
- **Process media locally.** Use FFmpeg through the agent to crop, grade, transcode, compress, extract frames, or cut clips. Results return to your library.
- **Connect creative tools.** Add MCP servers such as ComfyUI for generation, or third-party servers for social publishing. These require separate setup and authentication; available features depend on the server.

For example, ask Loom to find a reference image, extract a frame from a video, or update a project's status. Attach a library file to the composer to identify the asset you mean.

## Quick start

You need **Node.js ≥22.19.0**, **pnpm**, and macOS or Windows x64. Run these commands from the repository root:

```sh
pnpm install
pnpm dev
```

Installation downloads FFmpeg and ffprobe for your machine. On Windows, the first sandbox installation requests administrator consent.

1. Open a folder as your library and browse your files.
2. To use the agent, add and authenticate a Chat provider in **Settings → Models**, then choose a model in the composer.
3. For semantic search and media understanding, configure the Embedding, VLM, and Audio slots as needed, then select assets to describe or index. Rerank is optional.

Starting the app does not require an API key. During development, a root `.env` containing `DEEPSEEK_API_KEY` can enable DeepSeek on first run; you can also configure providers in Settings. See [model configuration](./docs/SETTINGS.md).

## Your files and model services

Asset files stay in your folders. Loom stores library metadata, indexes, relationships, and conversations in the hidden `.loom/` directory inside each library. To move a library, close Loom and copy the entire folder **including `.loom/`**. App-level model settings and credentials are stored separately; configure them again on the new machine.

Model endpoints can be local or remote. Using a remote provider sends relevant conversation content, text, or media to that provider. Describing and embedding assets happens when you or the agent requests it. Model configuration and provider charges are managed by you.

The agent has permission levels and a process sandbox. MCP servers run outside that sandbox and have their own access. See [permissions and sandboxing](./docs/agent/PERMISSION.md).

## Development

```sh
pnpm test
pnpm -r typecheck
```

`pnpm test` runs workspace package tests. See the [development guide](./docs/DEVELOPMENT.md) for Electron checks, end-to-end tests, package boundaries, and vendor maintenance.

## Technical documentation

- [Agent runtime, tools, and delegation](./docs/agent/AGENT.md)
- [Retrieval and indexing](./docs/RAG/RAG.md)
- [Model configuration](./docs/SETTINGS.md)
- [Permissions and sandboxing](./docs/agent/PERMISSION.md)
- [Memory](./docs/agent/MEMORY.md)
- [Local traces](./docs/agent/TRACE.md)

## License

[MIT](./LICENSE). Vendored components retain their own license files.
