import { aiConfigGeneration, bumpAiConfigGeneration } from "@app/db";

/**
 * What the hot path of an AI call reads of the configuration (F3 D38): the route a task resolves,
 * the provider rows, a local model's row, the decrypted credentials, and the adapters built from
 * them. About eight SQL statements and a keychain decryption per call ran inside the lane's slot
 * before this cache.
 *
 * Everything is valid for one generation of the AI configuration (`aiConfigGeneration`): every writer
 * of a route, provider, profile, local model or credential bumps it, and the first access after a
 * bump drops all of it, the adapters included (their remembered refusals with them). A read that was
 * in flight when the generation moved is not stored. Entries are the promises of their loads, so
 * concurrent callers share one read, and a failed load is not kept.
 *
 * Reads return copies of the rows, so no caller can change what another one sees.
 */
export interface AiConfigCacheOptions {
  /** The generation of the configuration; the repositories' and the credential service's writers move it. */
  generation?: () => number;
  /** The database pool: another pool (a restored backup, a new profile) is another configuration. */
  pool?: () => unknown;
}

type Space = "routes" | "providers" | "localModels" | "credentials" | "adapters";

export interface AiConfigCacheStats {
  generation: number;
  hits: number;
  loads: number;
  /** Times the cache was dropped because the configuration changed. */
  drops: number;
}

export class AiConfigCache {
  private readonly generationOf: () => number;
  private readonly poolOf: () => unknown;
  private spaces: Record<Space, Map<string, Promise<unknown>>> = AiConfigCache.emptySpaces();
  private seenGeneration: number;
  private seenPool: unknown;
  private counters = { hits: 0, loads: 0, drops: 0 };

  public constructor(options: AiConfigCacheOptions = {}) {
    this.generationOf = options.generation ?? aiConfigGeneration;
    this.poolOf = options.pool ?? (() => null);
    this.seenGeneration = this.generationOf();
    this.seenPool = this.poolOf();
  }

  private static emptySpaces(): Record<Space, Map<string, Promise<unknown>>> {
    return {
      routes: new Map(),
      providers: new Map(),
      localModels: new Map(),
      credentials: new Map(),
      adapters: new Map()
    };
  }

  /** The configuration changed (a writer of this service, which the repositories also report). */
  public invalidate(): void {
    bumpAiConfigGeneration();
    this.sync();
  }

  public stats(): AiConfigCacheStats {
    return { generation: this.generationOf(), ...this.counters };
  }

  /** A route read (`getDefaultTask`), keyed by what the read was asked. */
  public route<T extends object | null>(key: string, load: () => Promise<T>): Promise<T> {
    return this.copied("routes", key, load);
  }

  /** The provider rows. */
  public providers<T extends readonly object[]>(load: () => Promise<T>): Promise<T> {
    return this.copied("providers", "all", load);
  }

  /** A local model's row. */
  public localModel<T extends object | null>(id: string, load: () => Promise<T>): Promise<T> {
    return this.copied("localModels", id, load);
  }

  /** A decrypted credential, by its reference. */
  public credential(reference: string, load: () => Promise<string>): Promise<string> {
    return this.memo("credentials", reference, load);
  }

  /** The adapter of a provider configuration; one instance until the configuration changes. */
  public adapter<T extends object>(key: string, build: () => Promise<T>): Promise<T> {
    return this.memo("adapters", key, build);
  }

  private async copied<T extends object | null>(
    space: Space,
    key: string,
    load: () => Promise<T>
  ): Promise<T> {
    return structuredClone(await this.memo(space, key, load));
  }

  private memo<T>(name: Space, key: string, load: () => Promise<T>): Promise<T> {
    this.sync();
    const space = this.spaces[name];
    const hit = space.get(key);
    if (hit) {
      this.counters.hits += 1;
      return hit as Promise<T>;
    }
    this.counters.loads += 1;
    const pending = load();
    space.set(key, pending);
    // A load that failed is not kept; the rejection itself still reaches the callers.
    pending.catch(() => {
      if (space.get(key) === pending) space.delete(key);
    });
    return pending;
  }

  /** Drops everything when the configuration, or the database, is not the one that was cached. */
  private sync(): void {
    const generation = this.generationOf();
    const pool = this.poolOf();
    if (generation === this.seenGeneration && pool === this.seenPool) return;
    this.seenGeneration = generation;
    this.seenPool = pool;
    this.counters.drops += 1;
    this.spaces = AiConfigCache.emptySpaces();
  }
}
