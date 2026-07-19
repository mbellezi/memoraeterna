import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "copy-project-license",
      async closeBundle() {
        await copyFile(
          resolve(import.meta.dirname, "../../LICENSE"),
          resolve(import.meta.dirname, "dist/LICENSE")
        );
      }
    }
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "popup.html"),
        background: resolve(import.meta.dirname, "src/background.ts"),
        content: resolve(import.meta.dirname, "src/content.ts")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
