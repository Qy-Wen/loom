[English](./MEMORY.md) | **简体中文**

# 记忆

> 主对话怎样跨会话记住用户偏好和这个库的创作约定。做法仍写成 skill。

---

## 1. 放在哪

当前库的笔记在 `<library>/.loom/agents/memory/MEMORY.md`。一份文件，大约 2000 字。首次写入时创建记忆目录。`.loom` 不收成素材。`.loom/agents/skills/` 的目录在准备请求时读取。

只记事实：用户偏好和这个库的约定。换一个库就是另一份文件。做法放在 `.loom/agents/skills/`。

---

## 2. 系统提示

会话开始时读入这份文件，接在现有系统提示和 skill 目录后面。这一轮会话里，这份快照的字节保持不变。

`LoomMemoryDoc` 在库的 durable SQLite 中保存创建时快照，prompt section 读取 document 而非文件。fork 和重开保留该快照。工具修改立即落盘；新会话读到修改，已有会话不变。

---

## 3. 工具

主对话有一个 `auto_memory` 工具，动作是 `add`、`replace`、`remove`。`replace` 和 `remove` 用一段能唯一对上的原文定位一条笔记。工具结果给出最新全文。检索专职和生成专职不带这个工具。

它不是 `write` / `edit`，Standard 权限不会为此再要一次确认。增或改之后超过约 2000 字时，工具返回错误和当前条目。由模型自己缩短或删掉再写。不要悄悄丢掉旧条目。
