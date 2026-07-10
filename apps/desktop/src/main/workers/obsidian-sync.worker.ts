import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

const payloadSchema = z.object({
  action: z.literal("write"),
  vaultPath: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string()
}).strict();

export async function runObsidianSync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = payloadSchema.parse(payload);
  const vaultPath = resolve(input.vaultPath);
  const targetPath = resolve(vaultPath, input.relativePath);
  if (targetPath !== vaultPath && !targetPath.startsWith(`${vaultPath}${sep}`)) {
    throw new Error("unsafe_obsidian_path");
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, input.content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, targetPath);
  const file = await stat(targetPath);
  return { relativePath: input.relativePath, mtimeMs: Math.trunc(file.mtimeMs) };
}
