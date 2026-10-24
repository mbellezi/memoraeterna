import { cpus, release, totalmem } from "node:os";
import { statfs } from "node:fs/promises";

import { findLocalModelCatalogEntry, localModelExpectedSize } from "@app/ai";
import {
  recommendSetup,
  type HardwareProfile,
  type HardwareProfileInput,
  type HardwareProfileResult,
  type PriceTable
} from "@app/domain";

import { createCommandRunner, type CommandRunner } from "./commands.js";
import { probeHardware } from "./probe.js";
import {
  cacheIsCurrent,
  hardwareFingerprint,
  readProfileCache,
  writeProfileCache,
  type CheapFacts
} from "./profile-cache.js";

/** An incomplete profile is probed again after this long (it is never written to the cache). */
export const incompleteProfileRetryMs = 60_000;

export interface HardwareServiceOptions {
  /** Where `hardware/profile-v1.json` lives, and the volume whose free space is read. */
  userDataPath: string;
  /** The informative prices of the recommendation; defaults to the shipped table. */
  priceTable?: PriceTable;
  /** Everything below is injected by tests; the defaults read this machine. */
  run?: CommandRunner;
  platform?: string;
  processArch?: string;
  env?: Readonly<Record<string, string | undefined>>;
  osRelease?: () => string;
  totalMemoryBytes?: () => number;
  cpuModel?: () => { model: string | null; logicalCores: number | null };
  freeBytes?: (path: string) => Promise<number | null>;
  /** The pinned download size of a catalog entry, in bytes. */
  catalogBytes?: (catalogId: string) => number | null;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

/**
 * The hardware profile of this machine and the setup it recommends (F4 D32, T97; decisions 25, 26).
 * The profile is probed once, cached on disk and re-probed on a changed fingerprint, after 30 days or
 * on request; the free disk space is read at every call. It never writes a setting, downloads or
 * routes anything: the recommendation is informative.
 */
export class HardwareService {
  private memo: { profile: HardwareProfile; fingerprint: string; at: number } | null = null;
  private inflight: Promise<HardwareProfile> | null = null;

  constructor(private readonly options: HardwareServiceOptions) {}

  /** The cached profile, the figures read now and the recommendation (`hardware.profile`). */
  async profile(input: HardwareProfileInput = {}): Promise<HardwareProfileResult> {
    const profile = await this.readProfile(input.refresh === true);
    const recommendation = recommendSetup(profile, {
      ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {})
    });
    const catalogId = recommendation.local.writerCatalogId;
    return {
      profile,
      freeDiskBytes: await this.freeDiskBytes(),
      localWriterBytes: catalogId ? (this.catalogBytes(catalogId) ?? null) : null,
      recommendation
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private cheapFacts(): CheapFacts & { logicalCores: number | null } {
    const node = this.options.cpuModel?.() ?? nodeCpu();
    return {
      platform: this.options.platform ?? process.platform,
      osRelease: this.options.osRelease?.() ?? release(),
      processArch: this.options.processArch ?? process.arch,
      memoryBytes: this.options.totalMemoryBytes?.() ?? totalmem(),
      cpuModel: node.model,
      logicalCores: node.logicalCores
    };
  }

  /** One probe at a time: a caller shares the one in flight; a refresh waits for it, then probes again. */
  private async readProfile(refresh: boolean): Promise<HardwareProfile> {
    while (this.inflight) {
      const pending = this.inflight;
      if (!refresh) return pending;
      await pending.catch(() => undefined);
    }
    const current: Promise<HardwareProfile> = this.load(refresh).finally(() => {
      if (this.inflight === current) this.inflight = null;
    });
    this.inflight = current;
    return current;
  }

  private async load(refresh: boolean): Promise<HardwareProfile> {
    const facts = this.cheapFacts();
    const fingerprint = hardwareFingerprint(facts);
    const now = this.now();
    if (!refresh) {
      const memo = this.memo;
      if (memo && memo.fingerprint === fingerprint) {
        if (memo.profile.complete ? true : now.getTime() - memo.at < incompleteProfileRetryMs)
          return memo.profile;
      }
      const cached = await readProfileCache(this.options.userDataPath);
      if (cached && cacheIsCurrent(cached, fingerprint, now)) {
        this.memo = { profile: cached.profile, fingerprint, at: now.getTime() };
        return cached.profile;
      }
    }
    const profile = await probeHardware({
      platform: facts.platform,
      processArch: facts.processArch,
      osRelease: facts.osRelease,
      totalMemoryBytes: facts.memoryBytes,
      cpuModel: facts.cpuModel,
      logicalCores: facts.logicalCores,
      env: this.options.env ?? process.env,
      run: this.options.run ?? createCommandRunner(),
      now
    });
    this.memo = { profile, fingerprint, at: now.getTime() };
    if (profile.complete) {
      try {
        await writeProfileCache(this.options.userDataPath, fingerprint, profile);
      } catch (error) {
        this.options.logger?.warn(`HARDWARE profile not cached: ${describe(error)}`);
      }
    } else {
      this.options.logger?.warn("HARDWARE profile incomplete: a probe command did not answer");
    }
    return profile;
  }

  private catalogBytes(catalogId: string): number | null {
    if (this.options.catalogBytes) return this.options.catalogBytes(catalogId);
    const entry = findLocalModelCatalogEntry(catalogId);
    return entry ? localModelExpectedSize(entry) : null;
  }

  private async freeDiskBytes(): Promise<number | null> {
    try {
      return await (this.options.freeBytes ?? statfsFreeBytes)(this.options.userDataPath);
    } catch {
      return null;
    }
  }
}

function nodeCpu(): { model: string | null; logicalCores: number | null } {
  const all = cpus();
  return { model: all[0]?.model ?? null, logicalCores: all.length > 0 ? all.length : null };
}

async function statfsFreeBytes(path: string): Promise<number | null> {
  const volume = await statfs(path);
  const free = Number(volume.bavail) * Number(volume.bsize);
  return Number.isFinite(free) && free >= 0 ? Math.floor(free) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
