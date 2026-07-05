import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, opendir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const force = process.argv.includes("--force");
const postgresVersion = "18.4";
const edbBuild = "2";
const pgvectorVersion = "0.8.4";
const ageTag = "PG18/v1.7.0-rc0";
const sourcePage = "https://www.postgresql.org/download/macosx/";
const edbBinariesPage = "https://www.enterprisedb.com/download-postgresql-binaries";
const sourceUrl = "https://sbp.enterprisedb.com/getfile.jsp?fileid=1260320";
const directUrl = "https://get.enterprisedb.com/postgresql/postgresql-18.4-2-osx-binaries.zip";
const pgvectorUrl = `https://github.com/pgvector/pgvector/archive/refs/tags/v${pgvectorVersion}.tar.gz`;
const ageUrl = `https://github.com/apache/age/archive/refs/tags/${ageTag}.tar.gz`;
const platform = process.platform;
const arch = process.arch;

if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
  throw new Error(`PostgreSQL sidecar install currently supports macOS arm64/x64 only. Current: ${platform}-${arch}`);
}

const cacheDir = resolve(rootDir, ".cache/sidecars/postgres");
const zipPath = resolve(cacheDir, `postgresql-${postgresVersion}-${edbBuild}-osx-binaries.zip`);
const pgvectorTarPath = resolve(cacheDir, `pgvector-${pgvectorVersion}.tar.gz`);
const ageTarPath = resolve(cacheDir, `apache-age-${ageTag.replaceAll("/", "-")}.tar.gz`);
const installRoot = resolve(rootDir, "vendor/sidecars/postgres", `${platform}-${arch}`, `postgresql-${postgresVersion}`);
const stagingRoot = resolve(cacheDir, `extract-${process.pid}`);
const pgvectorBuildRoot = resolve(cacheDir, `pgvector-${pgvectorVersion}-build`);
const ageBuildRoot = resolve(cacheDir, `apache-age-${ageTag.replaceAll("/", "-")}-build`);
const manifestPath = resolve(installRoot, "memora-sidecar.json");

await run(process.execPath, [resolve(rootDir, "scripts/setup-dev-env.mjs")]);
await ensureDownloaded();
const sha256 = await hashFile(zipPath);
await installArchive();
await validateInstall();
await installPgvector();
await installAge();
await writeManifest(sha256);

console.info(`PostgreSQL ${postgresVersion} sidecar installed at ${relative(rootDir, installRoot)}`);

async function ensureDownloaded() {
  await mkdir(cacheDir, { recursive: true });
  if (!force && (await exists(zipPath))) {
    return;
  }

  await download(directUrl, zipPath);
}

async function installArchive() {
  if (!force && (await exists(resolve(installRoot, "bin/initdb")))) {
    return;
  }

  await rm(stagingRoot, { recursive: true, force: true });
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await run("ditto", ["-x", "-k", zipPath, stagingRoot]);

  const payloadRoot = await findPayloadRoot(stagingRoot);
  await mkdir(dirname(installRoot), { recursive: true });
  await cp(payloadRoot, installRoot, { recursive: true, force: true, preserveTimestamps: true });
  await repairInternalSymlinks(installRoot, payloadRoot);
  await rm(stagingRoot, { recursive: true, force: true });
}

async function validateInstall() {
  for (const binary of ["initdb", "postgres", "pg_ctl", "pg_isready", "createdb", "psql"]) {
    const binaryPath = resolve(installRoot, "bin", binary);
    await access(binaryPath);
    await chmod(binaryPath, 0o755);
  }

  const result = await run(resolve(installRoot, "bin/postgres"), ["--version"]);
  if (!result.stdout.includes("PostgreSQL") || !result.stdout.includes(postgresVersion)) {
    throw new Error(`Unexpected postgres version output: ${result.stdout || result.stderr}`);
  }
}

async function installPgvector() {
  const controlFile = resolve(installRoot, "share/postgresql/extension/vector.control");
  if (!force && (await exists(controlFile))) {
    await ensureExtensionLoaderAlias("vector");
    return;
  }

  await downloadIfMissing(pgvectorUrl, pgvectorTarPath);
  await rm(pgvectorBuildRoot, { recursive: true, force: true });
  await mkdir(pgvectorBuildRoot, { recursive: true });
  await run("tar", ["-xzf", pgvectorTarPath, "-C", pgvectorBuildRoot, "--strip-components=1"]);

  const env = {
    ...process.env,
    PG_CONFIG: resolve(installRoot, "bin/pg_config")
  };
  const sdkPath = await getMacSdkPath();
  const makeArgs = sdkPath ? [`PG_SYSROOT=${sdkPath}`] : [];
  await run("make", makeArgs, { cwd: pgvectorBuildRoot, env });
  await run("make", ["install", ...makeArgs], { cwd: pgvectorBuildRoot, env });
  await ensureExtensionLoaderAlias("vector");
}

async function installAge() {
  const controlFile = resolve(installRoot, "share/postgresql/extension/age.control");
  if (!force && (await exists(controlFile))) {
    await ensureExtensionLoaderAlias("age");
    return;
  }

  await downloadIfMissing(ageUrl, ageTarPath);
  await rm(ageBuildRoot, { recursive: true, force: true });
  await mkdir(ageBuildRoot, { recursive: true });
  await run("tar", ["-xzf", ageTarPath, "-C", ageBuildRoot, "--strip-components=1"]);

  const pgConfig = resolve(installRoot, "bin/pg_config");
  const sdkPath = await getMacSdkPath();
  const perlPath = await findCommand("perl");
  const makeArgs = [`PG_CONFIG=${pgConfig}`];
  if (sdkPath) {
    makeArgs.push(`PG_SYSROOT=${sdkPath}`);
  }
  if (perlPath) {
    makeArgs.push(`PERL=${perlPath}`);
  }

  await run("make", makeArgs, { cwd: ageBuildRoot, env: process.env });
  await run("make", ["install", ...makeArgs], { cwd: ageBuildRoot, env: process.env });
  await ensureExtensionLoaderAlias("age");
}

async function writeManifest(sha256) {
  const manifest = {
    name: "postgresql",
    version: postgresVersion,
    edbBuild,
    platform,
    arch,
    sourcePage,
    edbBinariesPage,
    sourceUrl,
    directUrl,
    archive: {
      path: relative(rootDir, zipPath),
      sha256
    },
    extensions: {
      pgvector: {
        version: pgvectorVersion,
        sourceUrl: pgvectorUrl,
        installed: true
      },
      age: {
        tag: ageTag,
        sourceUrl: ageUrl,
        installed: true
      }
    },
    install: {
      root: relative(rootDir, installRoot),
      binDir: relative(rootDir, resolve(installRoot, "bin")),
      libDir: relative(rootDir, resolve(installRoot, "lib")),
      shareDir: relative(rootDir, resolve(installRoot, "share"))
    },
    notes: [
      "EDB binary zip is linked from the official PostgreSQL macOS download page.",
      "Development path is repository vendor/sidecars; production packaging must copy this under resources/sidecars.",
      "Data directories must be created under Electron userData, never inside this install root."
    ],
    installedAt: new Date().toISOString()
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function findPayloadRoot(root) {
  const candidates = [
    resolve(root, "pgsql"),
    resolve(root, "postgresql"),
    root
  ];

  for (const candidate of candidates) {
    if (await exists(resolve(candidate, "bin/initdb"))) {
      return candidate;
    }
  }

  throw new Error("Could not find PostgreSQL payload root in extracted archive.");
}

async function repairInternalSymlinks(root, originalRoot) {
  for await (const linkPath of walkSymlinks(root)) {
    const target = await readlink(linkPath);
    if (!target.startsWith(originalRoot)) {
      continue;
    }

    const targetInInstall = resolve(root, target.slice(originalRoot.length + 1));
    const relativeTarget = relative(dirname(linkPath), targetInInstall);
    await rm(linkPath);
    await symlink(relativeTarget, linkPath);
  }
}

async function* walkSymlinks(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      yield path;
      continue;
    }
    if (info.isDirectory()) {
      yield* walkSymlinks(path);
    }
  }
}

async function download(url, outputPath) {
  const tmpPath = `${outputPath}.tmp`;
  await rm(tmpPath, { force: true });

  await new Promise((resolvePromise, reject) => {
    const child = spawn("curl", ["-L", "--fail", "--show-error", "--output", tmpPath, url], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`curl exited with code ${code}`));
    });
  });

  await rm(outputPath, { force: true });
  await cp(tmpPath, outputPath);
  await rm(tmpPath, { force: true });
}

async function downloadIfMissing(url, outputPath) {
  if (await exists(outputPath)) {
    return;
  }

  await download(url, outputPath);
}

async function getMacSdkPath() {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const result = await run("xcrun", ["--show-sdk-path"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findCommand(command) {
  try {
    const result = await run("which", [command]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function ensureExtensionLoaderAlias(name) {
  const extensionDir = resolve(installRoot, "lib/postgresql");
  const dylibPath = resolve(extensionDir, `${name}.dylib`);
  const aliasPath = resolve(extensionDir, name);
  if (!(await exists(dylibPath))) {
    return;
  }
  await rm(aliasPath, { force: true });
  await symlink(`${name}.dylib`, aliasPath);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const file = await readFile(path);
  hash.update(file);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
    });
  });
}
