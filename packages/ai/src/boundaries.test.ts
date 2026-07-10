import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("local runtime boundaries", () => {
  it("keeps node-llama-cpp and MLX runtime imports out of unprivileged apps", async () => {
    const roots = [
      resolve(process.cwd(), "apps/desktop/src/renderer"),
      resolve(process.cwd(), "apps/chrome-extension/src"),
      resolve(process.cwd(), "apps/obsidian-plugin/src")
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, "utf8");
        if (/from\s+["']node-llama-cpp|import\(["']node-llama-cpp|from\s+["'][^"']*mlx-swift/i.test(source)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(child));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(child);
  }
  return result;
}
