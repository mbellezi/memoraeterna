import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(rootDir, "src");
const i18nPackage = resolve(rootDir, "../../packages/i18n/src/index.ts");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@app/i18n": i18nPackage,
      "@desktop": srcDir
    }
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node"
  }
});
