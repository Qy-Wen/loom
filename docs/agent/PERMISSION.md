**English** | [简体中文](./PERMISSION.zh-CN.md)

# Permission and sandbox

> The chat-footer permission, and the process sandbox around bash and FFmpeg.

---

## 1. Permission

The chat footer is **Basic**, **Standard** (default), or **Full**. Stored in app user data `agent-permission.json`, not in the library. One setting for the app.

| Level | Waits for Approve / Skip |
|---|---|
| Basic | `write`, `edit`, `bash`, the FFmpeg tools that write a file, `update_settings`, and MCP tools |
| Standard | `write` and `edit` outside the open library, `update_settings`, and MCP tools |
| Full | nothing |

Standard runs `write` and `edit` inside the open library without asking. A path that leaves the library still waits, including `..` and a symlink that points outside. A path that is not a string, or that cannot be resolved, also waits. Basic still asks for every `write` and `edit`.

`bash` and the FFmpeg tools that write (`extract_frame`, `extract_clip`, `resize_video`, `crop_video`, `convert_format`, `grade_image`, `run_ffmpeg`) wait only on Basic. `update_settings` and all MCP tools (`server__tool`) wait on Basic and Standard, unless the user has remembered a grant for that tool. MCP grants apply to that server/tool across arguments. Full runs them directly. `get_settings`, `get_media_info`, and `auto_memory` do not wait. Parent chat and specialists use the same gate. Evals set Full so they do not hang.

Stop cancels a wait. Switching to Full asks once more: the process sandbox will not apply, and the agent can run every operation. The sandbox switch stays as saved. Confirming approves waits that are already open.

The tool card can remember that command in the open library, `<library>/.loom/command-allows.json`. Later sessions in that library skip the prompt. Another library does not. `bash` stores the command text with the ends trimmed. `run_ffmpeg` stores the program and its arguments. `write` and `edit` store the tool and the path, not the file contents. The other gated tools store the tool name. Settings → Agent lists these and can forget one.

The `loom.permission` extension installs a cancellable `ToolTask.beforeTool` hook. Pending calls persist in `LoomApprovalsDoc`; AG-UI watches it and publishes `loom.tool_gate`. IDs are namespaced by conversation, including specialist calls. Stop clears waits; reopen clears stale document rows before durable recovery asks again.

---

## 2. Sandbox

Settings → Agent has a process-sandbox switch, on by default, in app user data `agent-sandbox.json`. The next command uses it.

On, `bash`, `ffmpeg`, and `ffprobe` run in the sandbox:

- Write: the open library and the temp directory.
- Read: the user profile is denied (`/Users` on macOS and Linux). On Windows the sandboxed process is another account, which already cannot read the profile, so that directory is left unchanged. The library, the temp directory, and the directories of the shell, ffmpeg, and ffprobe are allowed. Program Files and Windows are already readable, so they are not granted again.
- Network: off for these processes. The app still calls the model.

Off, they run directly on this machine.

Full permission also runs them directly. The switch stays as saved. Leaving Full restores it.

`read`, `edit`, and `write` stay in the Loom process. Retrieve and create specialists share this sandbox, because they use the same `bash`. Generation stays an MCP server and is not wrapped in this sandbox.

With the sandbox on, no open library prevents execution. On macOS/Linux, sandbox startup failure also prevents execution. On Windows, initialization failure turns the saved switch off and runs commands directly after cleanup and failure reporting finish; concurrent commands wait for that transition. The failure notice is retained in `agent-sandbox.json` and displayed after startup, reload or restart until dismissed. Dismissal does not re-enable the sandbox.

On Windows, ffmpeg and ffprobe run under `cmd.exe`. The bash tool still needs Git Bash. `pnpm install` provisions the sandbox user the first time it is missing (one UAC prompt) and skips that step once it is in place.
