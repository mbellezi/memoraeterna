import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const codeFiles = ["**/*.{js,mjs,cjs,ts,tsx}"];
const browserFiles = [
  "apps/desktop/src/renderer/**/*.{ts,tsx}",
  "apps/chrome-extension/src/**/*.{ts,tsx}",
  "apps/obsidian-plugin/src/**/*.{ts,tsx}"
];
const reactFiles = ["**/*.tsx", "apps/desktop/src/renderer/**/*.ts"];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/out/",
    "**/coverage/",
    "**/.vite/",
    ".cache/",
    ".claude/",
    "vendor/",
    "samples/",
    "native/",
    "packages/db/drizzle/",
    "packages/conversion/sidecar/",
    "apps/desktop/build-resources/",
    "apps/desktop/release/"
  ]),
  {
    files: codeFiles,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    // Prettier may place `[` of a member chain on its own line; semicolons are enforced.
    rules: { "no-unexpected-multiline": "off" }
  },
  {
    files: browserFiles,
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: reactFiles,
    extends: [reactHooks.configs.flat.recommended],
    // Warnings cannot be baselined with bulk suppressions, so make it an error.
    rules: { "react-hooks/exhaustive-deps": "error" }
  }
]);
