import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { MetadataEnrichmentService } from "./metadata-enrichment-service.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MetadataEnrichmentService", () => {
  it("loads Open Library ISBN details and caches the normalized query", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/isbn/9780306406157.json")) return json({
        key: "/books/OL1M", title: "Precise Book", authors: [{ key: "/authors/OL1A" }],
        works: [{ key: "/works/OL1W" }], publishers: ["Local Press"], publish_date: "1980",
        isbn_13: ["9780306406157"], number_of_pages: 320, covers: [42]
      });
      if (url.includes("/authors/OL1A.json")) return json({ name: "Ada Author" });
      if (url.includes("/works/OL1W.json")) return json({ subjects: ["Knowledge"] });
      throw new Error(`unexpected:${url}`);
    });
    const service = await createService(fetch);
    const query = { sourceType: "Book" as const, isbn: "978-0-306-40615-7" };
    const first = await service.search(query);
    const second = await service.search(query);
    expect(first[0]).toMatchObject({
      provider: "open-library",
      title: "Precise Book",
      creators: [{ name: "Ada Author", role: "author" }],
      coverUrl: "https://covers.openlibrary.org/b/id/42-L.jpg"
    });
    expect(first[0]?.values).toMatchObject({ isbn13: "9780306406157", pageCount: 320 });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("falls back to Google Books when Open Library has no title candidates", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://openlibrary.org/search.json")) return json({ docs: [] });
      if (url.startsWith("https://www.googleapis.com/books/v1/volumes")) return json({ items: [{
        id: "google-1",
        volumeInfo: {
          title: "Brazilian Edition", authors: ["Bea Author"], publisher: "Google Press",
          publishedDate: "2025-02-03", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }]
        }
      }] });
      throw new Error(`unexpected:${url}`);
    });
    const service = await createService(fetch);
    expect(await service.search({ sourceType: "Book", title: "Brazilian Edition" })).toMatchObject([{
      provider: "google-books", title: "Brazilian Edition", year: 2025
    }]);
  });

  it("maps Crossref DOI metadata including affiliations and pages", async () => {
    const fetch = vi.fn(async () => json({ message: {
      DOI: "10.5555/EXAMPLE.42",
      title: ["A precise paper"],
      author: [{ given: "Ada", family: "Author", affiliation: [{ name: "Memora University" }] }],
      "container-title": ["Journal of Memory"],
      published: { "date-parts": [[2026, 7, 15]] },
      page: "12-28",
      abstract: "<jats:p>Structured abstract.</jats:p>"
    } }));
    const service = await createService(fetch);
    const candidates = await service.search({ sourceType: "AcademicPaper", doi: "https://doi.org/10.5555/example.42" });
    expect(candidates[0]?.values).toMatchObject({
      doi: "10.5555/example.42",
      venue: "Journal of Memory",
      publicationDate: "2026-07-15",
      pages: { start: "12", end: "28" },
      creators: [{ name: "Ada Author", role: "author", affiliation: "Memora University" }]
    });
  });

  it("performs no network access when disabled and degrades on network failure", async () => {
    const disabledFetch = vi.fn();
    const disabled = await createService(disabledFetch, false);
    expect(await disabled.search({ sourceType: "Book", title: "Private title" })).toEqual([]);
    expect(disabledFetch).not.toHaveBeenCalled();

    const failing = await createService(vi.fn(async () => { throw new Error("network_down"); }));
    expect(await failing.search({ sourceType: "Book", title: "Offline title" })).toEqual([]);
  });

  it("downloads an approved cover host and persists an unattached cover asset", async () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const query = vi.fn(async (_text: string, _values: readonly unknown[] = []) => ({
      command: "INSERT", rowCount: 1, oid: 0, fields: [], rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        documentId: null,
        sourceItemId: null,
        originalFileName: "metadata-cover.jpg",
        sha256: "a".repeat(64),
        mimeType: "image/jpeg",
        sizeBytes: 4,
        storageBase: "app_internal",
        relativePath: "sha256/aa/aa/file.jpg",
        role: "cover",
        metadata: { sourceUrl: "https://covers.openlibrary.org/b/id/42-L.jpg" },
        createdAt: now,
        updatedAt: now
      }]
    }));
    const pool = { query } as unknown as PgPool;
    const fetch = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Content-Length": "4" }
    }));
    const service = await createService(fetch, true, pool);
    await expect(service.downloadCover("https://covers.openlibrary.org/b/id/42-L.jpg")).resolves.toEqual({
      assetId: "00000000-0000-4000-8000-000000000001",
      mimeType: "image/jpeg"
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("insert into document_assets");
    expect(query.mock.calls[0]?.[1]).toContain("cover");
  });
});

async function createService(fetch: ReturnType<typeof vi.fn>, enabled = true, pool: PgPool | null = null) {
  const userDataPath = await mkdtemp(join(tmpdir(), "memora-metadata-enrichment-"));
  tempDirectories.push(userDataPath);
  return new MetadataEnrichmentService({
    getPool: () => pool,
    getEnabled: async () => enabled,
    userDataPath,
    fetch: fetch as unknown as typeof globalThis.fetch,
    timeoutMs: 100
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
