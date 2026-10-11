[English](./PERMISSION.md) | **简体中文**

# 权限与沙箱

> 对话底部的权限，以及包住 bash 和 FFmpeg 的进程沙箱。

---

## 1. 权限

对话底部是 **Basic**、**Standard**（默认）、**Full**。存在应用用户数据 `agent-permission.json`，不进库。整个应用一份。

| 档位 | 先等 Approve / Skip |
|---|---|
| Basic | `write`、`edit`、`bash`、会写文件的 FFmpeg 工具，以及 `update_settings` |
| Standard | 库外的 `write`、`edit`，以及 `update_settings` |
| Full | 不拦截 |

Standard 下，写在当前库里的 `write` 和 `edit` 直接执行。路径离开这个库仍要确认，包括 `..` 和指向库外的符号链接。路径不是字符串，或者解析失败，也要确认。Basic 仍对每次 `write`、`edit` 都要确认。

`bash` 和会写文件的 FFmpeg 工具（`extract_frame`、`extract_clip`、`resize_video`、`crop_video`、`convert_format`、`grade_image`、`run_ffmpeg`）只在 Basic 下等待。`update_settings` 在 Basic 和 Standard 下都要确认。`get_settings` 只读，不拦截。`get_media_info` 只读，不拦截。MCP 和 `auto_memory` 不在这张名单里。检索专职和生成专职走同一道门。评测设成 Full，避免挂死。

Stop 取消这次等待。切到 Full 时再确认一次：进程沙箱这次不再生效，Agent 可以执行所有操作。沙箱开关保持原样。确认之后，已经弹出的等待也会放行。

工具卡片可以把这条命令记在当前库的 `<library>/.loom/command-allows.json`。同一个库里以后的会话不再询问。换一个库则无效。`bash` 记下去掉首尾空白的命令文本。`run_ffmpeg` 记下程序名和参数。`write` 和 `edit` 记下工具名和路径，不看文件内容。其余要确认的工具记下工具名。设置 → Agent 列出这些命令，可以忘掉一条。

Pi `before_tool`（hook id `loom.tool_permission`）发出 `tool_pending`，工具卡片上继续之后才往下走。

---

## 2. 沙箱

设置 → Agent 里有进程沙箱开关，默认开，存在应用用户数据 `agent-sandbox.json`。下一条命令就用这个值。

开着时，`bash`、`ffmpeg`、`ffprobe` 跑在沙箱里：

- 可写：当前库和临时目录。
- 可读：用户目录不可读（macOS 和 Linux 是 `/Users` 或 `/home`）。Windows 上沙箱进程是另一个账户，本来就读不到用户主目录，所以不改那里的权限。然后再放开当前库、临时目录，以及 shell、ffmpeg、ffprobe 所在目录。Program Files 和 Windows 目录本来就能读，不再另授一次。
- 网络：这些进程没有。应用自己照常请求模型。

关掉就直接在这台机器上跑。

Full permission 也直接跑。开关仍保存原样。离开 Full 后按这个开关恢复。

`read`、`edit`、`write` 仍在 Loom 进程内。检索专职和生成专职用的是同一个 `bash`，所以同样进沙箱。生成任务是 MCP server，不套这层沙箱。

没有打开的库，或者沙箱起不来，这条命令就不跑。Windows 上 ffmpeg 和 ffprobe 用 `cmd.exe` 在沙箱里跑。bash 工具仍然需要 Git Bash。`pnpm install` 在沙箱还没装时做一次管理员安装（一次 UAC），已经装好就跳过。
