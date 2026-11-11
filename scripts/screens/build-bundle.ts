/**
 * Builds the fixture bundle of the screens tool: one page that holds the harness, the renderer's
 * styles (the renderer's own Tailwind and font setup, fonts inlined, nothing fetched at run time)
 * and the screen modules of the requested surfaces. Vite builds it into one HTML file that
 * `capture.cjs` loads over `file://`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

import type { LanguageCode } from "../../packages/i18n/src/index";
import type { SurfaceEntry } from "../../apps/desktop/src/renderer/workspace/surfaces";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "../..");
export const rendererRoot = join(repositoryRoot, "apps/desktop/src/renderer");

const entryId = "\0screens-entry";

/** The generated entry: the harness, the styles and every screen module, registered by surface id. */
export function entrySource(surfaces: readonly SurfaceEntry[], root = rendererRoot): string {
  const lines = [
    `import { registerScreens } from ${JSON.stringify(join(here, "harness.tsx"))};`,
    `import ${JSON.stringify(join(root, "styles.css"))};`
  ];
  surfaces.forEach((surface, index) => {
    lines.push(`import * as screen${index} from ${JSON.stringify(join(root, surface.screen))};`);
  });
  const modules = surfaces
    .map((surface, index) => `${JSON.stringify(surface.id)}: screen${index}`)
    .join(", ");
  const ribbons = surfaces.filter((surface) => surface.ribbon).map((surface) => surface.id);
  const kinds = Object.fromEntries(surfaces.map((surface) => [surface.id, surface.kind]));
  lines.push(
    `registerScreens({ ${modules} }, ${JSON.stringify(ribbons)}, ${JSON.stringify(kinds)});`
  );
  return `${lines.join("\n")}\n`;
}

/** The page that carries the bundle (a script body never contains a closing script tag). */
export function pageHtml(code: string, css: string, locale: LanguageCode = "en"): string {
  const safe = (text: string, closing: string) =>
    text.replaceAll(closing, closing.replace("</", "<\\/"));
  // The language is set before the bundle runs: a screen module reads it when it builds its translator.
  return (
    `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${safe(css, "</style")}</style></head><body>` +
    `<script>window.__screenLocale=${JSON.stringify(locale)}</script>` +
    `<script>${safe(code, "</script")}</script></body></html>`
  );
}

export interface BundleResult {
  /** The HTML file, ready for `loadFile`. */
  file: string;
  bytes: number;
}

export async function buildBundle(
  surfaces: readonly SurfaceEntry[],
  outDirectory: string,
  root = rendererRoot,
  locale: LanguageCode = "en"
): Promise<BundleResult> {
  const entry = entrySource(surfaces, root);
  const result = await build({
    configFile: false,
    logLevel: "warn",
    root: repositoryRoot,
    esbuild: { jsx: "automatic" },
    define: { "process.env.NODE_ENV": '"production"' },
    resolve: {
      alias: {
        "@app/i18n": join(repositoryRoot, "packages/i18n/src/index.ts"),
        "@app/domain": join(repositoryRoot, "packages/domain/src/index.ts"),
        "@app/integration-contracts": join(
          repositoryRoot,
          "packages/integration-contracts/src/index.ts"
        ),
        "@desktop": join(repositoryRoot, "apps/desktop/src")
      }
    },
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      // Fonts and images become data URIs: the page needs nothing from the network.
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: { entry: "screens-entry", name: "MemoraScreens", formats: ["iife"] },
      rollupOptions: {
        onwarn(warning, warn) {
          // Icon packages carry a "use client" directive that a plain bundle ignores.
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        }
      }
    },
    plugins: [
      tailwindcss(),
      {
        name: "screens-entry",
        resolveId(id) {
          if (id === "screens-entry" || id.endsWith("/screens-entry")) return entryId;
          return undefined;
        },
        load(id) {
          return id === entryId ? entry : undefined;
        }
      }
    ]
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("The screens bundle produced no output");
  const code = output.output.find((item) => item.type === "chunk")?.code;
  if (!code) throw new Error("The screens bundle has no script");
  const css = output.output
    .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String((item as { source: string | Uint8Array }).source))
    .join("\n");
  mkdirSync(outDirectory, { recursive: true });
  const file = join(outDirectory, "screens.html");
  const html = pageHtml(code, css, locale);
  writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html) };
}
