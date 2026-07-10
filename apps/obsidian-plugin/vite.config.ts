import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js"
    },
    rollupOptions: {
      external: ["obsidian"],
      output: { exports: "default" }
    },
    minify: false,
    sourcemap: true
  }
});
