/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads this file as CommonJS */
"use strict";
// A bare offscreen Electron for the contrast scan's fixture tests (`contrast.page.test.ts`): a temporary
// userData, no network, no Memora process, no database and no model. It loads one HTML fixture, then
// runs each expression of the plan in the page in order (`{ html, steps: [{ source, waitMs }] }`),
// and writes the results as JSON to the plan's `out` file: `electron contrast-fixture.cjs <plan.json>`.
const { app, BrowserWindow, session } = require("electron");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const plan = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "memora-contrast-"));
app.setPath("userData", join(temporary, "profile"));
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  await app.whenReady();
  app.dock?.hide();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|blob|devtools):/u.test(details.url) });
  });
  const window = new BrowserWindow({
    show: false,
    width: plan.width ?? 900,
    height: plan.height ?? 700,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(plan.html)}`);
  const results = [];
  for (const step of plan.steps) {
    if (step.waitMs) await sleep(step.waitMs);
    results.push(await window.webContents.executeJavaScript(step.source));
  }
  writeFileSync(plan.out, JSON.stringify({ results }));
  window.destroy();
}

run()
  .catch((error) => {
    writeFileSync(plan.out, JSON.stringify({ error: String((error && error.message) || error) }));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  });
