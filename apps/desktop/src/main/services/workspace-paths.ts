import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMORA_WORKSPACE_ROOT) {
    return resolve(env.MEMORA_WORKSPACE_ROOT);
  }

  let current = resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "packages/db/drizzle")) || existsSync(join(current, "vendor/sidecars"))) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return resolve(cwd);
}
