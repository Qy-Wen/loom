import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareVersions, downloadUrls, installerNames, publishRelease, releaseVersion, sha256, validateReleaseConfig, validateReleaseFiles, websiteRelease } from "./release-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const websiteConfig = join(root, "website/release-config.js");
const stateRoot = join(root, ".release-state");
const localPath = (path) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(root, path);

function run(program, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { if (capture) stdout += chunk; else process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { if (capture) stderr += chunk; else process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(Object.assign(new Error(`${program} failed (${code})${capture ? `: ${stderr.trim()}` : ""}`), { code, stderr, stdout }));
    });
  });
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function loadJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function currentWebsiteRelease() {
  return (await import(`${pathToFileURL(websiteConfig).href}?read=${randomBytes(4).toString("hex")}`)).release;
}

function missing(error) { return /HTTP 404|release not found|Not Found \(HTTP 404\)/i.test(error.stderr || ""); }
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function main() {
  const { values } = parseArgs({ options: {
    version: { type: "string" },
    config: { type: "string", default: join(root, "release.local.json") },
    notes: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run release -- --version v0.1.0-alpha.1 [--notes path/to/notes.md] [--dry-run]\nBuild on a Mac, publish identical installers to COS and GitHub, then update and deploy the website.\nRetry the same command to resume. Credentials stay in gh/COSCLI/SSH configuration.");
    return;
  }
  const version = releaseVersion(values.version);
  const raw = await loadJson(resolve(values.config)) || (values["dry-run"] ? await loadJson(join(root, "release.config.example.json")) : null);
  if (!raw) throw new Error("Copy release.config.example.json to release.local.json and fill in the dedicated COS bucket first.");
  const names = installerNames(version.tag);
  if (values["dry-run"]) {
    console.log(`Plan only: ${version.tag}\nRepository: ${raw.repository}\nCOS: ${raw.cos?.bucket || "<set the dedicated bucket>"} (${raw.cos?.region}) / ${raw.cos?.prefix}/${version.tag}/\nMac build → GitHub draft → COS and GitHub uploads → publish GitHub → update website → deploy website\nInstallers:\n${Object.values(names).map((name) => `  ${name}`).join("\n")}\nNo build, authentication, upload, GitHub changes, or deployment performed.`);
    return;
  }
  const config = validateReleaseConfig(raw);
  const directory = join(stateRoot, version.tag);
  await mkdir(directory, { recursive: true });
  const lockPath = join(stateRoot, "publish.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("A publish.lock exists in .release-state. Ensure no publisher is running before removing a stale lock.");
    throw error;
  }
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, version: version.tag, startedAt: new Date().toISOString() })}\n`);
  try {
    const statePath = join(directory, "state.json");
    let state = await loadJson(statePath);
    if (!state?.files && process.platform !== "darwin") throw new Error("The complete installer build must run on a Mac. Use --dry-run to review the workflow on Windows/Linux.");
    const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
    const dirty = (await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { capture: true })).split("\0").filter(Boolean).filter((line) => line.slice(3) !== "website/release-config.js");
    if (dirty.length) throw new Error("Commit your source changes before releasing. Only the generated website/release-config.js change is allowed during a retry.");
    const current = await currentWebsiteRelease();
    if (current.version && compareVersions(version.tag, current.version) < 0) throw new Error(`The website already advertises newer version ${current.version}.`);
    if (current.repository?.replace(/\/$/, "") !== `https://github.com/${config.repository}`) throw new Error("The publishing and website repositories differ.");
    const notes = values.notes ? await readFile(localPath(values.notes), "utf8") : null;
    const fingerprint = createHash("sha256").update(JSON.stringify({ config, notes })).digest("hex");
    if (state && (state.commit !== commit || state.fingerprint !== fingerprint || state.version !== version.tag)) throw new Error("This version already has a different commit or release configuration in .release-state. Resume with the original inputs or choose a new version.");
    state ||= { schema: 1, version: version.tag, commit, fingerprint };
    const save = (value) => atomicJson(statePath, value);

    const gh = (args, options = {}) => run("gh", args, { capture: true, ...options });
    const api = async (endpoint) => JSON.parse(await gh(["api", endpoint]));
    const cosConfigPath = localPath(config.cos.configPath);
    const cosOptions = ["--config-path", cosConfigPath, "--endpoint", `cos.${config.cos.region}.myqcloud.com`];
    const deployConfig = localPath(config.websiteDeployConfig);
    console.log(`Publishing ${version.tag} from commit ${commit}\nCOS bucket: ${config.cos.bucket}\nRepository: ${config.repository}`);
    await run("gh", ["--version"]);
    await run("coscli", ["--version"]);
    await access(cosConfigPath);
    await access(deployConfig);
    const repository = await api(`repos/${config.repository}`);
    if (!repository.permissions?.push) throw new Error("Your gh account needs write access to the publishing repository.");
    if ((await api(`repos/${config.repository}/commits/${commit}`)).sha !== commit) throw new Error("Push the exact source commit to GitHub before publishing.");
    let tagObject;
    try { tagObject = (await api(`repos/${config.repository}/git/ref/tags/${version.tag}`)).object; }
    catch (error) { if (!missing(error)) throw error; }
    for (let depth = 0; tagObject?.type === "tag" && depth < 5; depth++) tagObject = (await api(`repos/${config.repository}/git/tags/${tagObject.sha}`)).object;
    if (tagObject && (tagObject.type !== "commit" || tagObject.sha !== commit)) throw new Error("The remote tag points to a different source commit; it will not be moved.");
    await run("coscli", ["ls", `cos://${config.cos.bucket}/`, ...cosOptions], { capture: true });
    await run(process.execPath, [join(root, "website/scripts/deploy.mjs"), "--config", deployConfig, "--preflight"]);
    await save(state);

    const artifactDirectory = join(directory, "artifacts");
    async function fileRecord(name, platform = null) {
      const path = join(artifactDirectory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty installer: ${name}`);
      return { name, platform, size: info.size, sha256: await sha256(path) };
    }
    async function publicHead(file) {
      const url = downloadUrls(config, version.tag, file.name).domestic;
      return fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(20000) });
    }
    function checkCosFile(response, file) {
      if (Number(response.headers.get("content-length")) !== file.size || response.headers.get("x-cos-meta-sha256") !== file.sha256) throw new Error(`COS object differs from the local release; refusing to overwrite ${file.name}. Use a new version.`);
    }
    async function githubAssetMatches(asset, file) {
      if (asset.size !== file.size) throw new Error(`GitHub asset size conflicts: ${file.name}`);
      if (asset.digest) {
        if (asset.digest !== `sha256:${file.sha256}`) throw new Error(`GitHub asset checksum conflicts: ${file.name}`);
      } else {
        // Older GitHub assets may have no digest; verify a downloaded copy instead of guessing.
        const verificationDirectory = await mkdtemp(join(directory, "verify-"));
        const output = join(verificationDirectory, file.name);
        await gh(["release", "download", version.tag, "--repo", config.repository, "--pattern", file.name, "--output", output]);
        if (await sha256(output) !== file.sha256) throw new Error(`GitHub asset checksum conflicts: ${file.name}`);
      }
    }

    await publishRelease({ state, save, services: {
      build: async () => {
        console.log("Building macOS arm64/x64 and Windows x64 installers…");
        await run(process.execPath, [join(root, "scripts/dist.mjs")], { env: { ...process.env, LOOM_RELEASE_VERSION: version.version, LOOM_RELEASE_DIR: artifactDirectory } });
        const files = [];
        for (const [platform, name] of Object.entries(names)) files.push(await fileRecord(name, platform));
        await writeFile(join(artifactDirectory, "SHA256SUMS"), `${files.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`);
        files.push(await fileRecord("SHA256SUMS"));
        return files;
      },
      verifyLocal: async (files) => {
        validateReleaseFiles(files, version.tag);
        for (const file of files) {
          const actual = await fileRecord(file.name, file.platform);
          if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new Error(`Local release file changed: ${file.name}. Retain the original files or use a new version.`);
        }
      },
      ensureDraft: async () => {
        let release;
        try { release = JSON.parse(await gh(["release", "view", version.tag, "--repo", config.repository, "--json", "databaseId,isDraft"])); }
        catch (error) {
          if (!missing(error)) throw error;
          const args = ["release", "create", version.tag, "--repo", config.repository, "--target", commit, "--draft", "--title", `Loom ${version.tag}`];
          if (version.prerelease) args.push("--prerelease");
          if (notes !== null) {
            const notesPath = join(directory, "release-notes.md");
            await writeFile(notesPath, notes);
            args.push("--notes-file", notesPath);
          } else args.push("--generate-notes");
          await gh(args);
          release = JSON.parse(await gh(["release", "view", version.tag, "--repo", config.repository, "--json", "databaseId,isDraft"]));
        }
        const remote = await api(`repos/${config.repository}/releases/${release.databaseId}`);
        if (remote.prerelease !== version.prerelease) throw new Error("The existing GitHub release has a different prerelease status.");
        if (!tagObject && remote.target_commitish !== commit) {
          const target = await api(`repos/${config.repository}/commits/${encodeURIComponent(remote.target_commitish)}`);
          if (target.sha !== commit) throw new Error("The existing GitHub draft targets a different source commit; it will not be published.");
        }
        return remote;
      },
      ensureCos: async (file) => {
        let response = await publicHead(file);
        if (response.ok) { checkCosFile(response, file); console.log(`COS already verified: ${file.name}`); return; }
        if (response.status !== 404) throw new Error(`COS public download returned ${response.status}. Configure public read for the dedicated release bucket/prefix before retrying.`);
        console.log(`Uploading to COS: ${file.name}`);
        const urls = downloadUrls(config, version.tag, file.name);
        await run("coscli", ["cp", join(artifactDirectory, file.name), `cos://${config.cos.bucket}/${urls.key}`, ...cosOptions, "--acl", "public-read", "--meta", `x-cos-meta-sha256:${file.sha256}#Content-Type:application/octet-stream#Content-Disposition:attachment; filename=\"${file.name}\"`]);
        for (let attempt = 0; attempt < 5; attempt++) {
          response = await publicHead(file);
          if (response.ok) { checkCosFile(response, file); return; }
          if (attempt < 4) await wait(1000);
        }
        throw new Error(`Uploaded COS object is not publicly downloadable: ${file.name} (HTTP ${response.status}).`);
      },
      ensureGitHub: async (remote, file) => {
        let asset = remote.assets.find((item) => item.name === file.name);
        if (asset?.state === "starter" && remote.draft) {
          await gh(["release", "delete-asset", version.tag, file.name, "--repo", config.repository, "--yes"]);
          asset = null;
        }
        if (asset) { await githubAssetMatches(asset, file); console.log(`GitHub already verified: ${file.name}`); return; }
        if (!remote.draft) throw new Error(`Published release is missing ${file.name}; published assets will not be modified.`);
        console.log(`Uploading to GitHub: ${file.name}`);
        await gh(["release", "upload", version.tag, join(artifactDirectory, file.name), "--repo", config.repository], { capture: false });
        Object.assign(remote, await api(`repos/${config.repository}/releases/${remote.id}`));
        asset = remote.assets.find((item) => item.name === file.name);
        if (!asset) throw new Error(`GitHub upload could not be verified: ${file.name}`);
        await githubAssetMatches(asset, file);
      },
      publishGitHub: async (remote) => {
        if (!remote.draft) return;
        await gh(["release", "edit", version.tag, "--repo", config.repository, "--draft=false", version.prerelease ? "--latest=false" : "--latest"]);
        const published = await api(`repos/${config.repository}/releases/${remote.id}`);
        if (published.draft) throw new Error("GitHub release is still a draft; the website was not updated.");
      },
      updateWebsite: async (files) => {
        const next = websiteRelease(await currentWebsiteRelease(), config, version.tag, files);
        const temporary = `${websiteConfig}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temporary, `// Generated by npm run release. Public download information only.\nexport const release = ${JSON.stringify(next, null, 2)};\n`);
        await rename(temporary, websiteConfig);
      },
      deployWebsite: () => run(process.execPath, [join(root, "website/scripts/deploy.mjs"), "--config", deployConfig]),
    } });
    console.log(`\nRelease complete: ${version.tag}\nhttps://github.com/${config.repository}/releases/tag/${version.tag}\nCommit the updated website/release-config.js to preserve the public download configuration.`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`\nRelease stopped: ${error.message}`); process.exitCode = 1; });
}
