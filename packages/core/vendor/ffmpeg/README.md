# Bundled FFmpeg

Platform binaries live in `win32-x64/`, `darwin-arm64/`, and `darwin-x64/`. They are downloaded, not committed.

FFmpeg and FFprobe are pinned to **9.0.2** in [`scripts/ffmpeg-builds.json`](../../../../scripts/ffmpeg-builds.json):

- Windows x64: [Gyan release essentials](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2), Windows 10 or later.
- macOS arm64 and x64: [Martin Riedl release builds](https://ffmpeg.martin-riedl.de/), minimum macOS 12 as recorded in the binaries. They link only to system libraries/frameworks.

These GPL builds include x264 and MP3 encoding. Whisper is not included.

```
pnpm vendor:ffmpeg        # current machine
pnpm vendor:ffmpeg -- --all
```

Archives are checked against pinned SHA-256 hashes and cached under `node_modules/.cache/ffmpeg/`. Existing installations are replaced when the pinned build changes or an installed binary fails its recorded checksum. Both replacement binaries are prepared before the old installation is replaced.

Set `LOOM_FFMPEG_MIRROR` to try a mirror before the original URLs. Mirror layout: `<prefix>/<platform>-<arch>/9.0.2/<archive filename>`; archive bytes must match the pinned hashes.
