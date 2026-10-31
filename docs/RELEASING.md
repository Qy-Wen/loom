**English** | [简体中文](./RELEASING.zh-CN.md)

# One-command releases

Build macOS arm64/x64 and Windows x64 installers on a Mac, upload the same files to COS and GitHub, then update and deploy the website.

## Setup

1. Create a dedicated COS release bucket in Shanghai (`ap-shanghai`), with public read and private write. Store only public release files there. The script does not create buckets.
2. Install Node.js 22+, pnpm, [GitHub CLI](https://cli.github.com/), and the current [COSCLI](https://cloud.tencent.com/document/product/436/63144). Existing `pnpm dist` build prerequisites still apply.
3. Run `gh auth login` and `coscli config init`. COSCLI defaults to `~/.cos.yaml`. Its credentials need upload and object ACL permissions for the release bucket. Credentials remain in local tool configuration.
4. Copy `release.config.example.json` to `release.local.json`. Fill in the complete bucket name including its APPID suffix. Shanghai and `loom/releases` are preconfigured. A null `publicBaseUrl` uses the COS HTTPS origin; optionally specify a configured custom HTTPS origin.
5. Configure `website/deploy.local.json` using the [website instructions](../website/README.md), and make SSH authentication and host-key verification work on your Mac. The current server already has the Loom ingress route.

```bash
pnpm install
npm run website:deploy -- --preflight
```

Both local JSON files are ignored by Git and should not contain credentials. Commit and push the release scripts, website, and application changes before your first release. Publish from that commit on your Mac.

## Publish

Review the plan without building, authenticating, or changing remote state:

```bash
npm run release -- --version v0.1.0-alpha.1 --dry-run
```

Publish:

```bash
npm run release -- --version v0.1.0-alpha.1
```

Optionally add `--notes docs/releases/v0.1.0-alpha.1.md`; otherwise GitHub generates release notes. Prerelease versions are marked as GitHub prereleases; stable releases become latest. The version is injected into the packaged app without editing source package versions.

The workflow checks committed and pushed source, COS access, and website SSH; builds three installers plus `SHA256SUMS`; prepares a GitHub draft; uploads and verifies both download sources; publishes GitHub; generates `website/release-config.js`; then deploys and verifies the website.

COSCLI uses CRC64 transfer checking and adds SHA-256 object metadata for retry verification. GitHub assets are checked against their digest; older assets without one are downloaded and hashed.

## Retry behavior

- Repeat the same command with the same version, commit, and configuration. `.release-state/<version>/` retains the exact installers and progress.
- Conflicting files stop the release. Existing completed assets are never overwritten; changed content needs a new version.
- A failed website deployment leaves already published COS/GitHub assets available for retry. Cross-service publication is not atomic.
- Commit the generated `website/release-config.js` after success so ordinary website deployments retain the download links.
- Source must be clean except for the generated website config. The script does not commit, push source, or move existing Git tags.
- `.release-state/publish.lock` blocks concurrent local publishers. Remove a stale lock only after confirming the old process has stopped.
- Artifacts and verification downloads are retained in `.release-state/`; there is no automatic pruning.

```bash
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
```
