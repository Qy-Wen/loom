**English** | [简体中文](./README.zh-CN.md)

# Loom

A local-first AI creative workspace built on one principle: **the filesystem is the source of truth, the database is the cognitive layer, and the Agent is the operational layer.**

See [`docs/`](./docs) for the design: [Product](./docs/PRODUCT.md), [Agent architecture](./docs/AGENT.md), and [Roadmap](./docs/TODO.md).

## Development

```bash
pnpm install
pnpm dev                              # Electron app (requires DEEPSEEK_API_KEY in .env)
pnpm --filter @loom/agent try:agent   # Smoke test: run one agent loop
pnpm test                             # All unit and integration tests
pnpm -r typecheck
```

## Vendored pi agent engine

Loom vendors the source of pi's [`packages/agent`](https://github.com/earendil-works/pi) into `packages/agent/vendor-pi-agent/`. Application code accesses it only through `packages/agent/src/pi-adapter.ts`, the sole `#vendor/pi-agent` import boundary. See [docs/AGENT.md](./docs/AGENT.md) for the complete design.

### Syncing and upgrading upstream

**Mental model:** the `vendor-clean` branch always represents pristine upstream source. `main` obtains vendor updates by merging that branch, and all local modifications live only on `main`.

The sync script at `packages/agent/vendor-pi-agent/sync.sh` shallow-clones a ref from GitHub, mirrors `packages/agent/src/` with `rsync --delete`, and records the repository, directory, ref, and commit in `UPSTREAM`. It does not require a local pi checkout and is idempotent for the same version.

```bash
# Initially create a normal branch from a commit containing the pristine vendor source.
git branch vendor-clean

# Fixed four-step upgrade flow:
git checkout vendor-clean
pnpm --filter @loom/agent vendor:sync v0.86.0
git commit -am "vendor: update pi-agent to v0.86.0 (pristine)"
git checkout main
git merge vendor-clean
```

**Two constraints:**

1. Syncing mirrors with `rsync --delete`; it does not merge. Run it **only on `vendor-clean`**.
2. Modify vendor source only on `main`. Put Loom-owned additions in `packages/agent/src/`, not inside `vendor-pi-agent/src/`, where the next sync would delete them.

**External dependencies:** the vendored agent requires `@earendil-works/{pi-ai,chord,pi-telemetry}` plus `diff`, `ignore`, `typebox`, and `yaml`. They remain npm dependencies of `@loom/agent` and must match the pi version recorded in `UPSTREAM`.
