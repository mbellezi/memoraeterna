import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { arch, platform } from "node:process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformArch = `${platform}-${arch}`;
const definitionPath = join(root, "packages", "conversion", "sidecar", "runtime-manifest.json");
const definition = JSON.parse(await readFile(definitionPath, "utf8"));
const target = definition.platformArtifacts.find((candidate) => candidate.platform === platformArch);
if (!target) throw new Error(`No pinned Docling sidecar definition exists for ${platformArch}.`);

const managedRoot = resolve(root, "vendor", "sidecars", "docling");
const destination = resolve(managedRoot, platformArch);
assertManagedPath(destination);
const argumentsSet = new Set(process.argv.slice(2));

if (argumentsSet.has("--remove")) {
  await rm(destination, { recursive: true, force: true });
  console.info(`Removed generated Docling sidecar ${relative(root, destination)}.`);
  process.exit(0);
}

if (argumentsSet.has("--finalize-existing")) {
  await requireDirectory(destination);
  await cleanDownloadMetadata(destination);
  await verifyPackages(destination, target);
  await writeRuntimeManifest(destination, target, { offlineSmokeVerifiedAt: null });
  console.info(`Finalized existing Docling sidecar ${relative(root, destination)}.`);
  process.exit(0);
}

if (argumentsSet.has("--verify") || argumentsSet.has("--smoke")) {
  await verifyRuntime(destination, target);
  if (argumentsSet.has("--smoke")) {
    await runOfflineSmoke(destination);
    const manifest = JSON.parse(await readFile(join(destination, "runtime-manifest.json"), "utf8"));
    await writeJson(join(destination, "runtime-manifest.json"), {
      ...manifest,
      verification: { ...manifest.verification, offlineSmokeVerifiedAt: new Date().toISOString() }
    });
    console.info(`Verified an offline PDF conversion with ${relative(root, destination)}.`);
  } else {
    console.info(`Verified Docling sidecar ${relative(root, destination)}.`);
  }
  process.exit(0);
}

if (await exists(destination) && !argumentsSet.has("--force")) {
  await verifyRuntime(destination, target);
  console.info(`Docling sidecar already exists at ${relative(root, destination)}. Use --force to rebuild it.`);
  process.exit(0);
}

await mkdir(managedRoot, { recursive: true });
const staging = await mkdtemp(join(managedRoot, `.${platformArch}-build-`));
const archivePath = join(tmpdir(), `memora-cpython-${platformArch}-${randomUUID()}.tar.gz`);
try {
  await downloadPinned(target.pythonDistribution.source, target.pythonDistribution.sha256, archivePath);
  await run("tar", ["-xzf", archivePath, "-C", staging, "--strip-components=1"]);
  const python = pythonPath(staging);
  const requirementsPath = resolve(dirname(definitionPath), target.requirements);
  await run(python, ["-m", "pip", "install", "--no-cache-dir", "--no-compile", "--requirement", requirementsPath], {
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONNOUSERSITE: "1"
  });
  await downloadPinnedModels(staging, target.models);
  await cleanDownloadMetadata(staging);
  await verifyPackages(staging, target);
  await writeRuntimeManifest(staging, target, { offlineSmokeVerifiedAt: null });
  if (argumentsSet.has("--force")) await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  console.info(`Built Docling sidecar at ${relative(root, destination)}.`);
} finally {
  await rm(archivePath, { force: true });
  await rm(staging, { recursive: true, force: true });
}

async function downloadPinnedModels(runtimeRoot, models) {
  const artifacts = join(runtimeRoot, "artifacts");
  await mkdir(artifacts, { recursive: true });
  for (const model of models.filter((candidate) => candidate.repository.includes("/"))) {
    const localDirectory = join(artifacts, model.repository.replace("/", "--"));
    const code = [
      "import json, os",
      "from huggingface_hub import snapshot_download",
      "item = json.loads(os.environ['MEMORA_MODEL'])",
      "snapshot_download(repo_id=item['repository'], revision=item['revision'], local_dir=item['localDirectory'])"
    ].join("; ");
    await run(pythonPath(runtimeRoot), ["-c", code], {
      MEMORA_MODEL: JSON.stringify({ ...model, localDirectory }),
      HF_HOME: join(runtimeRoot, ".hf-cache"),
      HF_HUB_DISABLE_TELEMETRY: "1",
      PYTHONNOUSERSITE: "1"
    });
  }
  await run(join(runtimeRoot, "bin", "docling-tools"), [
    "models", "download", "rapidocr", "--output-dir", artifacts, "--quiet"
  ], {
    HF_HOME: join(runtimeRoot, ".hf-cache"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONNOUSERSITE: "1"
  });
}

async function verifyRuntime(runtimeRoot, targetDefinition) {
  await requireDirectory(runtimeRoot);
  const manifestPath = join(runtimeRoot, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.platform !== platformArch || manifest.pythonVersion !== definition.pythonVersion
      || manifest.doclingVersion !== definition.doclingVersion) {
    throw new Error("Docling runtime manifest does not match the pinned definition.");
  }
  await verifyPackages(runtimeRoot, targetDefinition);
  for (const expected of manifest.models) {
    const actual = await summarizeDirectory(resolve(runtimeRoot, expected.path), runtimeRoot);
    if (actual.fileCount !== expected.fileCount || actual.sizeBytes !== expected.sizeBytes
        || actual.manifestSha256 !== expected.manifestSha256) {
      throw new Error(`Docling model artifact verification failed: ${expected.repository}`);
    }
  }
}

async function verifyPackages(runtimeRoot, targetDefinition) {
  const requirementsPath = resolve(dirname(definitionPath), targetDefinition.requirements);
  const expected = parseRequirements(await readFile(requirementsPath, "utf8"));
  const { stdout } = await execFileAsync(pythonPath(runtimeRoot), ["-m", "pip", "freeze", "--all"], {
    env: { PATH: join(runtimeRoot, "bin"), PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    maxBuffer: 4 * 1024 * 1024
  });
  const installed = parseRequirements(stdout);
  for (const [name, version] of expected) {
    if (installed.get(name) !== version) throw new Error(`Pinned Docling package mismatch: ${name}==${version}`);
  }
  const { stdout: version } = await execFileAsync(pythonPath(runtimeRoot), [
    "-c", "import importlib.metadata as m; print(m.version('docling'))"
  ], { env: minimalOfflineEnvironment(runtimeRoot), maxBuffer: 1024 * 1024 });
  if (version.trim() !== definition.doclingVersion) throw new Error("Unexpected bundled Docling version.");
}

async function writeRuntimeManifest(runtimeRoot, targetDefinition, verification) {
  const requirementsPath = resolve(dirname(definitionPath), targetDefinition.requirements);
  const packages = [...parseRequirements(await readFile(requirementsPath, "utf8"))].map(([name, version]) => ({
    type: "python-package", name, version
  }));
  const models = [];
  for (const model of targetDefinition.models) {
    const path = model.repository.includes("/")
      ? join("artifacts", model.repository.replace("/", "--"))
      : join("artifacts", "RapidOcr");
    models.push({
      type: "model",
      repository: model.repository,
      revision: model.revision,
      path,
      ...await summarizeDirectory(resolve(runtimeRoot, path), runtimeRoot)
    });
  }
  await writeJson(join(runtimeRoot, "runtime-manifest.json"), {
    version: 1,
    platform: platformArch,
    pythonVersion: definition.pythonVersion,
    doclingVersion: definition.doclingVersion,
    pythonDistribution: targetDefinition.pythonDistribution,
    requirements: {
      file: targetDefinition.requirements,
      sha256: await sha256File(requirementsPath)
    },
    offlineByDefault: true,
    generatedAt: new Date().toISOString(),
    packages,
    models,
    verification
  });
}

async function runOfflineSmoke(runtimeRoot) {
  const directory = await mkdtemp(join(tmpdir(), "memora-docling-offline-"));
  const pdfPath = join(directory, "offline-smoke.pdf");
  const python = pythonPath(runtimeRoot);
  try {
    const createPdf = [
      "import os",
      "from PIL import Image, ImageDraw",
      "image=Image.new('RGB',(800,300),'white')",
      "ImageDraw.Draw(image).text((40,80),'Memora Eterna offline Docling smoke test',fill='black')",
      "image.save(os.environ['MEMORA_SMOKE_PDF'],'PDF')"
    ].join("; ");
    await run(python, ["-c", createPdf], { MEMORA_SMOKE_PDF: pdfPath, PYTHONNOUSERSITE: "1" });
    const messages = await requestJsonLines(python, [
      join(root, "packages", "conversion", "sidecar", "docling_sidecar.py")
    ], {
      protocolVersion: 3,
      requestId: randomUUID(),
      command: "convert",
      inputPath: pdfPath,
      profile: "standard",
      options: { maxPages: 5 }
    }, minimalOfflineEnvironment(runtimeRoot));
    const response = messages.find((message) => typeof message?.ok === "boolean");
    const pageProgress = messages.find((message) =>
      message?.type === "progress" && message?.stage === "processing_pages"
      && message?.completedPages === 1 && message?.totalPages === 1
    );
    if (!response?.ok || response.result?.engine !== "docling" || response.result?.engineVersion !== definition.doclingVersion) {
      throw new Error("Offline Docling smoke conversion failed.");
    }
    if (!pageProgress) throw new Error("Offline Docling smoke did not report page progress.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requestJsonLines(executable, args, request, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4 * 1024); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(`Docling smoke sidecar exited with ${code}: ${stderr}`));
        return;
      }
      try {
        const messages = stdout.split(/\r?\n/)
          .filter((candidate) => candidate.trim().startsWith("{"))
          .map((line) => JSON.parse(line));
        resolvePromise(messages);
      } catch (error) {
        rejectPromise(error);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function minimalOfflineEnvironment(runtimeRoot) {
  return {
    PATH: join(runtimeRoot, "bin"),
    HOME: join(runtimeRoot, ".runtime-home"),
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    DOCLING_ARTIFACTS_PATH: join(runtimeRoot, "artifacts"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: ""
  };
}

async function cleanDownloadMetadata(runtimeRoot) {
  await rm(join(runtimeRoot, ".hf-cache"), { recursive: true, force: true });
  const artifacts = join(runtimeRoot, "artifacts");
  if (!await exists(artifacts)) return;
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await rm(join(artifacts, entry.name, ".cache"), { recursive: true, force: true });
  }
}

async function summarizeDirectory(path, relativeRoot) {
  const files = await inventory(path, relativeRoot);
  const canonical = files.map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`).join("\n");
  return {
    fileCount: files.length,
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    manifestSha256: createHash("sha256").update(canonical).digest("hex")
  };
}

async function inventory(path, relativeRoot) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const targetPath = await readlink(path);
    return [{
      path: relative(relativeRoot, path),
      sizeBytes: Buffer.byteLength(targetPath),
      sha256: createHash("sha256").update(targetPath).digest("hex")
    }];
  }
  if (info.isFile()) return [{ path: relative(relativeRoot, path), sizeBytes: info.size, sha256: await sha256File(path) }];
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    files.push(...await inventory(join(path, entry.name), relativeRoot));
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function downloadPinned(url, expectedSha256, destinationPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  await pipeline(response.body, createWriteStream(destinationPath, { mode: 0o600 }));
  const actualSha256 = await sha256File(destinationPath);
  if (actualSha256 !== expectedSha256) throw new Error("Pinned CPython archive checksum mismatch.");
}

function parseRequirements(raw) {
  return new Map(raw.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([^#=\s]+)==([^\s]+)$/);
    return match ? [[normalizePackageName(match[1]), match[2]]] : [];
  }));
}

function normalizePackageName(name) {
  return name.toLowerCase().replace(/[_.]+/g, "-");
}

function pythonPath(runtimeRoot) {
  return platform === "win32" ? join(runtimeRoot, "python.exe") : join(runtimeRoot, "bin", "python3.13");
}

async function run(executable, args, extraEnv = {}) {
  await execFileAsync(executable, args, {
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireDirectory(path) {
  if (!await exists(path) || !(await lstat(path)).isDirectory()) {
    throw new Error(`Docling sidecar is missing: ${relative(root, path)}`);
  }
}

function assertManagedPath(path) {
  if (path !== managedRoot && !path.startsWith(`${managedRoot}${sep}`)) {
    throw new Error("Refusing to modify a Docling path outside vendor/sidecars/docling.");
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
