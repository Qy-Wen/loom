**English** | [简体中文](./MEMORY.zh-CN.md)

# Memory

> How the chat Agent remembers user preferences and creative conventions across sessions. Skills stay the place for procedures. Roadmap: [TODO](../TODO.md).

---

## 1. Where it lives

Notes for the open library live in `<library>/.agents/memory/MEMORY.md`. One file. About 2,000 characters. When the library opens, create `.agents/memory/` if it is missing. `.agents` is not indexed as assets. Skills in `.agents/skills/` are loaded from disk when the library opens.

Facts only: preferences and conventions for this library. A different library has a different file. Procedures stay in `.agents/skills/`.

---

## 2. System prompt

Read the file when a session starts and append that snapshot after the existing system prompt and the skills catalog. The snapshot stays byte-stable for the rest of the session.

`systemPrompt()` runs on every generation. Hold the snapshot on the session. Do not re-read the file each turn. A write during the session updates the file immediately. The next session reads it. The current session's system prompt does not change.

---

## 3. Tool

The parent chat Agent gets a `memory` tool with `add`, `replace`, and `remove`. `replace` and `remove` match one entry by a unique substring. The tool result shows the live notes. Retrieve and create specialists do not get this tool.

This tool is not `write` or `edit`, so Standard permission does not ask for approval. If an add or replace would pass 2,000 characters, the tool returns an error and the current entries. The agent shortens or removes entries itself. Do not drop entries silently.

---

## 4. Recall for the current message

Not in the first slice. The whole note is already in the system prompt, so there is nothing else to retrieve.

Later, text found for this message is appended in that same user message, inside `<system-reminder>`, together with the library highlight. Do not send a second user message. If nothing is selected and nothing was recalled, do not add the reminder.
