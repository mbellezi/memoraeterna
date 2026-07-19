import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "copy-plugin-licenses",
      async closeBundle() {
        await Promise.all(
          ["LICENSE-APACHE", "LICENSE-MIT"].map((fileName) =>
            copyFile(
              resolve(import.meta.dirname, fileName),
              resolve(import.meta.dirname, "dist", fileName)
            )
          )
        );
      }
    }
  ],
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
