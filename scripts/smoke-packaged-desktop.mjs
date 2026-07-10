import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The packaged desktop smoke currently targets darwin-arm64.");
}

const root = resolve(import.meta.dirname, "..");
const executable = join(
  root,
  "apps",
  "desktop",
  "release",
  "mac-arm64",
  "Memora Eterna.app",
  "Contents",
  "MacOS",
  "Memora Eterna"
);
await access(executable);
const userData = await mkdtemp(join(tmpdir(), "memora-packaged-smoke-"));
try {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const output = await runPackagedApp(executable, userData);
    for (const state of ["starting", "migrating", "ready", "stopping", "stopped"]) {
      if (!output.includes(`Database status: ${state}`)) {
        throw new Error(`Packaged desktop attempt ${attempt} did not reach database state ${state}.\n${output}`);
      }
    }
    await access(join(userData, "database", "postgres-data", "PG_VERSION"));
  }
  console.info("Packaged desktop opened and shut down cleanly twice with the same local database.");
} finally {
  await rm(userData, { recursive: true, force: true });
}

function runPackagedApp(path, userDataPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = {
      ...process.env,
      MEMORA_USER_DATA_DIR: userDataPath,
      MEMORA_SMOKE_AUTO_QUIT_MS: "500",
      ELECTRON_ENABLE_LOGGING: "1"
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(path, ["--disable-gpu"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-64 * 1024); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-64 * 1024); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`Packaged desktop exited with ${code}.\n${output}`));
    });
  });
}
