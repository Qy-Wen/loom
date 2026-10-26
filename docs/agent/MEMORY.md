**English** | [简体中文](./MEMORY.zh-CN.md)

# Memory

> How the chat Agent remembers user preferences and creative conventions across sessions. Skills stay the place for procedures.

---

## 1. Where it lives

Notes for the open library live in `<library>/.loom/agents/memory/MEMORY.md`. One file. About 2,000 characters. The memory directory is created on the first write. `.loom` is not indexed as assets. The skill catalog in `.loom/agents/skills/` is read during request preparation.

Facts only: preferences and conventions for this library. A different library has a different file. Procedures stay in `.loom/agents/skills/`.

---

## 2. System prompt

Read the file when a session starts and append that snapshot after the existing system prompt and the skills catalog. The snapshot stays byte-stable for the rest of the session.

`LoomMemoryDoc` stores the creation-time snapshot in the library's durable SQLite store. The prompt section reads that document, not the file. Forks and reopens retain it. A write updates the file immediately; new conversations read it, existing conversations do not.

---

## 3. Tool

The parent chat Agent gets an `auto_memory` tool with `add`, `replace`, and `remove`. `replace` and `remove` match one entry by a unique substring. The tool result shows the live notes. Retrieve and create specialists do not get this tool.

This tool is not `write` or `edit`, so Standard permission does not ask for approval. If an add or replace would pass 2,000 characters, the tool returns an error and the current entries. The agent shortens or removes entries itself. Do not drop entries silently.
