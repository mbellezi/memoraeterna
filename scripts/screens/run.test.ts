import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SurfaceEntry } from "../../apps/desktop/src/renderer/workspace/surfaces";
import { entrySource, pageHtml } from "./build-bundle";
import { standStyle } from "./frame";
import { evidenceReasons, type Evidence } from "./evidence";
import {
  captureJobs,
  idleWatchdog,
  parseScreensArgs,
  readCaptureLines,
  selectSurfaces,
  sharedLockFile,
  summarize,
  takeLock
} from "./run";

const entries: SurfaceEntry[] = [
  { id: "inbox", kind: "hosted", implementation: "a/Inbox.tsx", screen: "a/inbox.screen.tsx" },
  {
    id: "note",
    kind: "panel",
    implementation: "p/note.panel.tsx",
    screen: "p/note.screen.tsx",
    ribbon: true
  },
  { id: "planned", kind: "panel", implementation: "p/x.panel.tsx", screen: "p/x.screen.tsx" }
];

describe("the screens command line", () => {
  it("reads repeated and comma-separated surfaces, --check and the filters", () => {
    expect(
      parseScreensArgs([
        "--screen",
        "shell,rail",
        "--screen",
        "inbox",
        "--check",
        "--mode",
        "error"
      ])
    ).toMatchObject({
      screens: ["shell", "rail", "inbox"],
      check: true,
      modes: ["error"],
      shots: true
    });
    expect(parseScreensArgs(["--no-shots", "--width", "1200"])).toMatchObject({
      shots: false,
      widths: [1200]
    });
  });

  it("reads --locale (English by default) and refuses a language the app does not ship", () => {
    expect(parseScreensArgs([]).locale).toBe("en");
    expect(parseScreensArgs(["--locale", "pt-BR"]).locale).toBe("pt-BR");
    for (const locale of ["en", "pt-BR", "es", "fr", "it"])
      expect(parseScreensArgs(["--locale", locale]).locale).toBe(locale);
    expect(() => parseScreensArgs(["--locale", "pt"])).toThrow("Unknown locale pt");
    expect(() => parseScreensArgs(["--locale"])).toThrow("needs a value");
  });

  it("reads --focus as a selector to focus before the shot, none by default", () => {
    expect(parseScreensArgs([]).focus).toBeNull();
    expect(parseScreensArgs(["--focus", "[data-omni]"]).focus).toBe("[data-omni]");
    expect(() => parseScreensArgs(["--focus"])).toThrow("needs a value");
  });

  it("refuses an unknown flag, a missing value, a bad mode and a width below the window minimum", () => {
    expect(() => parseScreensArgs(["--nope"])).toThrow("Unknown argument");
    expect(() => parseScreensArgs(["--screen"])).toThrow("needs a value");
    expect(() => parseScreensArgs(["--mode", "ready"])).toThrow("Unknown mode");
    expect(() => parseScreensArgs(["--width", "800"])).toThrow("at least 960");
  });
});

describe("which surfaces a run covers", () => {
  const exists = (path: string) => !path.startsWith("p/x");

  it("covers every surface that has an implementation and a screen module by default", () => {
    expect(selectSurfaces([], exists, entries).map((entry) => entry.id)).toEqual(["inbox", "note"]);
  });

  it("names a planned or an unknown surface instead of skipping it when it is requested", () => {
    expect(() => selectSurfaces(["planned"], exists, entries)).toThrow("is planned");
    expect(() => selectSurfaces(["nope"], exists, entries)).toThrow("Unknown surface");
    expect(() =>
      selectSurfaces(["inbox"], (path) => !path.endsWith(".screen.tsx"), entries)
    ).toThrow("no screen module");
  });
});

describe("the capture plan", () => {
  it("is surface x 4 modes x 2 themes x 2 widths, with the width as the outer loop", () => {
    const jobs = captureJobs(entries.slice(0, 2), { modes: [], themes: [], widths: [] });
    expect(jobs).toHaveLength(2 * 4 * 2 * 2);
    expect(jobs.slice(0, 16).every((job) => job.width === 960)).toBe(true);
    expect(new Set(jobs.map((job) => job.mode))).toEqual(
      new Set(["loading", "empty", "error", "success"])
    );
  });

  it("narrows to the requested mode, theme and width", () => {
    expect(
      captureJobs(entries.slice(0, 1), { modes: ["error"], themes: ["dark"], widths: [1440] })
    ).toEqual([{ surface: "inbox", mode: "error", theme: "dark", width: 1440 }]);
  });
});

describe("the check summary", () => {
  const result = (ok: boolean, reasons: string[] = []) => ({
    surface: "inbox",
    mode: "error" as const,
    theme: "light" as const,
    width: 960,
    locale: "en",
    frame: "harness" as const,
    state: "error",
    signature: "1:a",
    ok,
    reasons,
    fits: [],
    missing: [],
    pageErrors: []
  });

  it("passes only when something was checked and nothing failed", () => {
    expect(summarize([result(true)]).passed).toBe(true);
    expect(summarize([]).passed).toBe(false);
  });

  it("fails a capture whose page was not in the requested language", () => {
    const portuguese = { ...result(true), locale: "pt-BR" };
    expect(summarize([portuguese], 1, 0, "pt-BR").passed).toBe(true);
    const wrong = summarize([result(true)], 1, 0, "pt-BR");
    expect(wrong.passed).toBe(false);
    expect(wrong.failures).toEqual(["inbox error light 960: rendered in en, expected pt-BR"]);
    expect(summarize([result(true)]).passed).toBe(true);
  });

  it("fails an empty state that shows what the success state shows", () => {
    const shown = (mode: "empty" | "success", signature: string) => ({
      ...result(true),
      mode,
      signature
    });
    expect(summarize([shown("empty", "5:x"), shown("success", "9:y")]).passed).toBe(true);
    const same = summarize([shown("empty", "9:y"), shown("success", "9:y")]);
    expect(same.passed).toBe(false);
    expect(same.failures).toEqual(["inbox light 960: empty shows what success shows"]);
  });

  it("fails a capture that ended before its last job, even when every result it has is right", () => {
    const summary = summarize([result(true)], 4);
    expect(summary).toMatchObject({ passed: false, total: 4 });
    expect(summary.failures).toEqual(["the capture ended after 1 of 4 captures"]);
    expect(summarize([result(true)], 1, 137).failures).toEqual([
      "the capture process exited with 137"
    ]);
  });

  it("names each failure with its surface, mode, theme, width and reasons", () => {
    const summary = summarize([result(true), result(false, ["error shows no alert"])]);
    expect(summary).toMatchObject({ passed: false, total: 2, failed: 1 });
    expect(summary.failures).toEqual(["inbox error light 960: error shows no alert"]);
  });
});

describe("what each state must show in the DOM", () => {
  const none: Evidence = { alerts: 0, busy: 0, statuses: 0, text: 12 };

  it("loading needs a busy or status region and no alert", () => {
    expect(evidenceReasons("loading", { ...none, busy: 1 })).toEqual([]);
    expect(evidenceReasons("loading", { ...none, statuses: 1 })).toEqual([]);
    expect(evidenceReasons("loading", none)).toEqual(["loading shows no busy or status region"]);
    expect(evidenceReasons("loading", { ...none, busy: 1, alerts: 1 })).toEqual([
      "loading shows an alert"
    ]);
  });

  it("error needs an alert", () => {
    expect(evidenceReasons("error", { ...none, alerts: 1 })).toEqual([]);
    expect(evidenceReasons("error", none)).toEqual(["error shows no alert"]);
  });

  it("empty and success need text, no alert and nothing busy", () => {
    for (const mode of ["empty", "success"] as const) {
      expect(evidenceReasons(mode, none)).toEqual([]);
      expect(evidenceReasons(mode, { ...none, alerts: 1, busy: 1, text: 0 })).toEqual([
        `${mode} shows an alert`,
        `${mode} is still busy`,
        `${mode} shows no text`
      ]);
    }
  });
});

describe("the capture lock", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const lockFile = () => {
    const directory = mkdtempSync(join(tmpdir(), "screens-lock-"));
    directories.push(directory);
    return join(directory, ".lock");
  };

  it("refuses a second capture while the first owner lives and frees the file on release", () => {
    const file = lockFile();
    const release = takeLock(file, () => true);
    expect(() => takeLock(file, () => true)).toThrow("Another screens capture is running");
    release();
    expect(() => takeLock(file, () => true)()).not.toThrow();
  });

  it("replaces the lock of a dead owner", () => {
    const file = lockFile();
    writeFileSync(file, "999999");
    expect(() => takeLock(file, () => false)()).not.toThrow();
  });
});

describe("the lock every worktree shares", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("is the same file from the main checkout and from a linked worktree", () => {
    const base = mkdtempSync(join(tmpdir(), "screens-worktrees-"));
    directories.push(base);
    const main = join(base, "main");
    const linked = join(base, "linked");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "x");
    git(main, "worktree", "add", "-q", linked, "-b", "other");
    expect(sharedLockFile(linked)).toBe(sharedLockFile(main));
    expect(sharedLockFile(main)).toMatch(/\.git\/memora-screens\.lock$/u);
  });

  it("falls back to the checkout's own cache outside git", () => {
    const base = mkdtempSync(join(tmpdir(), "screens-nogit-"));
    directories.push(base);
    expect(
      sharedLockFile(base, () => {
        throw new Error("not a git repository");
      })
    ).toBe(join(base, ".cache/f5/screens/.lock"));
  });
});

describe("the capture's progress", () => {
  const line = (surface: string) =>
    JSON.stringify({ result: { surface, mode: "error", theme: "light", width: 960, ok: true } });

  it("keeps every result a stopped capture wrote and ignores a cut last line", () => {
    const text = `${line("a")}\n${JSON.stringify({ blocked: "https://x.test/" })}\n${line("b")}\n{"result": {"surf`;
    const read = readCaptureLines(text);
    expect(read.results.map((result) => result.surface)).toEqual(["a", "b"]);
    expect(read.blocked).toEqual(["https://x.test/"]);
  });

  it("stops a capture only after it makes no progress, however long the whole run takes", () => {
    vi.useFakeTimers();
    try {
      const idle = vi.fn();
      const watchdog = idleWatchdog(1000, idle);
      for (let step = 0; step < 50; step += 1) {
        vi.advanceTimersByTime(900);
        watchdog.touch();
      }
      expect(idle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(idle).toHaveBeenCalledTimes(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the fixture bundle's entry", () => {
  it("imports the harness, the styles and each screen module, and registers them by id", () => {
    const source = entrySource(entries.slice(0, 2), "/r");
    expect(source).toContain('import "/r/styles.css";');
    expect(source).toContain('import * as screen0 from "/r/a/inbox.screen.tsx";');
    expect(source).toContain('import * as screen1 from "/r/p/note.screen.tsx";');
    expect(source).toContain(
      'registerScreens({ "inbox": screen0, "note": screen1 }, ["note"], {"inbox":"hosted","note":"panel"});'
    );
  });

  it("never lets a closing tag end the page's script or style early", () => {
    const html = pageHtml('const s = "</script>";', "a::after{content:'</style>'}");
    // The page's own two scripts (the language, the bundle) close; the one inside the code does not.
    expect(html.match(/<\/script>/gu)).toHaveLength(2);
    expect(html.match(/<\/style>/gu)).toHaveLength(1);
  });

  it("sets the page's language before the bundle runs, so a screen module builds its translator in it", () => {
    const html = pageHtml("run();", "a{}", "pt-BR");
    expect(html).toContain('<html lang="pt-BR"');
    expect(html.indexOf('window.__screenLocale="pt-BR"')).toBeGreaterThan(0);
    expect(html.indexOf("window.__screenLocale")).toBeLessThan(html.indexOf("run();"));
    expect(pageHtml("run();", "a{}")).toContain('<html lang="en"');
  });
});

describe("the stand around a surface", () => {
  it("shows a surface that fills the window edge to edge, and pads every other one", () => {
    expect(standStyle(true)).toEqual({ padding: "0", overflow: "hidden" });
    expect(standStyle(false)).toEqual({ padding: "1rem", overflow: "auto" });
  });
});
