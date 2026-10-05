**English** | [简体中文](./PERMISSION.zh-CN.md)

# Permission and sandbox

> The chat-footer permission, and the process sandbox around bash and FFmpeg.

---

## 1. Permission

The chat footer is **Basic**, **Standard** (default), or **Full**. Stored in app user data `agent-permission.json`, not in the library. One setting for the app.

| Level | Waits for Approve / Skip |
|---|---|
| Basic | `write`, `edit`, `bash`, and the FFmpeg tools that write a file |
| Standard | `write` and `edit` outside the open library |
| Full | nothing |

Standard runs `write` and `edit` inside the open library without asking. A path that leaves the library still waits, including `..` and a symlink that points outside. A path that is not a string, or that cannot be resolved, also waits. Basic still asks for every `write` and `edit`.

`bash` and the FFmpeg tools that write (`extract_frame`, `extract_clip`, `resize_video`, `crop_video`, `convert_format`, `run_ffmpeg`) wait only on Basic. `get_media_info` only reads, so it does not wait. MCP and `auto_memory` are not on this list. Retrieve and create specialists use the same gate. Evals set Full so they do not hang.

Stop cancels a wait. Switching to Full approves waits that are already open.

Pi `before_tool` (hook id `loom.tool_permission`) emits `tool_pending` and pauses until the tool card continues.

---

## 2. Sandbox

Settings → Agent has a process-sandbox switch, on by default, in app user data `agent-sandbox.json`. The next command uses it.

On, `bash`, `ffmpeg`, and `ffprobe` run in the sandbox:

- Write: the open library and the temp directory.
- Read: the user profile is denied (`/Users` on macOS, the parent of the home directory on Windows), then the library, the temp directory, and the directories of the shell, ffmpeg, and ffprobe are allowed again.
- Network: off for these processes. The app still calls the model.

Off, they run directly on this machine.

Full permission also runs them directly. The switch stays as saved. Leaving Full restores it.

`read`, `edit`, and `write` stay in the Loom process. Retrieve and create specialists share this sandbox, because they use the same `bash`. Generation stays an MCP server and is not wrapped in this sandbox.

No open library, or a sandbox that fails to start, does not run the command. On Windows the sandbox needs Git Bash, and a one-time admin install: `npx @anthropic-ai/sandbox-runtime windows-install`.
