# Loom website / 发布页

Independent, bilingual static website. Requires Node.js 22+, no package installation. All assets are local; no runtime API, analytics, external fonts, or CDN dependencies. The workspace illustration uses preset examples, not a screenshot or a live AI service.

独立的中英文静态介绍页。需要 Node.js 22+，无需安装依赖。所有素材随站点提供，无外部字体、CDN、统计或 API 请求。交互工作台为预置示意，并非实际截图或在线 AI。

## Preview / 预览

From the repository root / 在仓库根目录运行：

```sh
npm run website:dev
# http://127.0.0.1:4173
# English: http://127.0.0.1:4173/?lang=en
```

Optional port / 自定义端口：`npm run website:dev -- --port 4174`.

## Release configuration / 发布配置

For automatic installer uploads and download-link generation, see [one-command releases](../docs/RELEASING.md) / 安装包自动上传和下载地址自动生成见[一键发布说明](../docs/RELEASING.zh-CN.md)。

Edit `release-config.js`. Use `null` for unpublished installers; the page displays “Coming soon”. Set HTTPS links only. `domestic` is the independent download URL, prioritized over the optional `github` mirror. Version and download availability update in both languages.

修改 `release-config.js`：未发布的安装包保持 `null`，页面显示「准备中」。下载地址只接受 HTTPS。`domestic` 为独立的国内下载地址，优先于可选的 `github` 备用地址。版本和下载状态会同步更新两种语言。

```js
version: "v0.1.0-alpha.1",
downloads: {
  "windows-x64": { domestic: "https://your-download-domain.example/Loom-win-x64.exe", github: null },
  "macos-arm64": { domestic: null, github: null },
  "macos-x64": { domestic: null, github: null },
}
```

These are illustrative URLs. Replace them with real endpoints before publishing. No deployment credentials belong in this file or in browser code.

以上为示例地址，发布前替换为真实入口。部署凭据不应写入此文件或任何浏览器代码。

## Build and host / 构建与托管

```sh
npm run website:build
node website/scripts/serve.mjs --dist
```

Upload **the contents of `website/dist/`** to your static hosting account, or use the server deployment below. The site supports both root domains and subdirectory hosting, with no SPA rewrites. Host installation files separately and link them in the release config.

将 **`website/dist/` 内的内容**上传到你自己的静态托管账号，或使用下方服务器部署命令。支持域名根路径与子目录部署，不需要 SPA 路由重写。安装包单独托管，在发布配置中填入链接。

## One-command server deployment / 一键部署到服务器

Production URL / 线上地址：**https://loom.sanzang.site**

The website runs in its own Docker Compose project, sharing only the existing Caddy ingress network. qy-site application code and database are independent. No local Docker installation is required.

发布页运行在独立的 Docker Compose 项目中，只共用现有 Caddy 入口网络。与 qy-site 应用代码、数据库独立；本机不需要安装 Docker。

### First setup / 首次配置

1. Point the `loom` DNS A record at your server / 将 `loom` 的 A 记录指向服务器。
2. Copy `deploy.config.example.json` to `deploy.local.json` and review the target paths. The local file is ignored by Git. Do not put passwords or private keys in it / 复制配置模板为 `deploy.local.json`，确认目标地址与路径；该文件已被 Git 忽略，不要写入密码或私钥。
3. Ensure SSH key authentication works and the server host key is already trusted. Windows uses WSL SSH by default; macOS/Linux use native SSH. Override with `sshBackend: "native"` or `"wsl"` if needed / 确认 SSH 密钥认证可用、主机指纹已被信任。Windows 默认使用 WSL 的 SSH，macOS/Linux 使用本机 SSH；可通过 `sshBackend` 覆盖。
4. The server needs Docker Compose with `up --wait`, passwordless `sudo docker`, the configured shared network, and the configured Caddy image already present / 服务器需要支持 `up --wait` 的 Docker Compose、免密码 `sudo docker`、配置中的共享网络，以及已有的 Caddy 镜像。

```sh
# Preview the target; no SSH or server changes / 预览目标，不连接或修改服务器
npm run website:deploy -- --dry-run --setup-ingress

# Install the shared ingress route once / 首次安装路由并部署
npm run website:deploy -- --setup-ingress
```

First setup adds the Loom route to the server's Caddyfile, validates the new configuration, and gracefully reloads Caddy. Keep the same route in qy-site's version-controlled Caddyfile so later personal-site deployments preserve it. Loom deployment requires only the local Loom checkout.

首次接入会在服务器的 Caddyfile 中添加 Loom 路由，验证新配置后平滑重载 Caddy。在 qy-site 项目中维护并提交相同路由，确保以后部署个人站时保留配置。部署 Loom 只需本机的 Loom 项目。

### Subsequent updates / 后续更新

From the repository root / 在 Loom 仓库根目录运行：

```sh
npm run website:deploy
```

This builds the static files, uploads a unique release over SSH, verifies SHA-256, atomically switches the served directory, waits for container health, and checks the public HTTPS page against the uploaded release ID. Failed origin activation restores the previous directory; prior releases remain on disk. The shared ingress configuration is unchanged during normal updates.

脚本会构建静态文件，经 SSH 上传独立版本，校验 SHA-256，原子切换目录，等待容器健康，并核对公开 HTTPS 页面的版本。源站激活失败会恢复上一版本目录，旧版本保留在服务器上。普通更新不修改共享入口配置。

```sh
# Only verify public HTTPS / 只验证公网 HTTPS
npm run website:deploy -- --verify-only

# Deploy the origin without claiming public HTTPS success / 仅部署源站
npm run website:deploy -- --skip-public-check

# Validate deployment helpers / 检查部署辅助逻辑
node --test website/scripts/deploy.test.mjs
```

If only the public check fails, the healthy origin stays deployed. Check DNS/certificate issuance, then use `--verify-only`; no new upload is needed. Local temporary bundles and remote incoming/release directories are retained for diagnosis and are not automatically pruned.

如果仅公网检查失败，健康的源站会保留。排查 DNS 或证书后执行 `--verify-only` 即可，无需重新上传。本地临时包及远端 incoming/releases 目录保留用于排查，不会自动清理。

Only grant publishing access to your account. Store future CI credentials in repository/environment secrets, restrict the publishing branch, and require your approval for production deployment. A public clone contains the site code, not your hosting credentials.

发布权限仅授予你自己的账号。以后接入 CI 时，将凭据保存为仓库或环境 Secret，限制可发布分支，设置由你审批生产部署。公开克隆只包含网页代码，不包含托管凭据。
