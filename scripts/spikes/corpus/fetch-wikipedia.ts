// Spike B calibration corpus: fetches curated Wikipedia articles (pt + en) as
// plain-text extracts, then splits them into pseudo-notes.
//
//   npx tsx scripts/spikes/corpus/fetch-wikipedia.ts              resolve, fetch (resumable), split
//   npx tsx scripts/spikes/corpus/fetch-wikipedia.ts --verify     only resolve titles and list missing ones
//   npx tsx scripts/spikes/corpus/fetch-wikipedia.ts --split-only rebuild notes from the cached raw JSONL
//
// Outputs (gitignored): .cache/corpus/wikipedia/{en,pt}.jsonl (raw extracts with page and
// revision IDs), .cache/corpus/wikipedia/resolution.json, .cache/corpus/notes.jsonl and
// .cache/corpus/manifest.json. Text is CC BY-SA 4.0 (Wikipedia contributors).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { readJsonl, writeJsonl } from "./items.js";
import type { CorpusItem } from "./items.js";
import { defaultSplitOptions, splitArticle } from "./split-notes.js";

const languages = ["en", "pt"] as const;
type Language = (typeof languages)[number];

const userAgent = "MemoraEterna-research/0.1 (local research script)";
const minRequestIntervalMs = 250; // at most 4 requests per second
const requestTimeoutMs = 30_000;
const maxAttempts = 8;
const titlesPerResolveRequest = 50;

const repoRoot = resolve(import.meta.dirname, "../../..");
const titleListPath = join(import.meta.dirname, "wikipedia-titles.json");
const corpusDir = join(repoRoot, ".cache", "corpus");
const rawDir = join(corpusDir, "wikipedia");
const resolutionPath = join(rawDir, "resolution.json");
const notesPath = join(corpusDir, "notes.jsonl");
const manifestPath = join(corpusDir, "manifest.json");

const titleListSchema = z.object({
  description: z.string(),
  license: z.string(),
  domains: z.array(
    z.object({
      id: z.string().min(1),
      en: z.array(z.string().min(1)),
      pt: z.array(z.string().min(1))
    })
  )
});

const resolveResponseSchema = z.object({
  query: z
    .object({
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      pages: z.array(
        z.object({
          pageid: z.number().optional(),
          ns: z.number().optional(),
          title: z.string(),
          missing: z.boolean().optional(),
          invalid: z.boolean().optional(),
          pageprops: z.record(z.string(), z.string()).optional()
        })
      )
    })
    .optional()
});

const extractResponseSchema = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        pageid: z.number(),
        title: z.string(),
        extract: z.string().optional(),
        revisions: z.array(z.object({ revid: z.number(), timestamp: z.string() })).optional()
      })
    )
  })
});

const resolvedTitleSchema = z.object({
  domain: z.string(),
  requested: z.string(),
  title: z.string(),
  pageId: z.number()
});
type ResolvedTitle = z.infer<typeof resolvedTitleSchema>;

const resolutionSchema = z.object({
  resolvedAt: z.string(),
  titleListSha256: z.string(),
  languages: z.record(
    z.string(),
    z.object({
      resolved: z.array(resolvedTitleSchema),
      missing: z.array(z.object({ domain: z.string(), requested: z.string(), reason: z.string() })),
      duplicates: z.array(
        z.object({ domain: z.string(), requested: z.string(), sameAs: z.string() })
      )
    })
  )
});
type Resolution = z.infer<typeof resolutionSchema>;

const rawRowSchema = z.object({
  lang: z.enum(languages),
  domain: z.string(),
  requestedTitle: z.string(),
  title: z.string(),
  pageId: z.number(),
  revisionId: z.number(),
  revisionTimestamp: z.string(),
  url: z.string(),
  fetchedAt: z.string(),
  extract: z.string()
});
type RawRow = z.infer<typeof rawRowSchema>;

// Requests are sequential and spaced by at least minRequestIntervalMs. A 429 widens
// the spacing (up to maxRequestIntervalMs); successes slowly bring it back down.
const maxRequestIntervalMs = 12_000;
let requestIntervalMs = minRequestIntervalMs;
let nextRequestAt = 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

async function apiGet(lang: Language, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [key, value] of Object.entries({
    ...params,
    format: "json",
    formatversion: "2",
    maxlag: "5"
  })) {
    url.searchParams.set(key, value);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + requestIntervalMs;
    let retryAfterMs = 2 ** attempt * 1000;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, "Api-User-Agent": userAgent },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = retryAfter * 1000 + 500;
      if (response.status === 429) {
        requestIntervalMs = Math.min(Math.round(requestIntervalMs * 1.5), maxRequestIntervalMs);
        throw new Error(`HTTP 429 (spacing now ${requestIntervalMs} ms)`);
      }
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      requestIntervalMs = Math.max(minRequestIntervalMs, Math.round(requestIntervalMs * 0.995));
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.toString()}`);
      const body: unknown = await response.json();
      const apiError = z
        .object({ error: z.object({ code: z.string(), info: z.string().optional() }) })
        .safeParse(body);
      if (apiError.success) {
        if (apiError.data.error.code === "maxlag") throw new Error("maxlag");
        throw new Error(`API error ${apiError.data.error.code}: ${apiError.data.error.info ?? ""}`);
      }
      return body;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  retry ${attempt}/${maxAttempts - 1} after ${retryAfterMs} ms: ${message}`);
      await sleep(retryAfterMs);
    }
  }
  throw new Error("unreachable");
}

async function resolveTitles(
  lang: Language,
  requests: { domain: string; requested: string }[]
): Promise<Resolution["languages"][string]> {
  const resolved: ResolvedTitle[] = [];
  const missing: { domain: string; requested: string; reason: string }[] = [];
  const duplicates: { domain: string; requested: string; sameAs: string }[] = [];
  const byPageId = new Map<number, ResolvedTitle>();

  for (let offset = 0; offset < requests.length; offset += titlesPerResolveRequest) {
    const batch = requests.slice(offset, offset + titlesPerResolveRequest);
    const body = resolveResponseSchema.parse(
      await apiGet(lang, {
        action: "query",
        prop: "info|pageprops",
        ppprop: "disambiguation",
        redirects: "1",
        titles: batch.map((entry) => entry.requested).join("|")
      })
    );
    const normalized = new Map(body.query?.normalized?.map((row) => [row.from, row.to]) ?? []);
    const redirects = new Map(body.query?.redirects?.map((row) => [row.from, row.to]) ?? []);
    const pages = new Map(body.query?.pages.map((page) => [page.title, page]) ?? []);
    for (const entry of batch) {
      let title = normalized.get(entry.requested) ?? entry.requested;
      title = redirects.get(title) ?? title;
      const page = pages.get(title);
      if (!page || page.missing || page.invalid || page.pageid === undefined) {
        missing.push({ ...entry, reason: page?.invalid ? "invalid" : "missing" });
      } else if (page.ns !== 0) {
        missing.push({ ...entry, reason: `namespace ${page.ns ?? "?"}` });
      } else if (page.pageprops?.disambiguation !== undefined) {
        missing.push({ ...entry, reason: "disambiguation" });
      } else {
        const existing = byPageId.get(page.pageid);
        if (existing) {
          duplicates.push({ ...entry, sameAs: `${existing.domain}/${existing.requested}` });
        } else {
          const row = { ...entry, title: page.title, pageId: page.pageid };
          byPageId.set(page.pageid, row);
          resolved.push(row);
        }
      }
    }
  }
  return { resolved, missing, duplicates };
}

async function loadRawRows(lang: Language): Promise<RawRow[]> {
  const path = join(rawDir, `${lang}.jsonl`);
  return existsSync(path) ? readJsonl(path, rawRowSchema) : [];
}

async function fetchArticle(lang: Language, entry: ResolvedTitle): Promise<RawRow> {
  const body = extractResponseSchema.parse(
    await apiGet(lang, {
      action: "query",
      prop: "extracts|revisions",
      pageids: String(entry.pageId),
      explaintext: "1",
      exsectionformat: "wiki",
      rvprop: "ids|timestamp"
    })
  );
  const page = body.query.pages[0];
  const revision = page?.revisions?.[0];
  if (!page || page.extract === undefined || !revision) {
    throw new Error(`No extract for ${lang}:${entry.title} (${entry.pageId})`);
  }
  return {
    lang,
    domain: entry.domain,
    requestedTitle: entry.requested,
    title: page.title,
    pageId: page.pageid,
    revisionId: revision.revid,
    revisionTimestamp: revision.timestamp,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
    fetchedAt: new Date().toISOString(),
    extract: page.extract
  };
}

function increment(
  table: Record<string, Record<string, number>>,
  domain: string,
  lang: string,
  by = 1
): void {
  const row = (table[domain] ??= {});
  row[lang] = (row[lang] ?? 0) + by;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => !["--verify", "--split-only"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(" ")}`);
  const verifyOnly = args.has("--verify");
  const splitOnly = args.has("--split-only");

  const titleListText = await readFile(titleListPath, "utf8");
  const titleList = titleListSchema.parse(JSON.parse(titleListText));
  const titleListSha256 = createHash("sha256").update(titleListText).digest("hex");
  await mkdir(rawDir, { recursive: true });

  let resolution: Resolution;
  if (splitOnly) {
    resolution = resolutionSchema.parse(JSON.parse(await readFile(resolutionPath, "utf8")));
    if (resolution.titleListSha256 !== titleListSha256) {
      console.warn("Title list changed since the last resolution; run without --split-only.");
    }
  } else {
    // Reuse a resolution of the same title list (saves requests on resumed runs).
    const previous = existsSync(resolutionPath)
      ? resolutionSchema.safeParse(JSON.parse(await readFile(resolutionPath, "utf8")))
      : null;
    const reuse =
      !verifyOnly && previous?.success && previous.data.titleListSha256 === titleListSha256;
    resolution =
      reuse && previous?.success
        ? previous.data
        : { resolvedAt: new Date().toISOString(), titleListSha256, languages: {} };
    for (const lang of reuse ? [] : languages) {
      const requests = titleList.domains.flatMap((domain) =>
        domain[lang].map((requested) => ({ domain: domain.id, requested }))
      );
      const result = await resolveTitles(lang, requests);
      resolution.languages[lang] = result;
      console.log(
        `${lang}: ${result.resolved.length} resolved, ${result.missing.length} missing, ` +
          `${result.duplicates.length} duplicates`
      );
      for (const row of result.missing) {
        console.log(`  missing ${lang}/${row.domain}: ${row.requested} (${row.reason})`);
      }
      for (const row of result.duplicates) {
        console.log(`  duplicate ${lang}/${row.domain}: ${row.requested} = ${row.sameAs}`);
      }
    }
    await writeFile(resolutionPath, `${JSON.stringify(resolution, null, 2)}\n`, "utf8");
    if (verifyOnly) return;

    for (const lang of languages) {
      const cached = new Set((await loadRawRows(lang)).map((row) => row.pageId));
      const pending = (resolution.languages[lang]?.resolved ?? []).filter(
        (entry) => !cached.has(entry.pageId)
      );
      console.log(`${lang}: fetching ${pending.length} articles (${cached.size} cached)`);
      for (const [index, entry] of pending.entries()) {
        const row = await fetchArticle(lang, entry);
        await appendFile(join(rawDir, `${lang}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
        if ((index + 1) % 50 === 0) console.log(`  ${lang}: ${index + 1}/${pending.length}`);
      }
    }
  }

  // Split into pseudo-notes; domains come from the current resolution.
  const notes: CorpusItem[] = [];
  const articleCounts: Record<string, Record<string, number>> = {};
  const noteCounts: Record<string, Record<string, number>> = {};
  const articles: {
    lang: string;
    domain: string;
    title: string;
    pageId: number;
    revisionId: number;
    notes: number;
  }[] = [];
  const fetchDates: string[] = [];
  for (const lang of languages) {
    const rows = new Map((await loadRawRows(lang)).map((row) => [row.pageId, row]));
    for (const entry of resolution.languages[lang]?.resolved ?? []) {
      const row = rows.get(entry.pageId);
      if (!row) {
        console.warn(`  not fetched yet: ${lang}:${entry.title}`);
        continue;
      }
      fetchDates.push(row.fetchedAt);
      const articleNotes = splitArticle({
        lang,
        domain: entry.domain,
        title: row.title,
        pageId: row.pageId,
        revisionId: row.revisionId,
        extract: row.extract
      });
      notes.push(...articleNotes);
      increment(articleCounts, entry.domain, lang);
      increment(noteCounts, entry.domain, lang, articleNotes.length);
      articles.push({
        lang,
        domain: entry.domain,
        title: row.title,
        pageId: row.pageId,
        revisionId: row.revisionId,
        notes: articleNotes.length
      });
    }
  }
  await writeJsonl(notesPath, notes);

  fetchDates.sort();
  const lengths = notes.map((note) => note.text.length).sort((a, b) => a - b);
  const manifest = {
    name: "Spike B Wikipedia calibration corpus",
    source: "Wikipedia (MediaWiki API, action=query, prop=extracts|revisions, explaintext)",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution:
      "Text from Wikipedia articles by Wikipedia contributors; page and revision IDs are listed below.",
    userAgent,
    titleList: "scripts/spikes/corpus/wikipedia-titles.json",
    titleListSha256,
    fetchedFrom: fetchDates[0] ?? null,
    fetchedUntil: fetchDates.at(-1) ?? null,
    generatedAt: new Date().toISOString(),
    split: defaultSplitOptions,
    totals: {
      articles: articles.length,
      notes: notes.length,
      notesByLang: Object.fromEntries(
        languages.map((lang) => [lang, notes.filter((note) => note.lang === lang).length])
      ),
      textChars: {
        min: lengths[0] ?? 0,
        median: lengths[Math.floor(lengths.length / 2)] ?? 0,
        max: lengths.at(-1) ?? 0
      }
    },
    articlesByDomain: articleCounts,
    notesByDomain: noteCounts,
    missingTitles: Object.fromEntries(
      languages.map((lang) => [lang, resolution.languages[lang]?.missing ?? []])
    ),
    articles
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `notes: ${notes.length} from ${articles.length} articles -> ${notesPath}\nmanifest -> ${manifestPath}`
  );
}

await main();
