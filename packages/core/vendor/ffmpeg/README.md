# Bundled FFmpeg

Platform binaries live in `win32-x64/`, `darwin-arm64/`, and `darwin-x64/`. They are downloaded, not committed.

```
pnpm vendor:ffmpeg        # current machine
pnpm vendor:ffmpeg -- --all
```

The script tries `cdn.npmmirror.com` first, then other GitHub proxies, then GitHub. Override the first URL prefix with `LOOM_FFMPEG_MIRROR`.
