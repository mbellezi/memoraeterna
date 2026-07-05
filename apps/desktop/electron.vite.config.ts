import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(rootDir, "src");
const dbPackage = resolve(rootDir, "../../packages/db/src/index.ts");
const i18nPackage = resolve(rootDir, "../../packages/i18n/src/index.ts");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@app/db"] })],
    build: {
      rollupOptions: {
        external: [/^drizzle-orm($|\/)/, /^pg($|\/)/, "pg-native"]
      }
    },
    resolve: {
      alias: {
        "@app/db": dbPackage,
        "@app/i18n": i18nPackage,
        "@desktop": srcDir
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
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
        "@desktop": srcDir
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@app/i18n": i18nPackage,
        "@desktop": srcDir
      }
    }
  }
});
