[English](./RELEASING.md) | **简体中文**

# 一键发布

在 Mac 上构建 macOS arm64/x64 和 Windows x64 安装包，上传相同产物到 COS 与 GitHub，最后更新并部署发布网站。

## 首次配置

1. 在腾讯云 COS 创建专用的 Loom 安装包桶，地域选上海 `ap-shanghai`。桶设为「公有读、私有写」，仅存放公开发布文件。脚本不会创建存储桶。
2. 本机安装 Node.js 22+、pnpm、[GitHub CLI](https://cli.github.com/) 和最新版 [COSCLI](https://cloud.tencent.com/document/product/436/63144)。构建依赖沿用 `pnpm dist`。
3. 执行 `gh auth login` 和 `coscli config init`。COSCLI 配置默认为 `~/.cos.yaml`；使用具有发布桶上传和对象 ACL 权限的凭据。密钥留在本机工具配置中。
4. 复制根目录 `release.config.example.json` 为 `release.local.json`，填完整桶名（例如 `loom-downloads-1250000000`）。地域已设为上海；`publicBaseUrl: null` 会使用 COS 默认 HTTPS 下载域名，也可填写已配置好的自定义 HTTPS 域名。`prefix` 默认 `loom/releases`。
5. 按 [网站部署说明](../website/README.md) 配置 `website/deploy.local.json`，确认 Mac 的 SSH 密钥和主机指纹可用。现有服务器已安装 Loom 路由，只需通过连接预检。

```bash
pnpm install
npm run website:deploy -- --preflight
```

`release.local.json` 和 `website/deploy.local.json` 已被 Git 忽略，不应包含密钥。首次发布前将发布脚本、网站及应用修改提交并推送到 GitHub，再在 Mac 上使用该提交发布。

## 发布

先检查计划；此命令不构建、不连接远端，也不修改线上内容：

```bash
npm run release -- --version v0.1.0-alpha.1 --dry-run
```

正式发布（没有 `--dry-run`）：

```bash
npm run release -- --version v0.1.0-alpha.1
```

可选指定更新说明：

```bash
npm run release -- --version v0.1.0-alpha.1 --notes docs/releases/v0.1.0-alpha.1.md
```

未指定说明时使用 GitHub 自动生成的更新说明。带预发布后缀的版本标记为 GitHub prerelease；正式版标记为 latest。应用包的内嵌版本由同一版本参数注入，不修改源码 `package.json` 的版本。

脚本会：检查源码已提交且提交存在于 GitHub → 预检 COS 与网站 SSH → 构建三个安装包和 `SHA256SUMS` → 准备 GitHub 草稿 → 上传并验证 COS/GitHub 文件 → 发布 GitHub Release → 生成 `website/release-config.js` → 部署并验证网站。

网站的下载链接最后更新；COS 默认开启 CRC64 传输校验，并写入 SHA-256 元数据供重试核对。GitHub 使用资产 digest 校验；旧资产缺少 digest 时下载副本计算 SHA-256。

## 重试与版本

- 中断后使用相同命令、版本、提交和配置重试。`.release-state/<版本>/` 保存构建产物和进度，脚本复用原文件，核对两边已有文件。
- 同版本文件校验不一致时停止，不覆盖已上传的成品。新的应用内容使用新版本号。
- 发布网站失败时，COS 和 GitHub 上已经发布的文件保留，再次执行命令可继续；跨服务发布不是一个原子事务。
- 发布成功后提交生成的 `website/release-config.js`，保持以后普通网站部署使用相同下载地址。
- 普通发布要求工作区干净，允许生成的 `website/release-config.js` 待提交。脚本不会自动提交、推送源码或移动已有 Git 标签。
- `.release-state/publish.lock` 防止同一电脑并发发布。进程被强制结束后，只能在确认没有发布进程运行时移除遗留锁。
- 产物、上传进度和临时验证副本保留在 `.release-state/`；目前不自动清理。

```bash
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
```
