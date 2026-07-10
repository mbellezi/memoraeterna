import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { MlxAdapter } from "../packages/ai/src/local-adapters.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The MLX helper smoke currently targets darwin-arm64.");
}

const root = resolve(import.meta.dirname, "..");
const releaseRoot = join(root, "native", "mlx-helper", ".build", "release");
const helperPath = join(releaseRoot, "memora-mlx-helper");
await Promise.all([access(helperPath), access(join(releaseRoot, "mlx.metallib"))]);
const modelPath = await resolveModelPath();
const adapter = new MlxAdapter({
  modelId: basename(modelPath),
  modelPath,
  helperPath,
  capabilities: ["text-generation", "offline"],
  timeoutMs: 10 * 60_000
});
const result = await adapter.run({
  taskType: "text-generation",
  input: "Reply with exactly: OK",
  requiredCapabilities: ["text-generation"],
  parameters: { maxTokens: 4, temperature: 0 },
  metadata: { purpose: "mlx-real-model-smoke" }
});
if (typeof result.output !== "string" || result.output.trim() !== "OK") {
  throw new Error(`The MLX helper returned an unexpected smoke result: ${JSON.stringify(result.output)}`);
}

console.info(
  `MLX real-model smoke passed for ${basename(modelPath)} in ${result.durationMs} ms `
  + `(${result.inputTokens ?? "?"} input tokens, ${result.outputTokens ?? "?"} output tokens).`
);

async function resolveModelPath(): Promise<string> {
  const argumentIndex = process.argv.indexOf("--model-path");
  const argument = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  const configured = argument?.trim() || process.env.MEMORA_MLX_MODEL_PATH?.trim();
  if (configured) {
    await assertModelDirectory(configured);
    return resolve(configured);
  }

  const roots = [
    join(homedir(), "Library", "Application Support", "@app", "desktop", "local-models"),
    join(homedir(), "Library", "Application Support", "Memora Eterna", "local-models")
  ];
  for (const modelsRoot of roots) {
    let entries;
    try {
      entries = await readdir(modelsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = join(modelsRoot, entry.name);
      try {
        await assertModelDirectory(candidate);
        return candidate;
      } catch {
        // Continue looking for a fully materialized model.
      }
    }
  }

  throw new Error("No installed MLX model was found. Set MEMORA_MLX_MODEL_PATH or pass --model-path <path>.");
}

async function assertModelDirectory(path: string): Promise<void> {
  const files = await readdir(path);
  if (!files.includes("config.json") || !files.includes("tokenizer.json")
      || !files.some((file) => file.endsWith(".safetensors"))) {
    throw new Error(`The MLX model directory is incomplete: ${path}`);
  }
}
