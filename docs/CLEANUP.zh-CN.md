[English](./CLEANUP.md) | **简体中文**

# 待整理清单

> 记录已经失效、重复、名字仍停留在旧设计上，或纠缠到无法单独阅读的地方。这不是功能路线图（见 [TODO](./TODO.md)）；这里的每一条最终都应落到删除、重新接线、改名或拆分。
> 每条要写清：哪里不成形、为什么、涉及哪些符号、以及解开整理需要先做哪个决定。

---

## 1. 统一设置持久化，修复并发保存

**问题：** `ModelSettingsStore.update()` 的读改写没有串行保护，`save()` 直接覆盖文件。设置 UI 与 Agent 的 `update_settings` 可并发进入；临时文件复现中出现更新丢失及无效 JSON。Renderer 的 `SettingsSaveQueue` 只覆盖当前设置页。

**范围：** `app/src/main/models/model-settings-store.ts`、`main/settings/*-store.ts`、`main/mcp/store.ts`，以及 `main/index.ts` 的设置 IPC / `applySettingsPatch()`；现有原子写入和文件锁在 `main/models/chat-file.ts`。

**方向：** 抽出共用文件持久化原语，在主进程串行执行读取、应用补丁和原子提交；调用方提交实际变化，避免用旧的全量草稿覆盖其他更新。各功能保留自己的校验与存储类型。

**验收：** UI 与 Agent 并发修改不同设置时，两边更新均保留；读者始终得到完整文件；失败写入不破坏上次保存结果。覆盖 macOS 与 Windows 的替换行为。

## 2. 素材任务绑定库生命周期

**问题：** `LocalCore.openLibrary()` / `close()` 切换或关闭存储，却没有收束 enrichment、embedding 与多模态任务。已复现图片描述：A 库开始请求，切到 B 库后返回 `Asset not found`；重新打开 A，记录仍是 `describing`，详情按钮被禁用。

**范围：** `core/src/local-core.ts`、`enrichment/service.ts`、`rag/service.ts`、`rag/{image-vlm,video-vlm,audio-writeup}.ts`；app 的 `applyOpenedLibrary()` 与详情状态展示。

**方向：** 让任务及回写归属于启动时的库；切库、关闭时取消或等待任务收束，再切换存储。为中断遗留的 `describing` / `embedding` 状态提供恢复，禁止旧任务向新库写结果或发送更新。

**验收：** 请求中切库、排队时切库、关闭和重开均不会串库，也不会留下无法重试的运行状态。

## 3. 整合多模态描述服务的公共流程

**问题：** `core/src/rag/image-vlm.ts`、`video-vlm.ts`、`audio-writeup.ts` 重复维护串行队列、缓存新鲜度、状态转换、错误处理和记录更新。

**方向：** 先完成第 2 项的任务生命周期，再提取共用执行流程；图片读取、视频原生输入 / 抽帧、音频准备和各自的 provider 契约保留在媒体实现中。合并重复的状态处理，避免引入多层继承。

**验收：** 三类媒体的缓存命中、失败、取消和状态通知使用一致规则；媒体特有的输入限制与处理方式继续由各自测试覆盖。

## 4. 拆分职责过多的入口文件

**问题：** 目录已经按功能分组，但 `app/src/main/index.ts`、`app/src/renderer/App.tsx`、`core/src/local-core.ts` 仍集中多个职责。

**方向：** 优先从 main 入口移出素材协议、按功能分组的 IPC 注册和设置协调，入口保留启动装配与生命周期管理。App 抽出库操作、选区和素材任务状态；LocalCore 保留领域入口，将检索、媒体处理等实现归回对应模块。按职责逐步拆分，避免把原文件整体换个名字搬走。

**验收：** UI 和工具继续通过同一领域入口工作；无重复业务规则，相关 IPC、桌面流程和领域测试通过。

---

## 规则

- 一处失效或纠缠一个条目，写清涉及符号。
- 记录结论，不记录讨论过程。
- 代码删掉就删条目；已完成的工作记到[归档](./archive/ARCHIVE.zh-CN.md)。
