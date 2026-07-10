import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(rootDir, "src");
const dbPackage = resolve(rootDir, "../../packages/db/src/index.ts");
const i18nPackage = resolve(rootDir, "../../packages/i18n/src/index.ts");
const aiPackage = resolve(rootDir, "../../packages/ai/src/index.ts");
const conversionPackage = resolve(rootDir, "../../packages/conversion/src/index.ts");
const domainPackage = resolve(rootDir, "../../packages/domain/src/index.ts");

export default defineConfig({
  main: {
    json: { stringify: false },
    plugins: [externalizeDepsPlugin({
      exclude: ["@app/ai", "@app/conversion", "@app/db", "@app/domain"]
    })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(rootDir, "src/main/index.ts"),
          "workers/worker-host": resolve(rootDir, "src/main/workers/worker-host.ts")
        },
        external: [
          /^defuddle($|\/)/,
          /^drizzle-orm($|\/)/,
          /^fflate($|\/)/,
          /^linkedom($|\/)/,
          /^pg($|\/)/,
          "pg-native"
        ],
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js"
        }
      }
    },
    resolve: {
      alias: {
        "@app/db": dbPackage,
        "@app/ai": aiPackage,
        "@app/conversion": conversionPackage,
        "@app/domain": domainPackage,
        "@desktop": srcDir
      }
    }
  },
  preload: {
    json: { stringify: false },
    plugins: [externalizeDepsPlugin({ exclude: ["@app/domain", "zod"] })],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs"
        }
      }
    },
    resolve: {
      alias: {
        "@app/i18n": i18nPackage,
        "@app/domain": domainPackage,
        "@desktop": srcDir
      }
    }
  },
  renderer: {
    json: { stringify: false },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@app/i18n": i18nPackage,
        "@app/domain": domainPackage,
        "@desktop": srcDir
      }
    }
  }
});
