import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ComparisonDocumentSchema } from "./report-core.js";
import type { ComparisonDocument } from "./report-core.js";
import { esc, renderReportHtml } from "./report-render.js";
import {
  listExports,
  loadProfileInput,
  parseReportArgs,
  readCorpusTruth,
  reportUsage,
  runReport
} from "./report.js";
import type { ReportArgs } from "./report.js";
import { writeFixtureExport } from "./report-fixture.js";

let cache = "";
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "memora-report-cli-"));
  await writeFixtureExport({
    name: "dev",
    cacheDirectory: cache,
    mode: "incremental",
    changeSetOrigins: { build: 1, place: 5, naming: 2 },
    dailyMetrics: 8,
    gateDecisions: 3
  });
  await writeFixtureExport({
    name: "env-c",
    cacheDirectory: cache,
    mode: "fresh",
    changeSetOrigins: { build: 1, naming: 6 }
  });
});
afterAll(async () => {
  await rm(cache, { recursive: true, force: true });
});

const args = (overrides: Partial<ReportArgs> = {}): ReportArgs => ({
  exports: [],
  cache,
  out: null,
  corpus: null,
  options: { seed: 20261014, sample: 6, fresh: true, members: 5 },
  check: false,
  ...overrides
});

describe("the command line", () => {
  it("has defaults and reads every option", () => {
    expect(parseReportArgs([])).toMatchObject({
      kind: "run",
      exports: [],
      out: null,
      corpus: null,
      check: false,
      options: { seed: 20261014, sample: 12, fresh: true, members: 5 }
    });
    const command = parseReportArgs([
      "--export",
      "env-c",
      "--export",
      "dev",
      "--cache",
      "/tmp/cache",
      "--out",
      "/tmp/out/report.html",
      "--corpus",
      "/tmp/corpus",
      "--seed",
      "7",
      "--sample",
      "20",
      "--members",
      "3",
      "--no-fresh",
      "--check"
    ]);
    expect(command).toMatchObject({
      kind: "run",
      exports: ["env-c", "dev"],
      cache: "/tmp/cache",
      out: "/tmp/out/report.html",
      corpus: "/tmp/corpus",
      check: true,
      options: { seed: 7, sample: 20, fresh: false, members: 3 }
    });
    expect(parseReportArgs(["--help"])).toEqual({ kind: "help" });
    expect(reportUsage).toContain("npm run topics:report");
  });

  it("refuses bad names, repeats and numbers", () => {
    expect(() => parseReportArgs(["--export", "Bad Name"])).toThrow(/lower case/u);
    expect(() => parseReportArgs(["--export", "dev", "--export", "dev"])).toThrow(/twice/u);
    expect(() => parseReportArgs(["--sample", "many"])).toThrow(/whole number/u);
    expect(() => parseReportArgs(["--members", "0"])).toThrow(/at least 1/u);
    expect(() => parseReportArgs(["--bogus"])).toThrow();
  });
});

describe("reading exports", () => {
  it("lists the exports of a cache and loads one with its vectors", async () => {
    expect(await listExports(cache)).toEqual(["dev", "env-c"]);
    expect(await listExports(join(cache, "nowhere"))).toEqual([]);
    const input = await loadProfileInput(cache, "dev", null);
    expect(input.document.name).toBe("dev");
    expect(input.store?.rows).toHaveLength(720);
    // The DEV export carries the recorded legacy wiki; the others do not.
    expect(input.legacy?.pages).toBe(9);
    expect((await loadProfileInput(cache, "env-c", null)).legacy).toBeNull();
  });

  it("says plainly what is missing or inconsistent", async () => {
    await expect(loadProfileInput(cache, "env-z", null)).rejects.toThrow(
      /Cannot read the export env-z/u
    );
    // An export whose replay store is gone.
    const broken = await mkdtemp(join(tmpdir(), "memora-report-broken-"));
    try {
      await writeFixtureExport({ name: "gone", cacheDirectory: broken, mode: "fresh" });
      await rm(join(broken, "topics", "vectors", "gone.meta.json"));
      await expect(loadProfileInput(broken, "gone", null)).rejects.toThrow(
        /gone\.meta\.json is not in/u
      );
      // A store with another row count than its export.
      await writeFixtureExport({ name: "stale", cacheDirectory: broken, mode: "fresh" });
      const metaPath = join(broken, "topics", "vectors", "stale.meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { count: number };
      await writeFile(metaPath, JSON.stringify({ ...meta, count: meta.count - 1 }));
      await expect(loadProfileInput(broken, "stale", null)).rejects.toThrow(
        /index rows|export it again/u
      );
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("reads the domains of a corpus manifest", async () => {
    const folder = join(cache, "corpus");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        name: "Mini",
        articles: [
          {
            lang: "pt",
            title: "Fotossíntese",
            domain: "biology",
            pageId: 1,
            revisionId: 1,
            notes: 1
          },
          {
            lang: "en",
            title: "Photosynthesis",
            domain: "biology",
            pageId: 2,
            revisionId: 2,
            notes: 1
          }
        ]
      })
    );
    const truth = await readCorpusTruth(folder);
    expect(truth.name).toBe("Mini");
    expect(truth.domainOf("pt", "Fotossíntese")).toBe("biology");
    expect(truth.domainOf("en", "Fotossíntese")).toBeUndefined();
  });
});

describe("the report", () => {
  let document: ComparisonDocument;
  let html = "";
  let result: Awaited<ReturnType<typeof runReport>>;
  beforeAll(async () => {
    result = await runReport(args(), () => undefined);
    document = result.document;
    html = await readFile(result.htmlPath, "utf8");
  });

  it("writes the HTML and the data beside each other, in the cache's reports folder", async () => {
    expect(result.htmlPath).toBe(join(cache, "topics", "reports", "topics-report.html"));
    expect(result.jsonPath).toBe(join(cache, "topics", "reports", "topics-report.json"));
    expect((await readdir(join(cache, "topics", "reports"))).sort()).toEqual([
      "topics-report.html",
      "topics-report.json"
    ]);
    const data = JSON.parse(await readFile(result.jsonPath, "utf8")) as unknown;
    expect(ComparisonDocumentSchema.parse(data)).toEqual(document);
    expect(document.profiles.map((profile) => profile.name)).toEqual(["dev", "env-c"]);
  });

  it("compares each profile with a fresh build: the incremental one differs, the cold start does not", () => {
    const [dev, envC] = document.profiles;
    expect(dev!.fresh!.identical).toBe(false);
    expect(envC!.fresh!.identical).toBe(true);
    // The cold start meets the gating bars; any failure belongs to the grown tree.
    expect(result.failures.every((failure) => failure.startsWith("dev: "))).toBe(true);
    expect(envC!.targets.filter((check) => check.gating && check.status === "fail")).toEqual([]);
  });

  it("is one self-contained, script-free page with every section", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|<img|https?:\/\//u);
    for (const heading of [
      "Exit criteria by profile",
      "Against the exit targets",
      "Incremental tree against a fresh build",
      "Churn and change-sets per day",
      "Placements and the gate",
      "Sampled topics",
      "The legacy wiki this tree replaced"
    ])
      expect(html).toContain(heading);
    // Two profiles, a summary matrix with a column each, and a link to each section.
    expect(html).toContain('id="profile-dev"');
    expect(html).toContain('id="profile-env-c"');
    expect(html).toContain('href="#profile-env-c"');
    expect(html.match(/<caption>/gu)!.length).toBeGreaterThan(20);
    expect(html).toContain("same partition");
    expect(html).toContain('<span class="badge pass">pass</span>');
    // Verdicts are words, not only colors; the legacy record is DEV's alone.
    expect(html.match(/The legacy wiki this tree replaced/gu)).toHaveLength(1);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('lang="en"');
  });

  it("is a function of the data: the same report renders the same page", () => {
    expect(renderReportHtml(document)).toBe(html);
  });

  it("fails a gating check only when asked to, through the failures it returns", async () => {
    const narrow = await mkdtemp(join(tmpdir(), "memora-report-narrow-"));
    try {
      const { topicTreeConfigWith } = await import("@app/domain/topic-tree");
      await writeFixtureExport({
        name: "env-narrow",
        cacheDirectory: narrow,
        mode: "fresh",
        config: topicTreeConfigWith({
          fanOut: { min: 2, max: 12, targetMin: 11, targetMax: 12, hardMax: 16, rootTarget: 8 }
        })
      });
      const failing = await runReport(
        args({ cache: narrow, out: join(narrow, "r.html") }),
        () => undefined
      );
      expect(failing.failures.join("\n")).toMatch(/env-narrow: E2/u);
      expect(await readFile(join(narrow, "r.html"), "utf8")).toContain(
        '<span class="badge fail">FAIL</span>'
      );
      expect(await readFile(join(narrow, "r.json"), "utf8")).toContain('"status": "fail"');
    } finally {
      await rm(narrow, { recursive: true, force: true });
    }
  });

  it("refuses an empty cache", async () => {
    await expect(runReport(args({ cache: join(cache, "empty") }), () => undefined)).rejects.toThrow(
      /No export in/u
    );
  });
});

describe("escaping", () => {
  it("escapes what a library can put in a name or a title", () => {
    expect(esc(`<img src=x onerror="alert('x')"> & more`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; more"
    );
    expect(esc(null)).toBe("");
    expect(esc(3)).toBe("3");
  });

  it("never lets a topic name or a member title into the page as markup", async () => {
    const result = await runReport(
      args({ options: { seed: 1, sample: 6, fresh: false, members: 5 } }),
      () => undefined
    );
    const hostile: ComparisonDocument = JSON.parse(
      JSON.stringify(result.document)
    ) as ComparisonDocument;
    const sample = hostile.profiles[0]!.samples[0]!;
    sample.title = "<script>alert(1)</script>";
    sample.members[0]!.title = '"><img src=x onerror=alert(1)>';
    sample.members[0]!.source = "<b>source</b>";
    hostile.profiles[0]!.label = "<i>label</i>";
    const page = renderReportHtml(hostile);
    expect(page).not.toMatch(/<script|<img|<b>|<i>/u);
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
