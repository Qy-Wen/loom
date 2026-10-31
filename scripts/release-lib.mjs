import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function releaseVersion(input) {
  const version = String(input ?? "").replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(version)) throw new Error("Use a version such as v0.1.0 or v0.1.0-alpha.1 (without build metadata).");
  const prerelease = version.split("-").slice(1).join("-");
  if (prerelease.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("Numeric prerelease identifiers cannot have leading zeros.");
  return { version, tag: `v${version}`, prerelease: !!prerelease };
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const version = releaseVersion(value).version;
    const dash = version.indexOf("-");
    return { numbers: (dash < 0 ? version : version.slice(0, dash)).split(".").map(BigInt), pre: dash < 0 ? [] : version.slice(dash + 1).split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

export function validateReleaseConfig(config) {
  config = structuredClone(config);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.repository || "")) throw new Error("repository must be OWNER/REPO.");
  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(config.cos?.bucket || "")) throw new Error("Set cos.bucket to the complete dedicated bucket name, including its APPID suffix.");
  if (!/^[a-z][a-z0-9-]+$/.test(config.cos.region || "")) throw new Error("Set the COS region (for example ap-shanghai).");
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(config.cos.prefix || "")) throw new Error("cos.prefix must be a relative object prefix without traversal or shell characters.");
  config.cos.publicBaseUrl ||= `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com`;
  let url;
  try { url = new URL(config.cos.publicBaseUrl); } catch { throw new Error("Set cos.publicBaseUrl to the public HTTPS download origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("cos.publicBaseUrl must be an HTTPS origin without a path, credentials, query, or fragment.");
  if (typeof config.cos.configPath !== "string" || !config.cos.configPath || /[\r\n\0]/.test(config.cos.configPath)) throw new Error("Set cos.configPath to your local COSCLI configuration file.");
  if (typeof config.websiteDeployConfig !== "string" || !config.websiteDeployConfig) throw new Error("Set websiteDeployConfig to the website deployment configuration.");
  return config;
}

export function installerNames(input) {
  const { version } = releaseVersion(input);
  return {
    "windows-x64": `Loom-${version}-win-x64.exe`,
    "macos-arm64": `Loom-${version}-mac-arm64.dmg`,
    "macos-x64": `Loom-${version}-mac-x64.dmg`,
  };
}

export function downloadUrls(config, tag, name) {
  const key = `${config.cos.prefix}/${tag}/${name}`;
  return {
    key,
    domestic: `${new URL(config.cos.publicBaseUrl).origin}/${key.split("/").map(encodeURIComponent).join("/")}`,
    github: `https://github.com/${config.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  };
}

export function validateReleaseFiles(files, tag) {
  const names = installerNames(tag);
  const expected = new Map([...Object.entries(names).map(([platform, name]) => [name, platform]), ["SHA256SUMS", null]]);
  if (!Array.isArray(files) || files.length !== expected.size) throw new Error("Release state must contain all three installers and SHA256SUMS.");
  const seen = new Set();
  for (const file of files) {
    if (!expected.has(file.name) || seen.has(file.name) || file.platform !== expected.get(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Release state has unexpected or invalid artifact metadata.");
    seen.add(file.name);
  }
  return files;
}

export function websiteRelease(current, config, tag, files) {
  if (current.version && compareVersions(tag, current.version) < 0) throw new Error(`Refusing to replace website version ${current.version} with older version ${tag}.`);
  const expectedRepository = `https://github.com/${config.repository}`;
  if (current.repository?.replace(/\/$/, "") !== expectedRepository) throw new Error("The website repository and publishing repository differ.");
  const downloads = {};
  for (const platform of Object.keys(installerNames(tag))) {
    const file = files.find((entry) => entry.platform === platform);
    if (!file) throw new Error(`Missing installer for ${platform}.`);
    const urls = downloadUrls(config, tag, file.name);
    downloads[platform] = { domestic: urls.domestic, github: urls.github };
  }
  return { ...current, version: tag, downloads };
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// External services are injected so interruption and retry behavior can be tested without publishing.
export async function publishRelease({ state, services, save }) {
  if (!state.files) {
    state.files = await services.build();
    await save(state);
  }
  await services.verifyLocal(state.files);
  const remote = await services.ensureDraft();
  for (const file of state.files) {
    await services.ensureCos(file);
    await services.ensureGitHub(remote, file);
  }
  await services.publishGitHub(remote);
  state.githubPublished = true;
  await save(state);
  await services.updateWebsite(state.files);
  // A failed website deployment can be retried without rebuilding or replacing published assets.
  await services.deployWebsite();
  state.completed = true;
  await save(state);
}
