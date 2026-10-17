/**
 * The generation of the AI configuration (F3 D38): a counter that every writer of a route, a
 * provider configuration, a profile, a local model or a credential bumps. The hot path of an AI call
 * caches what it reads of that configuration (routes, provider rows, decrypted credentials,
 * adapters) and drops it when the generation moved, so a cache entry is never older than the last
 * write this process made. It lives beside the repositories because they are the only writers of the
 * configuration tables: wrapping their write methods covers every caller, whatever service it is.
 *
 * Writers use autocommit statements (a pool, not an open transaction): the bump follows the commit.
 * The counter is per process; the configuration is written by this process only.
 */
let generation = 0;

/** The current generation; it only grows. */
export function aiConfigGeneration(): number {
  return generation;
}

/** A configuration, a credential or a local model changed: drop what was cached of them. */
export function bumpAiConfigGeneration(): void {
  generation += 1;
}

type AsyncMethod = (...args: never[]) => Promise<unknown>;

/**
 * The repository with the given write methods bumping the generation once they settle, successful
 * or not (a failed write may still have changed a row). Reads are returned as they are.
 */
export function bumpingGenerationAfter<T extends object>(
  repository: T,
  writers: ReadonlyArray<keyof T>
): T {
  const wrapped = { ...repository } as Record<string, unknown>;
  for (const name of writers) {
    const method = repository[name] as unknown as AsyncMethod;
    wrapped[name as string] = async (...args: never[]) => {
      try {
        return await method(...args);
      } finally {
        bumpAiConfigGeneration();
      }
    };
  }
  return wrapped as T;
}
