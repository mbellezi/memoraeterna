import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The MLX helper build currently targets darwin-arm64.");
}

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "native", "mlx-helper");
const buildRoot = join(packageRoot, ".build");
const releaseRoot = join(buildRoot, "release");

await run("swift", ["build", "-c", "release", "--package-path", packageRoot]);

const mlxCheckout = join(buildRoot, "checkouts", "mlx-swift");
const xcodeProject = join(mlxCheckout, "xcode", "MLX.xcodeproj");
await access(xcodeProject);
const derivedData = join(buildRoot, "xcode-derived-data");
await run("xcodebuild", [
  "-project", xcodeProject,
  "-scheme", "Cmlx",
  "-configuration", "Release",
  "-destination", "platform=macOS,arch=arm64",
  "-derivedDataPath", derivedData,
  "-skipPackageUpdates",
  "-quiet",
  "GCC_WARN_64_TO_32_BIT_CONVERSION=NO",
  "CODE_SIGNING_ALLOWED=NO",
  "COMPILER_INDEX_STORE_ENABLE=NO",
  "build"
]);

const sourceMetallib = join(
  derivedData,
  "Build",
  "Products",
  "Release",
  "Cmlx.framework",
  "Versions",
  "A",
  "Resources",
  "default.metallib"
);
const destinationMetallib = join(releaseRoot, "mlx.metallib");
await mkdir(dirname(destinationMetallib), { recursive: true });
await copyFile(sourceMetallib, destinationMetallib);
if ((await stat(destinationMetallib)).size === 0) {
  throw new Error("The generated MLX Metal library is empty.");
}

console.info(`Built MLX helper and Metal shaders in ${releaseRoot}.`);

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} failed with ${code ?? signal ?? "unknown status"}.`));
      }
    });
  });
}
