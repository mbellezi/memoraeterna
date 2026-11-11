import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";

import { searchIpcChannels } from "../../shared/ipc-search.js";
import { registerSearchOmniIpc } from "./search-omni-ipc.js";
import { SearchOmniService, type OmniQueryEmbedder } from "./search-omni-service.js";

// The statement runs against a real database in `omniSearchRepository.sidecar.test.ts`; these tests
// pin the boundary: what is validated, which arms a request asks for, when the query is embedded,
// how a missing embedder degrades, and what the answer carries.
const ids = {
  topic: "00000000-0000-4000-8000-000000000001",
  note: "00000000-0000-4000-8000-000000000002",
  source: "00000000-0000-4000-8000-000000000003",
  chunk: "00000000-0000-4000-8000-000000000004"
};

const rows = [
  {
    kind: "note",
    id: ids.note,
    passage: null,
    title: "Lactic fermentation",
    arms: [{ arm: "title_trgm", rank: "2" }],
    snippet: null
  },
  {
    kind: "topic",
    id: ids.topic,
    passage: null,
    title: "Fermentação",
    arms: [
      { arm: "title_trgm", rank: "1" },
      { arm: "fts", rank: "1" }
    ],
    snippet: null
  },
  {
    kind: "source",
    id: ids.source,
    passage: ids.chunk,
    title: "Fermentação lática",
    arms: [{ arm: "chunk_fts", rank: "1" }],
    snippet: "O kefir passa por fermentação."
  }
];

const vector = Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0));

function setup(
  options: {
    pool?: boolean;
    embedder?: OmniQueryEmbedder["runDefaultTask"] | null;
  } = {}
) {
  const query = vi.fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(
    async (text) => ({
      rows: text.startsWith("select set_config") ? [] : rows
    })
  );
  const runDefaultTask = options.embedder === undefined ? null : options.embedder;
  const embedder = runDefaultTask ? ({ runDefaultTask } as unknown as OmniQueryEmbedder) : null;
  const service = new SearchOmniService(
    () => (options.pool === false ? null : ({ query } as unknown as PgPool)),
    embedder
  );
  const statements = () =>
    query.mock.calls.map(([text]) => text).filter((text) => !text.startsWith("select set_config"));
  return { service, query, statements, runDefaultTask };
}

const embedded = async () => ({
  output: vector,
  modelId: "embed-model",
  providerId: "local",
  runtime: "local",
  embeddingSpaceKey: "local:embed:256"
});

describe("search.omni", () => {
  it("answers quick mode with one statement, fused and ordered, with the request's id", async () => {
    const { service, statements } = setup();
    const result = await service.omni({ query: "fermentação", mode: "quick", requestId: "r-1" });
    expect(statements()).toHaveLength(1);
    expect(result.requestId).toBe("r-1");
    expect(result.degraded).toEqual([]);
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    expect(result.items).toEqual([
      {
        address: `memora://topic/${ids.topic}`,
        kind: "topic",
        title: "Fermentação",
        arms: [
          { arm: "title_trgm", rank: 1 },
          { arm: "fts", rank: 1 }
        ],
        score: 2 / 61
      },
      {
        address: `memora://source/${ids.source}#passage=${ids.chunk}`,
        kind: "source",
        title: "Fermentação lática",
        snippet: "O kefir passa por fermentação.",
        arms: [{ arm: "chunk_fts", rank: 1 }],
        score: 1 / 61
      },
      {
        address: `memora://note/${ids.note}`,
        kind: "note",
        title: "Lactic fermentation",
        arms: [{ arm: "title_trgm", rank: 2 }],
        score: 1 / 62
      }
    ]);
  });

  it("asks quick mode for titles, names, aliases and full text, never passages or vectors", async () => {
    const runDefaultTask = vi.fn(embedded);
    const { service, statements, query } = setup({ embedder: runDefaultTask as never });
    await service.omni({ query: "fermentação", mode: "quick", requestId: "r" });
    const [text] = statements();
    for (const fragment of [
      "q.t <% f_unaccent(x.title)",
      "q.t <% f_unaccent(x.canonical_name)",
      "q.t <% f_unaccent(f_jsonb_text_array(x.aliases))",
      "q.t <% f_unaccent(x.text)",
      "x.search_tsv @@ q.ts",
      "sum(1.0 / (60 + rank))"
    ])
      expect(text).toContain(fragment);
    expect(text).not.toContain("from chunks x");
    expect(text).not.toContain("embeddings_");
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(query.mock.calls[0]![1]).toEqual(["fermentação", ["fermentação"], 20]);
  });

  it("`#` (topics) and `@` (entities) run only that kind's arms", async () => {
    const { service, statements } = setup();
    await service.omni({ query: "ferm", mode: "quick", kinds: ["topic"], requestId: "r" });
    await service.omni({ query: "curie", mode: "quick", kinds: ["entity"], requestId: "r" });
    const [topics, entities] = statements();
    expect(topics!.match(/'(\w+)'::text as kind/gu)).toEqual([
      "'topic'::text as kind",
      "'topic'::text as kind"
    ]);
    expect(entities!.match(/'(\w+)'::text as kind/gu)).toEqual([
      "'entity'::text as kind",
      "'entity'::text as kind"
    ]);
    expect(entities).toContain("'alias_trgm'::text as arm");
  });

  it("embeds the query at P0 in full mode and adds passages and vectors of its space", async () => {
    const runDefaultTask = vi.fn(embedded);
    const { service, statements, query } = setup({ embedder: runDefaultTask as never });
    const result = await service.omni({ query: "kefir", mode: "full", requestId: "r" });
    expect(runDefaultTask).toHaveBeenCalledWith(
      "embedding",
      "kefir",
      expect.objectContaining({ embeddingInputType: "query", priority: "P0" })
    );
    expect(result.degraded).toEqual([]);
    const [text] = statements();
    expect(text).toContain("from chunks x");
    expect(text).toContain("embeddings_256");
    expect(text).toContain("e.target_type = 'atomic_note'");
    expect(text).toContain("e.target_type = 'chunk'");
    // The vector scan settings apply to the statement's transaction.
    expect(query.mock.calls.some(([sql]) => sql.startsWith("select set_config"))).toBe(true);
    const values = query.mock.calls.find(([sql]) => !sql.startsWith("select set_config"))![1];
    expect(values).toEqual(
      expect.arrayContaining(["embed-model", "local:embed:256", "local", `[${vector.join(",")}]`])
    );
  });

  it("degrades full mode explicitly when no vector can be had", async () => {
    const cases: Array<OmniQueryEmbedder["runDefaultTask"] | null> = [
      null,
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error("no model");
      }),
      vi.fn(async () => ({ ...(await embedded()), output: [0.1, 0.2, 0.3] })),
      vi.fn(async () => ({ ...(await embedded()), output: vector.map(() => Number.NaN) })),
      vi.fn(async () => ({ ...(await embedded()), embeddingSpaceKey: undefined }))
    ] as never;
    for (const embedder of cases) {
      const { service, statements } = setup({ embedder });
      const result = await service.omni({ query: "kefir", mode: "full", requestId: "r" });
      expect(result.degraded).toEqual(["ann"]);
      expect(result.items).toHaveLength(3);
      const [text] = statements();
      expect(text).toContain("from chunks x");
      expect(text).not.toContain("embeddings_");
    }
  });

  it("says full text did not run for a query with no word", async () => {
    const { service, statements } = setup();
    const quick = await service.omni({ query: "?!", mode: "quick", requestId: "r" });
    expect(quick.degraded).toEqual(["fts"]);
    const full = await service.omni({ query: "?!", mode: "full", requestId: "r" });
    expect(full.degraded).toEqual(["ann", "fts"]);
    for (const text of statements()) expect(text).not.toContain("search_tsv");
  });

  it("passes the scope and the limit to the statement", async () => {
    const { service, query } = setup();
    await service.omni({
      query: "ferm",
      mode: "quick",
      scope: { topicId: ids.topic },
      limit: 5,
      requestId: "r"
    });
    const [text, values] = query.mock.calls[0]!;
    expect(text).toContain("topic_sub as (");
    expect(values).toEqual(["ferm", ["ferm"], 5, ids.topic]);
  });

  it("refuses a request that does not match before reading anything", async () => {
    const { service, query } = setup();
    const bad = [
      { query: "", mode: "quick", requestId: "r" },
      { query: "   ", mode: "quick", requestId: "r" },
      { query: "x".repeat(201), mode: "quick", requestId: "r" },
      { query: "a", mode: "slow", requestId: "r" },
      { query: "a", mode: "quick" },
      { query: "a", mode: "quick", requestId: "r", limit: 51 },
      { query: "a", mode: "quick", requestId: "r", kinds: [] },
      { query: "a", mode: "quick", requestId: "r", kinds: ["topic", "topic"] },
      { query: "a", mode: "quick", requestId: "r", kinds: ["wiki"] },
      { query: "a", mode: "quick", requestId: "r", scope: { topicId: "nope" } },
      { query: "a", mode: "quick", requestId: "r", extra: true }
    ];
    for (const input of bad) await expect(service.omni(input)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails clearly while the database is not ready", async () => {
    const { service } = setup({ pool: false });
    await expect(service.omni({ query: "a", mode: "quick", requestId: "r" })).rejects.toThrow(
      "errors.database.notReady"
    );
  });
});

describe("search.omni IPC", () => {
  it("registers the channel and hands the payload to the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain;
    const { service } = setup();
    registerSearchOmniIpc(ipc, service);
    expect([...handlers.keys()]).toEqual([searchIpcChannels.searchOmni]);
    const result = (await handlers.get(searchIpcChannels.searchOmni)!(
      {},
      { query: "ferm", mode: "quick", requestId: "r-9" }
    )) as { requestId: string };
    expect(result.requestId).toBe("r-9");
    await expect(
      Promise.resolve().then(() =>
        handlers.get(searchIpcChannels.searchOmni)!({}, { query: "", mode: "quick" })
      )
    ).rejects.toThrow();
  });
});
