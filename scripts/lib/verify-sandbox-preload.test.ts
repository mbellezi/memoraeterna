// The build's last step (`scripts/verify-sandbox-preload.mjs`, run by `npm run build -w
// @app/desktop`) loads the built preload in a bare sandbox and checks its contract. Nothing but the
// journeys' global setup ran that step, so a preload change could leave the build broken for days
// (F5 BUILDCHK). This test bundles the preload the way electron-vite does (the same entry and
// aliases, `electron` and Node's own modules left external, one CJS file) and runs the script
// against it, so `npm run check` fails on the day the preload and the script disagree.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repository, "scripts/verify-sandbox-preload.mjs");

let workspace: string;
let builtPreload: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-sandbox-preload-"));
  const desktop = join(repository, "apps/desktop");
  await build({
    configFile: false,
    logLevel: "silent",
    root: repository,
    resolve: {
      alias: {
        "@app/i18n": resolve(repository, "packages/i18n/src/index.ts"),
        "@app/domain": resolve(repository, "packages/domain/src/index.ts"),
        "@app/integration-contracts": resolve(
          repository,
          "packages/integration-contracts/src/index.ts"
        ),
        "@desktop": join(desktop, "src")
      }
    },
    build: {
      outDir: workspace,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      ssr: join(desktop, "src/preload/index.ts"),
      rollupOptions: {
        external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
        output: { format: "cjs", entryFileNames: "index.cjs" }
      }
    },
    ssr: { noExternal: true }
  });
  builtPreload = join(workspace, "index.cjs");
}, 120_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("verify-sandbox-preload.mjs", () => {
  it("accepts the preload as it is built today", () => {
    const run = spawnSync(process.execPath, [script, builtPreload], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("validates the typed event bus");
  });

  it("fails on a preload that listens only while something is subscribed (the pre-D16 bus)", async () => {
    const lazy = `
      const { contextBridge, ipcRenderer } = require("electron");
      const handler = () => {};
      let subscriptions = 0;
      contextBridge.exposeInMainWorld("app", {
        prompts: { command() {} },
        onAppEvent() {
          if (subscriptions++ === 0) ipcRenderer.on("app:events", handler);
          return () => {
            if (--subscriptions === 0) ipcRenderer.removeListener("app:events", handler);
          };
        }
      });
    `;
    const file = join(workspace, "lazy.cjs");
    await writeFile(file, lazy);
    const run = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ERR_ASSERTION");
  });
});
