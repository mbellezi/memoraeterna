/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads this file as CommonJS */
"use strict";
// The capture process of the screens tool: a bare offscreen Electron. It has a temporary userData,
// no network, no Memora main process, no database and no model. It loads the fixture bundle, mounts
// each job (surface, mode, theme, width) through `window.__screens.mount`, writes the screenshots and
// a results file with one JSON line per finished job (`{"result": …}`) and per blocked request
// (`{"blocked": url}`), appended as they happen so a capture that is stopped still leaves what it
// did; it prints one line per finished job, which `run.ts` reads as progress. `run.ts` starts it:
// `electron capture.cjs <plan.json>`.
const { app, BrowserWindow, session } = require("electron");
const {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const plan = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "memora-screens-"));
app.setPath("userData", join(temporary, "profile"));
app.disableHardwareAcceleration();

const jobTimeoutMs = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run() {
  writeFileSync(plan.resultsFile, "");
  await app.whenReady();
  app.dock?.hide();
  // Nothing leaves the machine: only the bundle's own file and inline data load.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const local = /^(file|data|blob|devtools):/u.test(details.url);
    if (!local)
      appendFileSync(
        plan.resultsFile,
        `${JSON.stringify({ blocked: details.url.split("?")[0] })}\n`
      );
    callback({ cancel: !local });
  });
  const window = new BrowserWindow({
    show: false,
    width: plan.jobs[0]?.width ?? 1440,
    height: plan.height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadFile(plan.bundle);
  if (plan.focus) {
    // A window that is not shown has no focus of its own: let the page believe it has it, so a
    // focused element matches :focus and :focus-visible.
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true
    });
  }
  console.log("screens-capture ready");
  let done = 0;
  let width = null;
  for (const job of plan.jobs) {
    let result;
    try {
      if (job.width !== width) {
        window.setContentSize(job.width, plan.height);
        width = job.width;
        await sleep(150);
      }
      result = await withTimeout(
        window.webContents.executeJavaScript(
          `window.__screens.mount(${JSON.stringify(job.surface)}, ${JSON.stringify(job.mode)}, ${JSON.stringify(job.theme)})`
        ),
        jobTimeoutMs,
        `${job.surface} ${job.mode}`
      );
      if (plan.focus) {
        // As the keyboard would: the window has focus and the last input was a key, so a ring shows.
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
        const found = await window.webContents.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(plan.focus)}); if (!el) return false; el.focus({ focusVisible: true }); return document.activeElement === el; })()`
        );
        if (!found) {
          result.ok = false;
          result.reasons = [...result.reasons, `--focus matched nothing: ${plan.focus}`];
        }
      }
      if (plan.shots) {
        await window.webContents.executeJavaScript(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
        );
        window.webContents.invalidate();
        await sleep(150);
        const image = await window.webContents.capturePage();
        const directory = join(plan.outDirectory, job.surface);
        mkdirSync(directory, { recursive: true });
        const file = `${job.mode}-${job.theme}-${job.width}${plan.focus ? "-focus" : ""}.png`;
        writeFileSync(join(directory, file), image.toPNG());
        result.screenshot = `${job.surface}/${file}`;
        result.size = image.getSize();
      }
    } catch (error) {
      result = {
        surface: job.surface,
        mode: job.mode,
        theme: job.theme,
        locale: plan.locale,
        frame: "none",
        state: null,
        ok: false,
        reasons: [String(error && error.message ? error.message : error)],
        fits: [],
        missing: [],
        pageErrors: []
      };
    }
    appendFileSync(
      plan.resultsFile,
      `${JSON.stringify({ result: { ...result, width: job.width } })}\n`
    );
    done += 1;
    console.log(`screens-capture ${done}/${plan.jobs.length}`);
  }
  window.destroy();
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  });
