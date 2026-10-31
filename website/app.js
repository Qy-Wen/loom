import { release } from "./release-config.js";
import { english } from "./translations.js";

const assets = [
  { id: "coast", image: "coast", type: "image", name: { zh: "海岸的午后.svg", en: "coastal_afternoon.svg" }, terms: "海 海边 海岸 海滩 沙滩 旅行 sea ocean coast beach summer afternoon", info: "SVG · 640 × 440" },
  { id: "mountain", image: "mountain", type: "image", name: { zh: "山谷来信.svg", en: "letters_from_the_valley.svg" }, terms: "山 山谷 雾 绿 安静 自然 mountain valley mist green quiet nature", info: "SVG · 640 × 440" },
  { id: "dunes", image: "dunes", type: "image", name: { zh: "风经过沙丘.svg", en: "wind_over_dunes.svg" }, terms: "沙 沙漠 沙丘 风 暖 黄 desert sand dunes warm wind", info: "SVG · 640 × 440" },
  { id: "sunset", image: "sunset", type: "video", name: { zh: "日落漫游.mp4", en: "sunset_wanderings.mp4" }, terms: "日落 黄昏 海 海边 海岸 视频 sunset dusk sea ocean coast beach video", info: "MP4 · 00:12", duration: "0:12" },
  { id: "coast-detail", image: "coast", type: "image", variant: true, name: { zh: "海浪与留白.svg", en: "waves_and_space.svg" }, terms: "海 海边 海岸 沙滩 浪 细节 sea ocean coast beach waves detail", info: "SVG · 640 × 440" },
  { id: "mountain-film", image: "mountain", type: "video", variant: true, name: { zh: "向山里走去.mp4", en: "into_the_mountains.mp4" }, terms: "山 山谷 绿 雾 视频 mountain valley green mist nature video", info: "MP4 · 00:24", duration: "0:24" },
];

const translatedNodes = [...document.querySelectorAll("[data-i18n]")];
const originalText = new Map(translatedNodes.map((element) => [element, element.textContent]));
const translatedAttributes = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-aria", "aria-label"],
  ["data-i18n-alt", "alt"],
].flatMap(([data, attribute]) => [...document.querySelectorAll(`[${data}]`)].map((element) => ({ element, attribute, key: element.getAttribute(data), original: element.getAttribute(attribute) })));

let language = "zh";
let filter = "all";
let query = "";
const queryInput = document.querySelector("#asset-query");
const grid = document.querySelector("#asset-grid");
const languageSwitch = document.querySelector("#language-switch");

function text(zh, en) { return language === "en" ? en : zh; }

function renderAssets() {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = assets.filter((asset) => (filter === "all" || filter === asset.type) && words.every((word) => `${asset.name.zh} ${asset.name.en} ${asset.terms}`.toLocaleLowerCase().includes(word)));
  grid.replaceChildren(...visible.map((asset) => {
    const card = document.createElement("figure");
    card.className = `asset-card${asset.variant ? " variant" : ""}`;
    const imageFrame = document.createElement("div");
    imageFrame.className = "asset-image";
    const image = document.createElement("img");
    image.src = `./assets/${asset.image}.svg`;
    image.alt = "";
    image.width = 640;
    image.height = 440;
    imageFrame.append(image);
    if (asset.duration) {
      const badge = document.createElement("span");
      badge.className = "video-badge";
      badge.textContent = `▷ ${asset.duration}`;
      imageFrame.append(badge);
    }
    const caption = document.createElement("figcaption");
    caption.textContent = asset.name[language];
    caption.title = asset.name[language];
    const info = document.createElement("small");
    info.textContent = asset.info;
    card.append(imageFrame, caption, info);
    return card;
  }));
  document.querySelector("#demo-empty").hidden = visible.length !== 0;
  document.querySelector("#result-count").textContent = text(`${visible.length} 个示例`, `${visible.length} examples`);
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
  const feedback = document.querySelector("#domestic-feedback");
  feedback.replaceChildren();
  const feedbackUrl = validPublicUrl(release.feedbackUrl);
  if (feedbackUrl) {
    document.querySelector('[data-i18n="faq.a6"]').textContent = text("欢迎通过 GitHub Issues 反馈问题，或提交 Pull Request。也可以使用独立反馈入口。", "Report problems through GitHub Issues, contribute a Pull Request, or use the independent feedback channel.");
    const link = document.createElement("a");
    link.href = feedbackUrl;
    link.textContent = text(" 独立反馈入口 ↗", " Independent feedback ↗");
    feedback.append(link);
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

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const isLibrary = button.dataset.view === "library";
    document.querySelector("#library-view").hidden = !isLibrary;
    document.querySelector("#graph-view").hidden = isLibrary;
    for (const candidate of document.querySelectorAll("[data-view]")) {
      const active = candidate === button;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
  });
}
for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const candidate of document.querySelectorAll("[data-filter]")) {
      const active = candidate === button;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
    renderAssets();
  });
}
queryInput.addEventListener("input", () => { query = queryInput.value; renderAssets(); });
document.querySelector("#demo-search").addEventListener("submit", (event) => { event.preventDefault(); query = queryInput.value; renderAssets(); });

const repository = validPublicUrl(release.repository);
if (repository) for (const link of document.querySelectorAll("[data-repo-path]")) link.href = `${repository.replace(/\/$/, "")}${link.dataset.repoPath}`;
document.querySelector("#year").textContent = String(new Date().getFullYear());
let preferredLanguage;
try { preferredLanguage = localStorage.getItem("loom-language"); } catch { /* Use the default when storage is unavailable. */ }
applyLanguage(new URLSearchParams(location.search).get("lang") || preferredLanguage || "zh");
