[English](./PERMISSION.md) | **简体中文**

# 权限与沙箱

> 对话底部的权限，以及包住 bash 和 FFmpeg 的进程沙箱。

---

## 1. 权限

对话底部是 **Basic**、**Standard**（默认）、**Full**。存在应用用户数据 `agent-permission.json`，不进库。整个应用一份。

| 档位 | 先等 Approve / Skip |
|---|---|
| Basic | `write`、`edit`、`bash`，以及会写文件的 FFmpeg 工具 |
| Standard | 库外的 `write`、`edit` |
| Full | 不拦截 |

Standard 下，写在当前库里的 `write` 和 `edit` 直接执行。路径离开这个库仍要确认，包括 `..` 和指向库外的符号链接。路径不是字符串，或者解析失败，也要确认。Basic 仍对每次 `write`、`edit` 都要确认。

`bash` 和会写文件的 FFmpeg 工具（`extract_frame`、`extract_clip`、`resize_video`、`crop_video`、`convert_format`、`run_ffmpeg`）只在 Basic 下等待。`get_media_info` 只读，不拦截。MCP 和 `auto_memory` 不在这张名单里。检索专职和生成专职走同一道门。评测设成 Full，避免挂死。

Stop 取消这次等待。切到 Full 时，已经弹出的等待也会放行。

Pi `before_tool`（hook id `loom.tool_permission`）发出 `tool_pending`，工具卡片上继续之后才往下走。

---

## 2. 沙箱

设置 → Agent 里有进程沙箱开关，默认开，存在应用用户数据 `agent-sandbox.json`。下一条命令就用这个值。

开着时，`bash`、`ffmpeg`、`ffprobe` 跑在沙箱里：

- 可写：当前库和临时目录。
- 可读：用户目录不可读（macOS 是 `/Users`，Windows 是用户主目录的上一级），然后再放开当前库、临时目录，以及 shell、ffmpeg、ffprobe 所在目录。
- 网络：这些进程没有。应用自己照常请求模型。

关掉就直接在这台机器上跑。

Full permission 也直接跑。开关仍保存原样。离开 Full 后按这个开关恢复。

`read`、`edit`、`write` 仍在 Loom 进程内。检索专职和生成专职用的是同一个 `bash`，所以同样进沙箱。生成任务是 MCP server，不套这层沙箱。

没有打开的库，或者沙箱起不来，这条命令就不跑。Windows 上沙箱需要 Git Bash，并做一次管理员安装：`npx @anthropic-ai/sandbox-runtime windows-install`。
