import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { compareVersions, downloadUrls, installerNames, publishRelease, releaseVersion, validateReleaseConfig, validateReleaseFiles, websiteRelease } from "./release-lib.mjs";

const example = JSON.parse(await readFile(new URL("../release.config.example.json", import.meta.url), "utf8"));
const config = validateReleaseConfig({ ...example, cos: { ...example.cos, bucket: "loom-downloads-1250000000" } });
const tag = "v0.1.0-alpha.1";
const files = [
  ...Object.entries(installerNames(tag)).map(([platform, name]) => ({ platform, name, size: 123, sha256: "a".repeat(64) })),
  { platform: null, name: "SHA256SUMS", size: 234, sha256: "b".repeat(64) },
];

test("versions and ordering follow numeric SemVer and prerelease precedence", () => {
  assert.deepEqual(releaseVersion("0.1.0-alpha.1"), { version: "0.1.0-alpha.1", tag, prerelease: true });
  for (const invalid of [null, "latest", "1.2", "v01.2.3", "1.2.3-alpha.01", "1.2.3+build", "1.2.3/../../x"]) assert.throws(() => releaseVersion(invalid));
  const ascending = ["v0.1.0-alpha", "v0.1.0-alpha.2", "v0.1.0-alpha.10", "v0.1.0-beta", "v0.1.0-rc.1", "v0.1.0", "v0.2.0", "v0.10.0", "v1.0.0"];
  for (let index = 0; index < ascending.length - 1; index++) {
    assert.equal(compareVersions(ascending[index], ascending[index + 1]), -1);
    assert.equal(compareVersions(ascending[index + 1], ascending[index]), 1);
  }
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
});

test("dedicated COS configuration derives a Shanghai URL and rejects unsafe targets", () => {
  assert.equal(config.cos.publicBaseUrl, "https://loom-downloads-1250000000.cos.ap-shanghai.myqcloud.com");
  for (const change of [
    { repository: "../something" },
    { cos: { ...config.cos, bucket: "missing-appid" } },
    { cos: { ...config.cos, prefix: "../personal-site" } },
    { cos: { ...config.cos, publicBaseUrl: "http://download.example.com" } },
    { cos: { ...config.cos, publicBaseUrl: "https://secret@download.example.com" } },
    { cos: { ...config.cos, publicBaseUrl: "https://download.example.com/?q-signature=temporary" } },
  ]) assert.throws(() => validateReleaseConfig({ ...config, ...change }));
  const urls = downloadUrls(config, tag, files[0].name);
  assert.equal(urls.key, `loom/releases/${tag}/${files[0].name}`);
  assert.equal(urls.github, `https://github.com/Qy-Wen/loom/releases/download/${tag}/${files[0].name}`);
});

test("resume metadata only permits the exact expected artifact set", () => {
  assert.equal(validateReleaseFiles(files, tag), files);
  for (const invalid of [files.slice(1), [...files.slice(0, 3), files[0]], files.map((file, index) => index === 0 ? { ...file, name: "../../private.key" } : file), files.map((file) => ({ ...file, sha256: "invalid" }))]) assert.throws(() => validateReleaseFiles(invalid, tag));
});

test("website links preserve feedback, include both sources, and refuse a downgrade", () => {
  const current = { version: null, repository: "https://github.com/Qy-Wen/loom", feedbackUrl: "https://feedback.example.com/", downloads: {} };
  const updated = websiteRelease(current, config, tag, files);
  assert.equal(updated.feedbackUrl, current.feedbackUrl);
  assert.equal(updated.version, tag);
  assert.match(updated.downloads["windows-x64"].domestic, /ap-shanghai/);
  assert.match(updated.downloads["macos-arm64"].github, /mac-arm64\.dmg$/);
  assert.throws(() => websiteRelease({ ...current, version: "v0.2.0" }, config, tag, files));
  assert.throws(() => websiteRelease({ ...current, repository: "https://github.com/another/project" }, config, tag, files));
});

function fakeServices(events, overrides = {}) {
  return {
    build: async () => { events.push("build"); return files; },
    verifyLocal: async () => { events.push("verify-local"); },
    ensureDraft: async () => { events.push("draft"); return { id: 123 }; },
    ensureCos: async (file) => { events.push(`cos:${file.name}`); },
    ensureGitHub: async (_, file) => { events.push(`github:${file.name}`); },
    publishGitHub: async () => { events.push("publish-github"); },
    updateWebsite: async () => { events.push("update-website"); },
    deployWebsite: async () => { events.push("deploy-website"); },
    ...overrides,
  };
}

test("all uploads finish before GitHub publication and the website is deployed last", async () => {
  const events = [], state = {};
  await publishRelease({ state, services: fakeServices(events), save: async () => {} });
  assert.deepEqual(events.slice(0, 3), ["build", "verify-local", "draft"]);
  assert.deepEqual(events.slice(-3), ["publish-github", "update-website", "deploy-website"]);
  assert.equal(events.filter((event) => event.startsWith("cos:")).length, 4);
  assert.equal(events.filter((event) => event.startsWith("github:")).length, 4);
  assert.equal(state.completed, true);
});

test("upload failure leaves the website untouched and a retry reuses the exact build", async () => {
  const state = {}, first = [];
  await assert.rejects(publishRelease({ state, services: fakeServices(first, { ensureCos: async () => { throw new Error("network failure"); } }), save: async () => {} }), /network failure/);
  assert.equal(state.files, files);
  assert.equal(first.includes("publish-github"), false);
  assert.equal(first.includes("update-website"), false);
  const retry = [];
  await publishRelease({ state, services: fakeServices(retry), save: async () => {} });
  assert.equal(retry.includes("build"), false);
  assert.equal(state.completed, true);
});

test("GitHub publication failure never advertises draft download links", async () => {
  const events = [], state = {};
  await assert.rejects(publishRelease({ state, services: fakeServices(events, { publishGitHub: async () => { throw new Error("publish failed"); } }), save: async () => {} }), /publish failed/);
  assert.equal(events.includes("update-website"), false);
  assert.equal(state.githubPublished, undefined);
});

test("website failure keeps published assets resumable without rebuilding", async () => {
  const state = {}, events = [];
  await assert.rejects(publishRelease({ state, services: fakeServices(events, { deployWebsite: async () => { throw new Error("SSH unavailable"); } }), save: async () => {} }), /SSH unavailable/);
  assert.equal(state.githubPublished, true);
  assert.equal(state.completed, undefined);
  const retry = [];
  await publishRelease({ state, services: fakeServices(retry), save: async () => {} });
  assert.equal(retry.includes("build"), false);
  assert.equal(state.completed, true);
});

test("builder receives the release version and isolated artifact directory", () => {
  const require = createRequire(import.meta.url);
  const previousVersion = process.env.LOOM_RELEASE_VERSION;
  const previousDirectory = process.env.LOOM_RELEASE_DIR;
  try {
    process.env.LOOM_RELEASE_VERSION = "0.1.0-alpha.1";
    process.env.LOOM_RELEASE_DIR = "/tmp/loom-release-artifacts";
    const builder = require("../packages/app/electron-builder.cjs");
    assert.equal(builder.extraMetadata.version, "0.1.0-alpha.1");
    assert.equal(builder.directories.output, "/tmp/loom-release-artifacts");
    assert.equal(builder.artifactName, "Loom-${version}-${os}-${arch}.${ext}");
  } finally {
    if (previousVersion === undefined) delete process.env.LOOM_RELEASE_VERSION; else process.env.LOOM_RELEASE_VERSION = previousVersion;
    if (previousDirectory === undefined) delete process.env.LOOM_RELEASE_DIR; else process.env.LOOM_RELEASE_DIR = previousDirectory;
  }
});
