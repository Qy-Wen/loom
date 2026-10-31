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

Edit `release-config.js`. Use `null` for unpublished installers; the page displays “Coming soon”. Set HTTPS links only. `domestic` is the independent download URL, prioritized over the optional `github` mirror. Version, download availability, and feedback copy update in both languages.

修改 `release-config.js`：未发布的安装包保持 `null`，页面显示「准备中」。下载与反馈地址只接受 HTTPS。`domestic` 为独立的国内下载地址，优先于可选的 `github` 备用地址。版本、下载状态和反馈文案会同步更新两种语言。

```js
version: "v0.1.0-alpha.1",
feedbackUrl: "https://your-feedback-service.example/form",
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
