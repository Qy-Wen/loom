import { release } from "./release-config.js";
import { english } from "./translations.js";

const assets = [
  { id: "coast", image: "coast", type: "image", folder: "", name: { zh: "海岸的午后.svg", en: "coastal_afternoon.svg" }, terms: "海 海边 海岸 沙滩 旅行 sea ocean coast beach summer", info: "SVG · 640 × 440", size: "2.4 KB", favorite: true },
  { id: "mountain", image: "mountain", type: "image", folder: "", name: { zh: "山谷来信.svg", en: "letters_from_the_valley.svg" }, terms: "山 山谷 雾 绿 安静 自然 mountain valley mist green quiet nature", info: "SVG · 640 × 440", size: "2.1 KB" },
  { id: "dunes", image: "dunes", type: "image", folder: "references", name: { zh: "风经过沙丘.svg", en: "wind_over_dunes.svg" }, terms: "沙 沙漠 沙丘 风 暖 黄 desert sand dunes warm wind", info: "SVG · 640 × 440", size: "1.8 KB" },
  { id: "sunset", image: "sunset", type: "video", folder: "generated", name: { zh: "日落漫游.mp4", en: "sunset_wanderings.mp4" }, terms: "日落 黄昏 海 海边 海岸 视频 sunset dusk sea ocean coast beach video", info: "MP4 · 00:12", duration: "0:12", size: "4.7 MB", favorite: true },
  { id: "coast-detail", image: "coast", type: "image", folder: "references", variant: true, name: { zh: "海浪与留白.svg", en: "waves_and_space.svg" }, terms: "海 海边 海岸 沙滩 浪 细节 sea ocean coast beach waves detail", info: "SVG · 640 × 440", size: "2.4 KB" },
  { id: "cut", image: "sunset", type: "video", folder: "generated", name: { zh: "夏日短片.mp4", en: "summer_film.mp4" }, terms: "日落 黄昏 海 视频 剪辑 sunset dusk sea coast video clip", info: "MP4 · 00:05", duration: "0:05", size: "1.9 MB" },
];
const folders = [
  { id: "references", name: { zh: "参考与灵感", en: "References" }, image: "coast" },
  { id: "generated", name: { zh: "生成与实验", en: "Generated" }, image: "sunset" },
];
const translatedNodes = [...document.querySelectorAll("[data-i18n]")];
const originalText = new Map(translatedNodes.map((element) => [element, element.textContent]));
const translatedAttributes = [
  ["data-i18n-placeholder", "placeholder"], ["data-i18n-aria", "aria-label"], ["data-i18n-alt", "alt"],
].flatMap(([data, attribute]) => [...document.querySelectorAll('[' + data + ']')].map((element) => ({ element, attribute, key: element.getAttribute(data), original: element.getAttribute(attribute) })));
let language = "zh";
let view = "library";
let display = "icons";
let folder = "";
let panel = "chat";
let selectedId = "coast";
let openedId = null;
let direction = "asc";
let query = "";
let tableQuery = "";
const queryInput = document.querySelector("#asset-query");
const grid = document.querySelector("#asset-grid");
const languageSwitch = document.querySelector("#language-switch");
const workspace = document.querySelector(".app-window");
function text(zh, en) { return language === "en" ? en : zh; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function icon(name) { return '<svg class="demo-icon" viewBox="0 0 16 16" aria-hidden="true"><use href="#demo-' + name + '"/></svg>'; }
function folderName(id) { return id === "favorites" ? text("收藏", "Favorites") : folders.find((item) => item.id === id)?.name[language] ?? text("夏日漫游", "Summer"); }
function matches(asset, value) { return value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((word) => (asset.name.zh + " " + asset.name.en + " " + asset.terms).toLocaleLowerCase().includes(word)); }
function imageMarkup(asset) { return '<span class="asset-image"><img src="./assets/' + asset.image + '.svg" width="640" height="440" alt="">' + (asset.duration ? '<span class="video-badge">&#9655; ' + asset.duration + '</span>' : '') + '</span>'; }
function folderMarkup(item) { return '<span class="asset-image demo-folder-art"><span class="demo-folder-layers"><svg viewBox="0 0 100 88" aria-hidden="true"><path d="M10 74V18a6 6 0 0 1 6-6h22l8 9h38a6 6 0 0 1 6 6v47a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z" fill="#d4d4d0"/></svg><img src="./assets/' + item.image + '.svg" width="640" height="440" alt=""><svg viewBox="0 0 100 88" aria-hidden="true"><path d="M14 40h72a4 4 0 0 1 4 4v30a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V44a4 4 0 0 1 4-4Z" fill="#e5e5e2"/></svg></span></span>'; }
function updateSelection() {
  if (selectedId) for (const element of grid.querySelectorAll("[data-open-folder]")) element.classList.remove("selected");
  for (const element of workspace.querySelectorAll("[data-asset]")) {
    const active = element.dataset.asset === selectedId;
    element.classList.toggle("selected", active);
    if (element.tagName === "BUTTON") element.setAttribute("aria-pressed", String(active));
  }
  renderDetails();
}
function selectAsset(id, open = false) {
  if (!assets.some((asset) => asset.id === id)) return;
  selectedId = id;
  if (open) { openedId = id; view = "library"; display = "list"; renderAssets(); }
  else updateSelection();
}
function openFolder(id) {
  folder = id; query = ""; queryInput.value = ""; view = "library"; display = "icons"; renderAssets();
}
function renderDetails() {
  const asset = assets.find((item) => item.id === selectedId);
  const details = document.querySelector("#demo-details");
  if (!asset) { details.textContent = text("选择文件以查看属性。", "Select an asset to see its properties."); return; }
  const type = asset.type === "image" ? text("图片", "Image") : text("视频", "Video");
  const rows = [[text("文件名", "Name"), asset.name[language]], [text("类型", "Type"), type], [text("大小", "Size"), asset.size], [text("修改日期", "Modified"), "2026/11/01"], [text("尺寸", "Dimensions"), "640 × 440"]];
  if (asset.duration) rows.push([text("时长", "Duration"), asset.duration]);
  details.innerHTML = '<h3 class="demo-detail-heading">' + text("文件", "FILE") + '</h3><dl>' + rows.map(([key, value]) => '<dt>' + key + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl><section class="demo-detail-section"><h3 class="demo-detail-heading">' + text("标签", "TAGS") + '</h3><span class="demo-tag">' + text("旅行", "Travel") + '</span></section><section class="demo-detail-section"><h3 class="demo-detail-heading">' + text("关系", "RELATIONS") + '</h3><p>' + (asset.id === "cut" ? text("派生自：日落漫游.mp4", "Derived from: sunset_wanderings.mp4") : text("在图谱中查看与其他素材的关系。", "View connections to other assets in Graph.")) + '</p></section>';
}
function renderPreview() {
  const preview = document.querySelector("#demo-preview");
  const asset = assets.find((item) => item.id === openedId);
  if (!asset) { preview.innerHTML = '<div class="demo-preview-empty"><b>L</b><strong>' + text("选择一个素材", "Choose an asset") + '</strong><span>' + text("从左侧素材库选择文件以预览。", "Select a file from the library to preview it.") + '</span></div>'; return; }
  preview.innerHTML = '<div class="demo-preview-tab"><span>' + escapeHtml(asset.name[language]) + '</span><button type="button" data-close-preview aria-label="' + text("关闭预览", "Close preview") + '">' + icon('close') + '</button></div><div class="demo-preview-media"><img src="./assets/' + asset.image + '.svg" width="640" height="440" alt="' + escapeHtml(asset.name[language]) + '"></div><div class="demo-preview-caption">' + escapeHtml(asset.info) + ' · ' + text("示例素材", "Sample asset") + '</div>';
}
function renderTable() {
  const rows = assets.filter((asset) => matches(asset, tableQuery));
  document.querySelector("#demo-table-count").textContent = text(rows.length + " 个素材", rows.length + " assets");
  document.querySelector("#demo-table-body").innerHTML = rows.map((asset) => '<tr data-asset="' + asset.id + '"><td>' + escapeHtml(asset.name[language]) + '</td><td>' + (asset.type === "image" ? text("图片", "Image") : text("视频", "Video")) + '</td><td>' + asset.size + '</td><td>2026/11/01</td></tr>').join('');
  updateSelection();
}
function renderAssets() {
  workspace.dataset.workspaceView = view;
  workspace.dataset.display = display;
  for (const button of document.querySelectorAll("[data-view]")) { const active = button.dataset.view === view; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }
  for (const button of document.querySelectorAll("button[data-display]")) { const active = button.dataset.display === display; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }
  for (const button of document.querySelectorAll("[data-panel]")) { const active = button.dataset.panel === panel; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }
  for (const kind of ["library", "table", "graph"]) document.querySelector('#' + kind + '-view').hidden = view !== kind;
  document.querySelector("#demo-browser").hidden = display !== "icons";
  document.querySelector("#demo-preview").hidden = display !== "list";
  document.querySelector("#demo-chat").hidden = panel !== "chat";
  document.querySelector("#demo-details").hidden = panel !== "details";
  document.querySelector("#demo-direction .demo-icon:last-child").style.transform = direction === "desc" ? "rotate(180deg)" : "";
  const tree = document.querySelector("#demo-file-tree");
  const fileRow = (asset) => '<button type="button" class="demo-tree-asset" data-asset="' + asset.id + '"><img src="./assets/' + asset.image + '.svg" width="30" height="30" alt=""><span>' + escapeHtml(asset.name[language]) + '</span></button>';
  tree.innerHTML = folders.map((item) => '<button type="button" class="demo-tree-folder' + (folder === item.id ? ' active' : '') + '" data-folder="' + item.id + '">' + icon('chevron') + icon('folder') + escapeHtml(item.name[language]) + '</button>' + (display === "list" ? assets.filter((asset) => asset.folder === item.id).map(fileRow).join('') : '')).join('') + (display === "list" ? assets.filter((asset) => !asset.folder).map(fileRow).join('') : '');
  document.querySelector('[data-folder="favorites"]').classList.toggle('active', folder === "favorites");
  document.querySelector("#demo-crumbs").innerHTML = (folder ? '<button type="button" data-folder="">' + folderName("") + '</button>' + icon('chevron') : '') + '<span>' + folderName(folder) + '</span>';
  queryInput.placeholder = text("搜索", "Search in ") + folderName(folder);
  let visible = assets.filter((asset) => (folder === "favorites" ? asset.favorite : folder ? asset.folder === folder : query.trim() ? true : !asset.folder) && matches(asset, query));
  visible.sort((a, b) => a.name[language].localeCompare(b.name[language], language === "zh" ? "zh-CN" : "en") * (direction === "asc" ? 1 : -1));
  const visibleFolders = !folder && !query.trim() ? folders : [];
  grid.innerHTML = visibleFolders.map((item) => '<button type="button" class="asset-card folder" data-open-folder="' + item.id + '">' + folderMarkup(item) + '<span>' + escapeHtml(item.name[language]) + '</span></button>').join('') + visible.map((asset) => '<button type="button" class="asset-card' + (asset.variant ? ' variant' : '') + '" data-asset="' + asset.id + '" title="' + escapeHtml(asset.name[language]) + '">' + imageMarkup(asset) + '<span>' + escapeHtml(asset.name[language]) + '</span></button>').join('');
  const count = visible.length + visibleFolders.length;
  document.querySelector("#demo-empty").hidden = count !== 0;
  document.querySelector("#result-count").textContent = text(count + " 个项目", count + " items");
  renderPreview(); renderTable();
}

function validPublicUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function renderRelease() {
  const secondary = document.querySelector("#download-secondary");
  secondary.replaceChildren();
  let available = false;
  let hasDomestic = false;
  for (const button of document.querySelectorAll("[data-download]")) {
    const download = release.downloads[button.dataset.download];
    const domestic = validPublicUrl(download?.domestic);
    const github = validPublicUrl(download?.github);
    const url = domestic || github;
    if (!url) {
      button.removeAttribute("href");
      button.setAttribute("aria-disabled", "true");
      button.textContent = text("准备中", "Coming soon");
      continue;
    }
    available = true;
    hasDomestic ||= !!domestic;
    button.href = url;
    button.removeAttribute("aria-disabled");
    button.textContent = domestic ? text("国内下载 ↗", "Direct download ↗") : text("GitHub 下载 ↗", "GitHub download ↗");
    button.setAttribute("aria-label", `${button.closest(".download-row").querySelector("h3").textContent} ${button.closest(".download-row").querySelector(".download-detail").textContent}: ${button.textContent}`);
    if (domestic && github) {
      const link = document.createElement("a");
      link.href = github;
      link.textContent = `${button.closest(".download-row").querySelector("h3").textContent} ${button.closest(".download-row").querySelector(".download-detail").textContent} — ${text("GitHub 备用下载 ↗", "GitHub mirror ↗")}`;
      secondary.append(link);
    }
  }
  if (available) {
    document.querySelector("#release-status").textContent = `${release.version || "PREVIEW"} / ${text("可下载", "AVAILABLE")}`;
    document.querySelector('[data-i18n="download.eyebrow"]').textContent = text("预览版已就绪", "THE PREVIEW IS READY");
    document.querySelector('[data-i18n="download.description"]').textContent = text("选择适合你系统的预览版安装包。首次使用可参考上方快速开始，模型服务需按需配置。", "Choose a preview installer for your system. Follow the quick start above and configure model services as needed.");
    document.querySelector('[data-i18n="download.note"]').textContent = hasDomestic
      ? text("优先使用独立的国内下载源。部分系统的安装包可能仍在准备中。第三方模型 API 费用另计。", "Independent direct downloads are prioritized. Installers for some systems may still be in preparation. Third-party model API fees are separate.")
      : text("当前已提供的安装包通过 GitHub 下载，国内下载源仍在准备中。第三方模型 API 费用另计。", "Available installers are currently hosted on GitHub. Independent downloads for mainland China are still being prepared. Third-party model API fees are separate.");
    document.querySelector('[data-i18n="faq.a4"]').textContent = hasDomestic
      ? text("下载区已接入独立下载源。标有「国内下载」的按钮无需先访问 GitHub；各系统的可用状态请以下载区为准。", "Independent downloads are available in the download section. Buttons labeled “Direct download” do not require GitHub. Availability varies by system.")
      : text("当前可用的安装包仍通过 GitHub 下载。独立的国内下载源准备中，接入后会在下载区标明。", "Available installers are currently hosted on GitHub. Independent downloads are being prepared and will be labeled in the download section.");
  }
}

function applyLanguage(next) {
  language = next === "en" ? "en" : "zh";
  document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  for (const element of translatedNodes) element.textContent = language === "en" ? (english[element.dataset.i18n] ?? originalText.get(element)) : originalText.get(element);
  for (const item of translatedAttributes) item.element.setAttribute(item.attribute, language === "en" ? (english[item.key] ?? item.original) : item.original);
  languageSwitch.textContent = language === "en" ? "中文 ↗" : "EN ↗";
  languageSwitch.setAttribute("aria-label", language === "en" ? "切换到简体中文" : "Switch to English");
  languageSwitch.setAttribute("lang", language === "en" ? "zh-CN" : "en");
  const title = text("Loom — 让灵感，有迹可循。", "Loom — Follow your creative thread.");
  const description = text("Loom 是本地优先的开源 AI 创意素材工作台。用自然语言找素材，通过对话处理影像，让每一次创作有迹可循。", "Loom is an open-source, local-first AI workbench for creative assets. Find media in your own words, work through conversation, and connect every creation to its source.");
  document.title = title;
  document.querySelector('meta[name="description"]').content = description;
  document.querySelector('meta[property="og:title"]').content = title;
  document.querySelector('meta[property="og:description"]').content = description;
  try { localStorage.setItem("loom-language", language); } catch { /* Language switching also works when storage is unavailable. */ }
  renderAssets();
  renderRelease();
}

languageSwitch.addEventListener("click", () => {
  applyLanguage(language === "en" ? "zh" : "en");
  const url = new URL(location.href);
  url.searchParams.set("lang", language);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
});

workspace.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !workspace.contains(button)) return;
  if (button.dataset.view) { view = button.dataset.view; renderAssets(); }
  else if (button.dataset.display) { display = button.dataset.display; if (display === "list" && !openedId) openedId = selectedId; renderAssets(); }
  else if (button.dataset.panel) { panel = button.dataset.panel; renderAssets(); }
  else if (button.hasAttribute("data-folder")) openFolder(button.dataset.folder);
  else if (button.hasAttribute("data-open-folder")) {
    selectedId = null; updateSelection();
    for (const candidate of grid.querySelectorAll("[data-open-folder]")) candidate.classList.toggle("selected", candidate === button);
  } else if (button.dataset.openAsset) selectAsset(button.dataset.openAsset, true);
  else if (button.hasAttribute("data-close-preview")) { openedId = null; renderAssets(); }
  else if (button.dataset.asset) selectAsset(button.dataset.asset, button.classList.contains("demo-tree-asset"));
});
workspace.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-asset]");
  if (row) selectAsset(row.dataset.asset);
});
workspace.addEventListener("dblclick", (event) => {
  const folderTile = event.target.closest("[data-open-folder]");
  if (folderTile) { openFolder(folderTile.dataset.openFolder); return; }
  const asset = event.target.closest("[data-asset]");
  if (asset) selectAsset(asset.dataset.asset, true);
});
workspace.addEventListener("keydown", (event) => {
  const folderTile = event.target.closest("[data-open-folder]");
  if (event.key === "Enter" && folderTile) { event.preventDefault(); openFolder(folderTile.dataset.openFolder); }
});
document.querySelector("#demo-direction").addEventListener("click", () => { direction = direction === "asc" ? "desc" : "asc"; renderAssets(); });
document.querySelector("#demo-icon-size").addEventListener("input", (event) => workspace.style.setProperty("--demo-icon-size", event.target.value + "px"));
queryInput.addEventListener("input", () => { query = queryInput.value; renderAssets(); });
document.querySelector("#demo-search").addEventListener("submit", (event) => { event.preventDefault(); query = queryInput.value; renderAssets(); });
document.querySelector("#demo-table-query").addEventListener("input", (event) => { tableQuery = event.target.value; renderTable(); });

const repository = validPublicUrl(release.repository);
if (repository) for (const link of document.querySelectorAll("[data-repo-path]")) link.href = `${repository.replace(/\/$/, "")}${link.dataset.repoPath}`;
document.querySelector("#year").textContent = String(new Date().getFullYear());
let preferredLanguage;
try { preferredLanguage = localStorage.getItem("loom-language"); } catch { /* Use the default when storage is unavailable. */ }
applyLanguage(new URLSearchParams(location.search).get("lang") || preferredLanguage || "zh");
