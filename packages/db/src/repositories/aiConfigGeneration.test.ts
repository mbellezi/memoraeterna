import { describe, expect, it } from "vitest";

import {
  aiConfigGeneration,
  aiConfigRepositoryReaders,
  aiConfigRepositoryWriters,
  bumpAiConfigGeneration,
  bumpingGenerationAfter,
  createAiConfigRepository,
  createLocalModelRepository,
  localModelRepositoryBookkeeping,
  localModelRepositoryReaders,
  localModelRepositoryWriters
} from "../index.js";
import type { Queryable } from "./types.js";

/** A database that accepts every statement and returns nothing: enough to call a method. */
const emptyDb = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;

async function bumps(call: () => Promise<unknown>): Promise<number> {
  const before = aiConfigGeneration();
  await call().catch(() => undefined);
  return aiConfigGeneration() - before;
}

describe("the generation of the AI configuration (F3 D38)", () => {
  it("only grows", () => {
    const before = aiConfigGeneration();
    bumpAiConfigGeneration();
    bumpAiConfigGeneration();
    expect(aiConfigGeneration()).toBe(before + 2);
  });

  it("wraps the writers it is given and leaves the other methods as they are", async () => {
    const repository = {
      write: async () => "written",
      fail: async () => {
        throw new Error("no");
      },
      read: async () => "read"
    };
    const wrapped = bumpingGenerationAfter(repository, ["write", "fail"]);
    expect(wrapped.read).toBe(repository.read);
    expect(await bumps(wrapped.read)).toBe(0);
    expect(await bumps(wrapped.write)).toBe(1);
    // A failed write may have changed a row: it reports itself too.
    expect(await bumps(wrapped.fail)).toBe(1);
    await expect(wrapped.write()).resolves.toBe("written");
    await expect(wrapped.fail()).rejects.toThrow("no");
  });

  describe("every method of the AI configuration repository is a reader or a writer", () => {
    const repository = createAiConfigRepository(emptyDb);
    const writers: readonly string[] = aiConfigRepositoryWriters;
    const readers: readonly string[] = aiConfigRepositoryReaders;

    it("is classified: a new method fails here until it is put in one list", () => {
      expect(Object.keys(repository).toSorted()).toEqual([...writers, ...readers].toSorted());
    });

    it.each(aiConfigRepositoryWriters)("%s bumps the generation", async (name) => {
      const method = repository[name] as unknown as (...args: unknown[]) => Promise<unknown>;
      expect(await bumps(() => method({ id: "id", name: "n" }, "second"))).toBeGreaterThan(0);
    });

    it.each(aiConfigRepositoryReaders)("%s leaves it alone", async (name) => {
      const method = repository[name] as unknown as (...args: unknown[]) => Promise<unknown>;
      expect(await bumps(() => method("task", undefined, ["task"]))).toBe(0);
    });
  });

  describe("every method of the local model repository is classified", () => {
    const repository = createLocalModelRepository(emptyDb);
    const writers: readonly string[] = localModelRepositoryWriters;
    const bookkeeping: readonly string[] = localModelRepositoryBookkeeping;
    const readers: readonly string[] = localModelRepositoryReaders;

    it("is classified: a new method fails here until it is put in one list", () => {
      expect(Object.keys(repository).toSorted()).toEqual(
        [...writers, ...bookkeeping, ...readers].toSorted()
      );
    });

    it.each(localModelRepositoryWriters)("%s bumps the generation", async (name) => {
      const method = repository[name] as unknown as (...args: unknown[]) => Promise<unknown>;
      expect(await bumps(() => method("id", { status: "ready" }))).toBeGreaterThan(0);
    });

    it.each([...localModelRepositoryBookkeeping, ...localModelRepositoryReaders])(
      "%s leaves it alone",
      async (name) => {
        const method = repository[name] as unknown as (...args: unknown[]) => Promise<unknown>;
        expect(await bumps(() => method("id", [], 1))).toBe(0);
      }
    );
  });
});
