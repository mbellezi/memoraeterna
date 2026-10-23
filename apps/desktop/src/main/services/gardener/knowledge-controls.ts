import { createSettingsRepository, type PgPool } from "@app/db";
import {
  applyKnowledgeControlsUpdate,
  changedKnowledgeControls,
  defaultKnowledgeControls,
  knowledgeControlsSettingKey,
  readKnowledgeControls,
  type KnowledgeControls
} from "@app/domain";

/** Where the controls are kept: the `settings` row `knowledge.controls.v1`. */
export interface KnowledgeControlsStore {
  read(): Promise<unknown>;
  write(controls: KnowledgeControls): Promise<void>;
}

export function settingsKnowledgeControlsStore(
  getPool: () => PgPool | null
): KnowledgeControlsStore {
  const settings = () => {
    const pool = getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return createSettingsRepository(pool);
  };
  return {
    read: () => settings().get(knowledgeControlsSettingKey),
    write: async (controls) => {
      await settings().set(knowledgeControlsSettingKey, controls);
    }
  };
}

export interface KnowledgeControlsChange {
  before: KnowledgeControls;
  after: KnowledgeControls;
  changed: Array<keyof KnowledgeControls>;
}

export interface KnowledgeControlsServiceOptions {
  store: KnowledgeControlsStore;
  /**
   * The database the controls belong to: another pool (a restored backup, a reset library) is
   * another library, so the next read loads them again.
   */
  pool?: () => unknown;
  logger?: Pick<Console, "warn">;
}

/**
 * The Knowledge controls in main (F4 D13): read once and kept behind a generation counter, the
 * F3 D38 pattern. Every write goes through {@link KnowledgeControlsService.update}, which moves the
 * generation and tells the listeners (the blocker service, the status). The claim path reads
 * {@link KnowledgeControlsService.current} without a query.
 */
export class KnowledgeControlsService {
  private value: KnowledgeControls = { ...defaultKnowledgeControls };
  private loadedGeneration = -1;
  private currentGeneration = 0;
  private seenPool: unknown = undefined;
  private loading: Promise<KnowledgeControls> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(change: KnowledgeControlsChange) => void>();

  public constructor(private readonly options: KnowledgeControlsServiceOptions) {}

  /** The controls as last read (the defaults before the first read); never queries. */
  public current(): KnowledgeControls {
    return this.value;
  }

  /** Moves on every change the service makes or sees. */
  public generation(): number {
    return this.currentGeneration;
  }

  /** The controls, read from the store on first use and after the database changed. */
  public async get(): Promise<KnowledgeControls> {
    const pool = this.options.pool?.();
    if (this.loadedGeneration === this.currentGeneration && pool === this.seenPool)
      return this.value;
    this.loading ??= this.load(pool).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Validates and stores a change, then tells the listeners what changed. */
  public update(change: unknown): Promise<KnowledgeControls> {
    const write = this.writes.then(async () => {
      const before = readKnowledgeControls(await this.options.store.read());
      const after = applyKnowledgeControlsUpdate(before, change);
      await this.options.store.write(after);
      this.accept(after, this.options.pool?.());
      return after;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  public subscribe(listener: (change: KnowledgeControlsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async load(pool: unknown): Promise<KnowledgeControls> {
    const generation = this.currentGeneration;
    const stored = await this.options.store.read();
    // A write that landed while the row was read wins: it is newer than what was read.
    if (generation !== this.currentGeneration) return this.value;
    this.accept(readKnowledgeControls(stored), pool);
    return this.value;
  }

  private accept(next: KnowledgeControls, pool: unknown): void {
    const before = this.value;
    const changed = changedKnowledgeControls(before, next);
    this.value = next;
    this.seenPool = pool;
    this.currentGeneration += 1;
    this.loadedGeneration = this.currentGeneration;
    if (changed.length === 0) return;
    for (const listener of this.listeners)
      try {
        listener({ before, after: next, changed });
      } catch (error) {
        this.options.logger?.warn("A Knowledge controls listener failed", error);
      }
  }
}
