import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const website = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const begin = "# BEGIN LOOM WEBSITE";
const end = "# END LOOM WEBSITE";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function validateConfig(config) {
  for (const key of ["host", "user", "domain", "remoteDirectory", "ingressNetwork", "ingressContainer", "ingressConfig", "image"]) {
    if (typeof config[key] !== "string" || !config[key] || /[\r\n\0]/.test(config[key])) throw new Error(`Invalid deployment config: ${key}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.host)) throw new Error("host must be an IPv4 address or hostname.");
  if (!/^[a-z_][a-zA-Z0-9_-]*$/.test(config.user)) throw new Error("Invalid SSH user.");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(config.domain)) throw new Error("domain must be a plain lowercase domain name, without a protocol or path.");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid SSH port.");
  for (const key of ["remoteDirectory", "ingressConfig"]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(config[key]) || config[key].split("/").includes("..") || config[key].split("/").filter(Boolean).length < 3) throw new Error(`${key} must be a specific absolute remote path without spaces or shell characters.`);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(config.ingressNetwork) || !/^[a-zA-Z0-9_.-]+$/.test(config.ingressContainer)) throw new Error("Invalid Docker network or ingress container name.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(config.image)) throw new Error("Invalid Docker image.");
  if (config.sshBackend && !["native", "wsl"].includes(config.sshBackend)) throw new Error("sshBackend must be native or wsl.");
  return config;
}

export function ingressConfiguration(current, domain) {
  const block = `${begin}\n${domain} {\n  encode zstd gzip\n  reverse_proxy loom-website:80\n}\n${end}`;
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  if (start !== -1 || finish !== -1) {
    if (start < 0 || finish < start || current.indexOf(begin, start + begin.length) !== -1 || current.indexOf(end, finish + end.length) !== -1) throw new Error("Malformed or duplicate Loom ingress markers; resolve them before deploying.");
    return `${current.slice(0, start)}${block}${current.slice(finish + end.length)}`;
  }
  if (current.includes(domain)) throw new Error("This domain already appears in the ingress configuration. Review its existing route before using --setup-ingress.");
  return `${current.trimEnd()}\n\n${block}\n`;
}

function run(command, args, { capture = false, input, cwd } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { if (capture) output += chunk; else process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { if (capture) errorOutput += chunk; else process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited with status ${code}${capture && errorOutput ? `: ${errorOutput.trim()}` : ""}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function transport(config) {
  const wsl = (config.sshBackend || (process.platform === "win32" ? "wsl" : "native")) === "wsl";
  const execute = (program, args, options) => wsl ? run("wsl", ["--exec", program, ...args], options) : run(program, args, options);
  const options = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10"];
  const target = `${config.user}@${config.host}`;
  return {
    ssh: (command, runOptions) => execute("ssh", [...options, "-p", String(config.port), target, command], runOptions),
    upload: async (source, destination) => {
      const localPath = wsl ? (await run("wsl", ["--exec", "wslpath", "-u", source], { capture: true })).trim() : source;
      const entries = (await readdir(source)).map((name) => `${localPath.replaceAll("\\", "/")}/${name}`);
      await execute("scp", [...options, "-P", String(config.port), "-r", ...entries, `${target}:${destination}/`]);
    },
  };
}

async function manifest(directory, prefix = "") {
  const lines = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) lines.push(...await manifest(directory, name));
    else if (entry.isFile()) lines.push(`${createHash("sha256").update(await readFile(join(directory, name))).digest("hex")}  ${name}`);
    else throw new Error(`Refusing to deploy a symlink or special file: ${name}`);
  }
  return lines;
}

async function verifyPublic(config, expectedId) {
  const url = `https://${config.domain}`;
  console.log(`Checking public HTTPS: ${url}`);
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const deploymentResponse = await fetch(`${url}/deployment.json?check=${Date.now()}`, { signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!deploymentResponse.ok) throw new Error(`Deployment endpoint returned HTTP ${deploymentResponse.status}`);
      const deployed = await deploymentResponse.json();
      if (expectedId && deployed.release !== expectedId) throw new Error("The public site is still serving a different release.");
      const page = await fetch(`${url}/`, { signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!page.ok || !(await page.text()).includes("Loom —")) throw new Error("The public page did not return the Loom website.");
      console.log(`Verified: ${url}\nRelease: ${deployed.release}`);
      return;
    } catch (error) {
      lastError = error;
      console.log(`HTTPS check ${attempt}/12: ${error.cause?.message || error.message}`);
      if (attempt < 12) await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
    }
  }
  throw new Error(`Origin deployment is retained, but public HTTPS could not be verified: ${lastError?.message}. Check DNS and certificate issuance, then run npm run website:deploy -- --verify-only.`);
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string", default: join(website, "deploy.local.json") },
    "setup-ingress": { type: "boolean", default: false },
    "verify-only": { type: "boolean", default: false },
    "skip-public-check": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    preflight: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run website:deploy [-- --setup-ingress | --verify-only | --dry-run | --preflight]\nConfig: website/deploy.local.json (copy deploy.config.example.json first).\nWindows uses WSL SSH; macOS and Linux use native SSH. --skip-public-check deploys only the origin.");
    return;
  }
  if (values["verify-only"] && (values["setup-ingress"] || values["skip-public-check"] || values["dry-run"])) throw new Error("--verify-only cannot be combined with deployment flags.");
  if (values.preflight && ["verify-only", "setup-ingress", "skip-public-check", "dry-run"].some((key) => values[key])) throw new Error("--preflight cannot be combined with other deployment modes.");
  let config;
  try { config = validateConfig(JSON.parse(await readFile(resolve(values.config), "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Copy website/deploy.config.example.json to website/deploy.local.json and review the deployment target first. Do not store passwords or keys in it.");
    throw error;
  }
  console.log(`Target: ${config.user}@${config.host}:${config.port}${config.remoteDirectory}\nWebsite: https://${config.domain}`);
  if (values["verify-only"]) { await verifyPublic(config); return; }
  if (values.preflight) {
    const client = transport(config);
    const ingress = await client.ssh(`cat ${shellQuote(config.ingressConfig)}`, { capture: true });
    if (!ingress.includes(`${config.domain} {`) || !ingress.includes(begin)) throw new Error("Install the Loom ingress route with --setup-ingress before publishing installers.");
    await client.ssh(`sudo -n docker network inspect ${shellQuote(config.ingressNetwork)} >/dev/null`);
    await client.ssh(`sudo -n docker exec ${shellQuote(config.ingressContainer)} caddy version`);
    console.log("Website SSH and ingress preflight passed; no server files were changed.");
    return;
  }
  await run(process.execPath, [join(website, "scripts/build.mjs")]);
  if (values["dry-run"]) {
    console.log(`Dry run: no SSH connections or remote changes.\nUpload an isolated release, check SHA-256, switch the current symlink, and health-check the independent container.${values["setup-ingress"] ? "\nValidate and reload the shared Caddy route on the server." : "\nKeep the shared Caddy configuration unchanged."}`);
    return;
  }

  const client = transport(config);
  const remoteIngress = await client.ssh(`cat ${shellQuote(config.ingressConfig)}`, { capture: true });
  let nextIngress;
  if (values["setup-ingress"]) {
    nextIngress = ingressConfiguration(remoteIngress, config.domain);
  } else if (!remoteIngress.includes(`${config.domain} {`) || !remoteIngress.includes(begin)) {
    throw new Error("The Loom ingress route is not installed. Run npm run website:deploy -- --setup-ingress once.");
  }

  const releaseId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
  const bundle = await mkdtemp(join(tmpdir(), "loom-website-"));
  await cp(join(website, "dist"), join(bundle, "site"), { recursive: true });
  await writeFile(join(bundle, "site/deployment.json"), `${JSON.stringify({ release: releaseId, deployedAt: new Date().toISOString() })}\n`);
  for (const name of ["compose.yaml", "Caddyfile", "deploy-remote.sh"]) await cp(join(website, "deploy", name), join(bundle, name));
  await writeFile(join(bundle, "SHA256SUMS"), `${(await manifest(join(bundle, "site"))).join("\n")}\n`);
  await writeFile(join(bundle, "deploy.env"), `LOOM_INGRESS_NETWORK=${config.ingressNetwork}\nLOOM_CADDY_IMAGE=${config.image}\n`);
  if (nextIngress) {
    await writeFile(join(bundle, "ingress.Caddyfile"), nextIngress);
    await writeFile(join(bundle, "ingress.previous"), remoteIngress);
  }
  const remoteStage = `${config.remoteDirectory}/incoming/${releaseId}`;
  console.log(`Uploading release ${releaseId}`);
  await client.ssh(`mkdir -p ${shellQuote(remoteStage)}`);
  await client.upload(bundle, remoteStage);
  console.log("Validating and activating the origin release…");
  await client.ssh(["bash", `${remoteStage}/deploy-remote.sh`, config.remoteDirectory, releaseId, values["setup-ingress"] ? "1" : "0", config.ingressContainer, config.ingressConfig].map(shellQuote).join(" "));

  if (values["skip-public-check"]) console.log("Origin is ready. Public HTTPS was not verified. Run npm run website:deploy -- --verify-only when DNS is ready.");
  else await verifyPublic(config, releaseId);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`\nDeployment failed: ${error.message}`); process.exitCode = 1; });
}
