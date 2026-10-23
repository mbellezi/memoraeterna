import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  composeInput,
  readCassette,
  rehydrateIds,
  splitLanguagePrefix,
  syntheticId
} from "./replay-cassette.ts";
import { notesBody, recorded, summaryBody, writeCassette } from "./test-fixtures.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bench-cassette-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("put back IDs", () => {
  it("replaces every placeholder with a deterministic UUID of its number", () => {
    expect(syntheticId(1)).toBe("00000000-0000-4000-8000-000000000001");
    expect(syntheticId(255)).toBe("00000000-0000-4000-8000-0000000000ff");
    const text = rehydrateIds("[⟦id:1⟧] and [⟦id:2⟧] and ⟦id:1⟧ again");
    expect(text).toBe(
      "[00000000-0000-4000-8000-000000000001] and [00000000-0000-4000-8000-000000000002] and 00000000-0000-4000-8000-000000000001 again"
    );
  });
});

describe("the output-language instruction", () => {
  it.each(["en", "pt-BR", "it", "fr", "es"])("splits %s off and puts it back", (language) => {
    const input = composeInput(summaryBody(), language);
    expect(splitLanguagePrefix(input)).toEqual({ language, body: summaryBody() });
  });

  it("refuses a text without one", () => {
    expect(splitLanguagePrefix(summaryBody())).toBeNull();
  });
});

describe("reading a cassette", () => {
  it("reads sharded entries, puts IDs back and orders them as they were recorded", async () => {
    const later = recorded({
      taskType: "summarization",
      body: summaryBody(),
      output: "later",
      recordedAt: "2026-10-14T12:00:05.000Z"
    });
    const earlier = recorded({
      taskType: "atomic-note-generation",
      body: notesBody(),
      output: "earlier ⟦id:3⟧",
      recordedAt: "2026-10-14T12:00:01.000Z"
    });
    await writeCassette(directory, [later, earlier]);
    const calls = await readCassette(directory);
    expect(calls.map((call) => call.output)).toEqual([`earlier ${syntheticId(3)}`, "later"]);
    expect(calls[0]).toMatchObject({
      taskType: "atomic-note-generation",
      providerId: "openai-codex",
      runtime: "remote",
      inputTokens: 1_000,
      outputTokens: 300,
      responses: 1
    });
  });

  it("keeps only the task types and the runtime asked for", async () => {
    const remote = recorded({ taskType: "summarization", body: summaryBody(), output: "a" });
    const local = {
      ...recorded({ taskType: "summarization", body: summaryBody(), output: "b" }),
      runtime: "local" as const
    };
    const other = recorded({ taskType: "embedding", body: "x", output: "[]" });
    await writeCassette(directory, [remote, local, other]);
    expect(await readCassette(directory)).toHaveLength(3);
    expect(
      (
        await readCassette(directory, { taskTypes: new Set(["summarization"]), runtime: "remote" })
      ).map((call) => call.output)
    ).toEqual(["a"]);
  });

  it("skips an entry whose input is not text", async () => {
    const call = recorded({ taskType: "summarization", body: summaryBody(), output: "a" });
    await writeCassette(directory, [call]);
    await writeCassette(join(directory, "..", "unused"), []).catch(() => undefined);
    const entry = join(directory, "entries", "zz");
    await mkdir(entry, { recursive: true });
    await writeFile(
      join(entry, "z.json"),
      JSON.stringify({
        format: "memora-ai-cassette-entry",
        version: 1,
        key: "f".repeat(64),
        taskType: "summarization",
        request: {
          input: { not: "text" },
          model: { providerId: "p", modelId: "m", runtime: "remote" }
        },
        responses: [
          {
            output: "x",
            providerId: "p",
            modelId: "m",
            runtime: "remote",
            durationMs: 1,
            recordedAt: "2026-10-14T12:00:00.000Z"
          }
        ]
      })
    );
    expect(await readCassette(directory)).toHaveLength(1);
  });

  it("refuses a folder that is not a cassette", async () => {
    await expect(readCassette(directory)).rejects.toThrow(/not a cassette/u);
    await writeFile(join(directory, "cassette.json"), JSON.stringify({ format: "other" }));
    await expect(readCassette(directory)).rejects.toThrow();
  });
});
