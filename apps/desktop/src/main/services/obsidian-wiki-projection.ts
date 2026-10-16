import { inspectMirrorAssets, projectMirrorAssets } from "./obsidian-asset-projection.js";
import { createObsidianLayoutRepository } from "@app/db";
import {
  buildObsidianMirror,
  planObsidianMirror,
  targetKey,
  type MirrorPlan,
  type PlannedTarget,
  type RenderedTarget
} from "./obsidian-mirror.js";
import { obsidianLayoutConfigSchema, type ObsidianLayoutConfig } from "@app/integration-contracts";
import { jobTaskPayload } from "../job-task-payload.js";
import { createSourceItemRepository } from "@app/db";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  createDocumentRepository,
  createJobRepository,
  createObsidianSyncRepository,
  createObsidianWikiRepository,
  createSettingsRepository,
  type PgPool,
  type JobRecord,
  type ProjectionDelivery
} from "@app/db";
import { translate, type MessageKey } from "@app/i18n";
import {
  normalizeProjectionText,
  parseObsidianMarkdown,
  parseWikiRegions,
  serializeManagedFrontmatter,
  wikiGeneratedStart,
  wikiGeneratedEnd,
  wikiLink,
  safeWikiLabel,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";
import type { StorageSettings } from "../../shared/ipc.js";
import { collisionFileName, slugify } from "./obsidian-projection.js";
import {
  safeVaultPath,
  type ObsidianArchiveInput,
  type ObsidianArchiveResult
} from "../workers/obsidian-sync.worker.js";
import {
  ObsidianWikiRetirement,
  createPgRetirementStore,
  type RetireSummary
} from "./obsidian-wiki-retire.js";
import {
  planTopicProjection,
  renderTopicMoc,
  withTopicAliases
} from "./obsidian-topic-projection.js";
export { obsidianWikiScopeSchema as ObsidianWikiScopeSchema } from "../../shared/ipc.js";
import {
  obsidianWikiScopeSchema as ObsidianWikiScopeSchema,
  storedObsidianWikiScopeSchema
} from "../../shared/ipc.js";
export type ObsidianWikiScope = z.infer<typeof ObsidianWikiScopeSchema>;
const INDEX = "7cfe90b4-11fb-447d-9673-849b6a3dc000",
  CATALOG = "7cfe90b4-11fb-447d-9673-849b6a3dc001",
  RELATIONS = "7cfe90b4-11fb-447d-9673-849b6a3dc002";
/**
 * Paged delivery (D30): a pass delivers its targets in pages on the light lane, one page per job,
 * and each page queues the next with its cursor, so placements interleave with the projection and a
 * crash resumes from the last cursor. There is no count cap: a file larger than `fileBytes` fails
 * alone, by name, and the pass goes on.
 */
export interface ObsidianDeliveryConfig {
  /** Targets one page delivers at most. */
  pageTargets: number;
  /** Rendered bytes after which a page stops; a page always delivers at least one target. */
  pageBytes: number;
  /** Work after which a page stops, so placements on the same worker wait at most about this long. */
  pageMs: number;
  /** The largest managed file (the sync worker refuses larger writes too). */
  fileBytes: number;
  /** Targets rendered at once inside a page. */
  renderBatch: number;
  /** Failed files a page result names (the count is always exact). */
  reportedFailures: number;
}
export const obsidianDeliveryConfig: Readonly<ObsidianDeliveryConfig> = Object.freeze({
  pageTargets: 200,
  pageBytes: 4_000_000,
  pageMs: 1_000,
  fileBytes: 2_000_000,
  renderBatch: 8,
  reportedFailures: 50
});
export const projectionHash = (text: string) =>
  createHash("sha256").update(normalizeProjectionText(text)).digest("hex");
const active = (s: StorageSettings) =>
  s.obsidianSyncEnabled && !s.obsidianSyncPaused && Boolean(s.obsidianVaultPath);
const passSchema = z
  .object({
    startedAt: z.string(),
    total: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    projected: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  })
  .strict();
/** One page's job: the pass (binding, generation) and the checkpoint where this page starts. */
const pagePayloadSchema = z
  .object({
    binding: z.string(),
    generation: z.string(),
    cursor: z.string().min(1).nullable().optional(),
    page: z.number().int().nonnegative().optional(),
    pass: passSchema.optional()
  })
  .strict();
type Pass = z.infer<typeof passSchema>;
export interface WikiProjectionOptions {
  getPool: () => PgPool | null;
  getStorageSettings: () => Promise<StorageSettings>;
  getLocale?: () => Promise<string>;
  assetRoots?: () => Promise<Record<string, string>>;
  projectSource: (
    id: string,
    allowedNoteIds?: Set<string>,
    admittedBinding?: string
  ) => Promise<{
    projected: number;
  }>;
  write: (input: {
    vaultPath: string;
    relativePath: string;
    content: string;
    expectedHash: string | null;
    recoveryId: string;
    managedRoot: string;
  }) => Promise<{
    mtimeMs: number;
  }>;
  /** Moves one retired file into `.memora-recovery` (the Obsidian sync worker). */
  archive: (input: ObsidianArchiveInput) => Promise<ObsidianArchiveResult>;
  /** Delivery page sizes (tests shrink them). */
  delivery?: Partial<ObsidianDeliveryConfig>;
}
interface Target {
  id: string;
  type: ObsidianManagedFrontmatter["memoraType"];
  revision: string;
  title: string;
  path: string;
  editorial: string;
  generated: string;
  sourceId?: string;
  documentId?: string;
  layout?: ObsidianLayoutConfig;
  linkMap?: Array<{ rendered: string; canonical: string }>;
  rootSourceId?: string;
  divisionId?: string;
  documentRevisionId?: string;
  aliases?: string[];
}
/** A pass's plan: what it delivers, in order; first-generation sources go through `projectSource`. */
interface DeliveryPlan extends MirrorPlan {
  sourceUnits: ReadonlySet<string>;
  allowedNotes: Set<string>;
}
export class ObsidianWikiProjection {
  private planCache: { key: string; plan: DeliveryPlan } | null = null;
  constructor(private readonly options: WikiProjectionOptions) {}
  private delivery() {
    return { ...obsidianDeliveryConfig, ...this.options.delivery };
  }
  private pool() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
  private retirement() {
    return new ObsidianWikiRetirement({
      store: createPgRetirementStore(this.pool()),
      archive: (input) => this.options.archive(input),
      hash: projectionHash
    });
  }
  async layout(): Promise<ObsidianLayoutConfig | null> {
    const value = await createSettingsRepository(this.pool()).get("obsidian.layout");
    return value && (value as { version?: number }).version !== 1
      ? obsidianLayoutConfigSchema.parse(value)
      : null;
  }
  async ensureLayout() {
    const existing = await this.layout();
    if (existing) return existing;
    const s = await this.options.getStorageSettings();
    if (
      active(s) &&
      !(await createSettingsRepository(this.pool()).get("obsidian.layout")) &&
      !(await createObsidianSyncRepository(this.pool()).list(1)).length
    ) {
      const config = obsidianLayoutConfigSchema.parse({
        version: 2,
        language: (await this.options.getLocale?.()) ?? "en",
        attachments: "omit"
      });
      await createSettingsRepository(this.pool()).set("obsidian.layout", config);
      return config;
    }
    return null;
  }
  async assets(config: ObsidianLayoutConfig, migrate = false) {
    const s = await this.options.getStorageSettings(),
      scope = await this.scope(),
      sources = await createObsidianWikiRepository(this.pool()).sources(
        scope.sourceIds,
        scope.includeDescendants
      );
    return inspectMirrorAssets(
      this.pool(),
      s,
      sources.map((r) => String(r.id)),
      config,
      (await this.options.assetRoots?.()) ?? {},
      migrate
    );
  }
  async mirror(config: ObsidianLayoutConfig, migrate = false, excluded?: Set<string>) {
    const s = await this.options.getStorageSettings();
    const assets = await this.assets(config, migrate);
    for (const asset of assets)
      if (excluded?.has(asset.id)) {
        const old = await createObsidianSyncRepository(this.pool()).findByMemoraId(asset.id);
        if (old) asset.path = old.relativePath;
      }
    return buildObsidianMirror(this.pool(), s.managedRoot, await this.scope(), config, {
      migrate,
      assets,
      ...(excluded ? { excluded } : {})
    });
  }
  async scope(): Promise<ObsidianWikiScope> {
    return storedObsidianWikiScopeSchema.parse(
      (await createSettingsRepository(this.pool()).get("obsidian.wiki.scope")) ?? {}
    );
  }
  async saveScope(input: unknown) {
    const scope = ObsidianWikiScopeSchema.parse(input);
    await createSettingsRepository(this.pool()).set("obsidian.wiki.scope", scope);
    return scope;
  }
  private vaultBinding(settings: StorageSettings) {
    return projectionHash(JSON.stringify([settings.obsidianVaultPath, settings.managedRoot]));
  }
  private async binding(settings: StorageSettings) {
    return projectionHash(
      JSON.stringify([settings.obsidianVaultPath, settings.managedRoot, await this.scope()])
    );
  }
  async sourceAdmission(settings: StorageSettings, admittedBinding?: string) {
    const binding = admittedBinding ?? (await this.binding(settings));
    await this.assertBinding(settings, binding);
    return binding;
  }
  async assertSourceExport(
    settings: StorageSettings,
    binding: string,
    sourceId: string,
    noteIds: string[] = []
  ) {
    await this.assertBinding(settings, binding);
    const scope = await this.scope();
    if (
      !(await createObsidianWikiRepository(this.pool()).exportEligible(
        sourceId,
        noteIds,
        scope.sourceIds,
        scope.includeDescendants
      ))
    )
      throw new Error("obsidianWiki.errors.binding");
    await this.assertBinding(settings, binding);
  }
  async enqueue(force = false) {
    const settings = await this.options.getStorageSettings();
    if (!active(settings)) return null;
    return createObsidianWikiRepository(this.pool()).enqueue(await this.binding(settings), force);
  }
  async status() {
    const settings = await this.options.getStorageSettings(),
      repository = createObsidianWikiRepository(this.pool());
    const job = await createJobRepository(this.pool()).latestByType("obsidian-wiki");
    return {
      active: active(settings),
      job: job ? { status: job.status, error: job.error } : null,
      delivery: job ? deliveryProgress(job) : null,
      scope: await this.scope(),
      conflicts: await repository.conflicts(this.vaultBinding(settings)),
      retired: await this.retirement().report()
    };
  }
  /** "Move to recovery" for a retired wiki file that was kept in the vault because it holds edits. */
  async moveRetiredToRecovery(id: string) {
    const settings = await this.options.getStorageSettings();
    if (!settings.obsidianVaultPath) throw new Error("obsidianWiki.errors.binding");
    const binding = await this.binding(settings);
    await this.retirement().moveToRecovery(
      {
        vaultPath: settings.obsidianVaultPath,
        managedRoot: settings.managedRoot,
        binding: this.vaultBinding(settings),
        assertBinding: () => this.assertBinding(settings, binding)
      },
      id
    );
    return this.status();
  }
  async diff(id: string) {
    const row = await createObsidianWikiRepository(this.pool()).getDelivery(id),
      settings = await this.options.getStorageSettings();
    if (!row || row.binding_hash !== this.vaultBinding(settings))
      throw new Error("obsidianWiki.errors.binding");
    const path = await safeVaultPath(settings.obsidianVaultPath!, row.relative_path);
    const local = await readOptional(path);
    return {
      id,
      relativePath: row.relative_path,
      base: row.before_content ?? "",
      local: local ?? "",
      proposed: row.content,
      localHash: local === null ? null : projectionHash(local)
    };
  }
  async recover(id: string, expectedHash: string | null) {
    const repository = createObsidianWikiRepository(this.pool()),
      row = await repository.getDelivery(id);
    if (!row) throw new Error("obsidianWiki.errors.binding");
    const latest = await repository.latest(row.memora_id, row.binding_hash);
    if (latest?.id !== row.id) throw new Error("obsidianWiki.errors.conflict");
    const settings = await this.options.getStorageSettings();
    if (row.binding_hash !== this.vaultBinding(settings))
      throw new Error("obsidianWiki.errors.binding");
    await this.assertBinding(settings, await this.binding(settings));
    const scope = await this.scope(),
      eligible = await repository.sources(scope.sourceIds, scope.includeDescendants),
      frame = parseObsidianMarkdown(row.content)?.frontmatter;
    if (frame?.memoraType === "source_item" && !frame.memoraLayout) {
      if (!eligible.some((s) => s.id === row.memora_id) || !frame.memoraDocumentId)
        throw new Error("obsidianWiki.errors.binding");
      const document = await createDocumentRepository(this.pool()).findById(frame.memoraDocumentId);
      if (
        !document ||
        projectionHash(normalizeProjectionText(document.canonicalMarkdown)) !== row.editable_hash
      )
        throw new Error("obsidianWiki.errors.conflict");
    } else {
      const plan = await this.deliveryPlan(settings, await this.layout(), null),
        planned = plan.targets.find((t) => t.id === row.memora_id),
        current = planned ? (await plan.render([planned]))[0]?.target : undefined;
      if (
        !current ||
        current.revision !== row.revision_id ||
        projectionHash(current.editorial) !== row.editable_hash ||
        projectionHash(current.generated) !== row.generated_hash
      )
        throw new Error("obsidianWiki.errors.conflict");
    }
    const local = await readOptional(
      await safeVaultPath(settings.obsidianVaultPath!, row.relative_path)
    );
    if ((local === null ? null : projectionHash(local)) !== expectedHash)
      throw new Error("obsidianWiki.errors.conflict");
    // Explicit user recovery preserves the local file in the managed recovery directory and history.
    const replacement = await repository.prepare({
      ...row,
      before_content: local,
      base_hash: expectedHash
    });
    await this.deliver(replacement, settings, await this.binding(settings));
    return this.status();
  }
  /**
   * Delivers one page of a pass and returns the checkpoint of the next one (`continueWith`), with
   * which the light lane queues this job again. The first page copies the attachments and retires
   * the files the plan no longer produces, before anything is written.
   */
  async execute(job: JobRecord, signal?: AbortSignal) {
    const started = performance.now();
    const payload = pagePayloadSchema.parse(jobTaskPayload(job.payload));
    const settings = await this.options.getStorageSettings();
    await this.assertBinding(settings, payload.binding);
    let layout = await this.layout();
    if (
      !layout &&
      !(await createSettingsRepository(this.pool()).get("obsidian.layout")) &&
      !(await createObsidianSyncRepository(this.pool()).list(1)).length
    ) {
      layout = obsidianLayoutConfigSchema.parse({
        version: 2,
        language: (await this.options.getLocale?.()) ?? "en",
        attachments: "omit"
      });
      await createSettingsRepository(this.pool()).set("obsidian.layout", layout);
    }
    const cursor = payload.cursor ?? null;
    const plan = await this.deliveryPlan(settings, layout, {
      generation: payload.generation,
      first: !cursor
    });
    const config = this.delivery();
    let retired: RetireSummary | undefined;
    if (!cursor) {
      if (layout)
        await projectMirrorAssets(
          this.pool(),
          settings,
          await this.assets(layout),
          (await this.options.assetRoots?.()) ?? {},
          () => this.assertBinding(settings, payload.binding)
        );
      // Files the plan no longer produces leave the projection before anything is written.
      retired = await this.retirement().retire(
        {
          vaultPath: settings.obsidianVaultPath!,
          managedRoot: settings.managedRoot,
          binding: this.vaultBinding(settings),
          assertBinding: () => this.assertBinding(settings, payload.binding),
          signal
        },
        new Set(plan.targets.map((t) => t.id))
      );
    }
    const pass: Pass = payload.pass ?? {
      startedAt: new Date().toISOString(),
      total: plan.targets.length,
      delivered: 0,
      projected: 0,
      conflicts: 0,
      failed: 0
    };
    pass.total = plan.targets.length;
    let index = cursor ? firstAfter(plan.targets, cursor) : 0;
    let delivered = 0,
      bytes = 0,
      projected = 0,
      conflicts = 0;
    const failures: Array<{ relativePath: string; error: string }> = [];
    let failed = 0;
    const fail = async (planned: PlannedTarget, error: string) => {
      failed += 1;
      if (failures.length < config.reportedFailures)
        failures.push({ relativePath: planned.path, error });
      await this.recordFailure(planned, settings, error);
    };
    page: while (index < plan.targets.length) {
      const batch = plan.targets.slice(
        index,
        index + Math.min(config.renderBatch, config.pageTargets - delivered)
      );
      const rendered: RenderedTarget[] = await plan.render(
        batch.filter((planned) => !plan.sourceUnits.has(planned.id))
      );
      const byId = new Map(rendered.map((entry) => [entry.planned.id, entry]));
      // A paused sync or a changed vault stops the page here; every write checks again just
      // before it happens (`deliver`).
      await this.assertBinding(settings, payload.binding);
      for (const planned of batch) {
        if (signal?.aborted) throw new Error("obsidianWiki.errors.paused");
        if (plan.sourceUnits.has(planned.id)) {
          try {
            projected += (
              await this.options.projectSource(planned.id, plan.allowedNotes, payload.binding)
            ).projected;
          } catch (error) {
            if (String(error).includes("conflict")) conflicts++;
            else throw error;
          }
        } else {
          const entry = byId.get(planned.id)!;
          if (entry.error) await fail(planned, entry.error);
          else if (entry.target) {
            const target = entry.target!;
            bytes += Buffer.byteLength(target.editorial) + Buffer.byteLength(target.generated);
            try {
              projected += await this.project(target, settings, payload.binding);
            } catch (error) {
              if (String(error).includes("errors.limit"))
                await fail(planned, "obsidianWiki.errors.limit");
              else if (/conflict|format|write/.test(String(error))) conflicts++;
              else throw error;
            }
          }
        }
        index += 1;
        delivered += 1;
        if (
          delivered >= config.pageTargets ||
          bytes >= config.pageBytes ||
          performance.now() - started >= config.pageMs
        )
          break page;
      }
    }
    const done = index >= plan.targets.length;
    const next: Pass = {
      ...pass,
      delivered: pass.delivered + delivered,
      projected: pass.projected + projected,
      conflicts: pass.conflicts + conflicts,
      failed: pass.failed + failed
    };
    const page = payload.page ?? 0;
    // The job re-enqueues itself with the checkpoint of the next page (the light lane's
    // continuation): a crash re-runs the page that was running, from its own cursor.
    return {
      ...(done
        ? {}
        : {
            continueWith: {
              binding: payload.binding,
              generation: payload.generation,
              cursor: plan.targets[index - 1]!.key,
              page: page + 1,
              pass: next
            }
          }),
      projected,
      conflicts,
      failed,
      failures,
      targets: plan.targets.length,
      page,
      delivered: next.delivered,
      done,
      pass: next,
      ms: Math.round(performance.now() - started),
      ...(retired ? { retired } : {})
    };
  }
  /** A file that failed alone, by name: listed with the projection's conflicts until it delivers. */
  private async recordFailure(planned: PlannedTarget, settings: StorageSettings, error: string) {
    const repository = createObsidianWikiRepository(this.pool());
    const row = await repository.prepare({
      memora_id: planned.id,
      revision_id: "failed",
      binding_hash: this.vaultBinding(settings),
      relative_path: planned.path,
      content: "",
      editable_hash: projectionHash(""),
      generated_hash: projectionHash(""),
      rendered_hash: projectionHash(""),
      base_hash: null,
      before_content: null
    });
    await repository.finish(row.id, "error", error);
  }
  /**
   * The plan of a pass: made when the pass starts and kept for its pages (same pass generation,
   * binding, layout and locale), so a pass plans the library once even while ingestion moves the
   * clock. Each page still renders fresh rows, skips what was deleted meanwhile and revalidates
   * before every write; what was added meanwhile goes to the next pass, which the moved clock
   * admits. Without a pass generation (recovery) the plan is always made afresh.
   */
  private async deliveryPlan(
    settings: StorageSettings,
    layout: ObsidianLayoutConfig | null,
    pass: { generation: string; first: boolean } | null
  ): Promise<DeliveryPlan> {
    const locale = (await this.options.getLocale?.()) ?? "en";
    const key = JSON.stringify([await this.binding(settings), pass?.generation, layout, locale]);
    if (pass && !pass.first && this.planCache?.key === key) return this.planCache.plan;
    const scope = await this.scope();
    let plan: DeliveryPlan;
    if (layout) {
      const mirror = await planObsidianMirror(this.pool(), settings.managedRoot, scope, layout, {
        assets: await this.assets(layout)
      });
      plan = { ...mirror, sourceUnits: new Set(), allowedNotes: new Set() };
    } else plan = await this.planLegacy(settings, scope, locale);
    this.planCache = { key, plan };
    return plan;
  }
  /**
   * The first-generation plan (no layout setting): sources with a document go through
   * `projectSource`; source references, knowledge notes, topic maps, source relations and the three
   * indexes are planned and rendered here, under the English folders that layout used.
   */
  private async planLegacy(
    settings: StorageSettings,
    scope: ObsidianWikiScope,
    locale: string
  ): Promise<DeliveryPlan> {
    const pool = this.pool(),
      repo = createObsidianWikiRepository(pool),
      sync = createObsidianSyncRepository(pool);
    const t = (key: MessageKey) => translate(locale, key);
    const relationStatus = (status: string) => t(("sourceRelations." + status) as MessageKey);
    const sources = await repo.sources(scope.sourceIds, scope.includeDescendants);
    const ids = sources.map((s) => String(s.id));
    const notes = await repo.noteRefs(ids, !scope.sourceIds.length);
    const allowedNotes = new Set(notes.map((n) => String(n.id)));
    const bibliography = (source: Record<string, any>) =>
      [source.metadata, ...(source.bibliography ?? [])]
        .flatMap((item) => {
          const creators = Array.isArray(item.creators)
            ? item.creators
                .map((c: any) =>
                  typeof c === "string"
                    ? c
                    : (c.name ??
                      c.displayName ??
                      [c.givenName, c.familyName].filter(Boolean).join(" "))
                )
                .filter(Boolean)
                .join(", ")
            : "";
          return [
            creators,
            ...["publicationDate", "publisher", "edition", "doi", "isbn", "issn"]
              .filter((key) => item[key])
              .map(
                (key) =>
                  `${key === "isbn" || key === "issn" ? key.toUpperCase() : t(("import.metadataFields." + key) as MessageKey)}: ${safeWikiLabel(String(item[key]))}`
              ),
            ...Object.entries(item.identifiers ?? {}).map(
              ([key, value]) => `${safeWikiLabel(key)}: ${safeWikiLabel(String(value))}`
            )
          ].filter(Boolean);
        })
        .join("\n\n");
    const allowed = new Set(ids);
    const relations = await repo.relationRefs([...allowed]);
    const registry = new Map((await sync.listAll()).map((file) => [file.memoraId, file]));
    const paths = new Map<string, string>(),
      used = new Set<string>(),
      missing = new Set<string>();
    const targets: Target[] = [];
    const reserve = async (
      id: string,
      type: Target["type"],
      directory: string,
      base: string,
      sourceId?: string
    ) => {
      const old = registry.get(id);
      if (old?.metadata.editorialTombstone || old?.status === "deleted") missing.add(id);
      let path = old?.relativePath;
      if (path && !path.startsWith(`${settings.managedRoot}/`))
        throw new Error("obsidianWiki.errors.binding");
      if (!path) {
        for (let attempt = 0; attempt <= 100; attempt++) {
          const candidate = posix.join(directory, collisionFileName(base, new Date(), attempt, id));
          if (Buffer.byteLength(candidate) > 900) throw new Error("obsidianWiki.errors.limit");
          if (
            !used.has(candidate) &&
            !(await sync.findByRelativePath(candidate)) &&
            (await readOptional(await safeVaultPath(settings.obsidianVaultPath!, candidate))) ===
              null
          ) {
            path = candidate;
            break;
          }
        }
      }
      if (!path) throw new Error("obsidianWiki.errors.limit");
      paths.set(id, path);
      used.add(path);
      if (!old) {
        const row = await sync.create({
          memoraId: id,
          entityId: id,
          entityType: type,
          memoraType: type,
          ...(sourceId ? { sourceItemId: sourceId } : {}),
          relativePath: path,
          frontmatterHash: projectionHash(""),
          contentHash: projectionHash(""),
          mtimeMs: 0,
          status: "pending",
          metadata: { projectionFormat: 1, bindingHash: this.vaultBinding(settings) }
        });
        registry.set(id, row);
      }
      return path;
    };
    for (const source of sources) {
      const old = registry.get(source.id);
      if (old?.metadata.editorialTombstone || old?.status === "deleted") missing.add(source.id);
      if (old) paths.set(source.id, old.relativePath);
      if (source.catalogOnly)
        await reserve(
          source.id,
          "source_reference",
          posix.join(settings.managedRoot, "Sources", "References"),
          `${slugify(source.title)}.md`,
          source.id
        );
    }
    for (const note of notes) {
      const file = registry.get(note.id);
      if (file?.metadata.editorialTombstone || file?.status === "deleted") missing.add(note.id);
      if (file) paths.set(note.id, file.relativePath);
      else if (note.ownership === "knowledge")
        await reserve(
          note.id,
          "atomic_note",
          posix.join(settings.managedRoot, "Atomic notes"),
          `${slugify(note.title)}.md`
        );
    }
    // Topic maps: planned synchronously against the registry, then registered like the rest.
    const sourceById = new Map(sources.map((s) => [String(s.id), s]));
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const wanted = new Map<string, string>();
    const topics = planTopicProjection(await repo.topicProjection(), {
      folder: posix.join(settings.managedRoot, "Topics"),
      rootFile: "Topics",
      language: locale,
      wholeLibrary: !scope.sourceIds.length,
      projected: (kind, id) => (kind === "note" ? noteById.has(id) : sourceById.has(id)),
      registered: (id) => registry.has(id),
      reserve: (id, path) => {
        const registered = registry.get(id)?.relativePath;
        const final = registered ?? path;
        wanted.set(id, final);
        return final;
      }
    });
    for (const entry of topics?.planned ?? [])
      await reserve(
        entry.topic.id,
        "topic",
        posix.dirname(wanted.get(entry.topic.id)!),
        posix.basename(wanted.get(entry.topic.id)!)
      );
    await reserve(INDEX, "wiki_index", posix.join(settings.managedRoot, "Wiki"), "index.md");
    await reserve(
      CATALOG,
      "wiki_index",
      posix.join(settings.managedRoot, "Wiki", "Sources"),
      "index.md"
    );
    await reserve(
      RELATIONS,
      "wiki_index",
      posix.join(settings.managedRoot, "Wiki", "Connections"),
      "index.md"
    );
    for (const r of relations)
      await reserve(
        r.id,
        "source_relation",
        posix.join(settings.managedRoot, "Wiki", "Connections"),
        `${slugify(r.sourceTitle)}--${slugify(r.targetTitle)}.md`
      );
    const link = (id: string, title: string, kind = "source") => {
      if (!missing.has(id)) return wikiLink(paths.get(id), title, id, kind);
      const note = noteById.get(id),
        relation = relations.find((r) => r.id === id);
      return (
        (relation
          ? `[${safeWikiLabel(title)}](memora://open/source/${relation.source_item_id}?relation=${id})`
          : wikiLink(undefined, title, note?.sourceId ?? id, note ? "source" : kind)) +
        " · " +
        t("obsidianEditing.deleted")
      );
    };
    const evidenceSourceLink = (id: string, title: string) =>
      allowed.has(id)
        ? link(id, title)
        : safeWikiLabel(title) + " · " + t("obsidianWiki.unavailable");
    const list = (items: Record<string, any>[], kind = "wiki") =>
      items.map((p) => `- ${link(p.id, p.title, kind)}`).join("\n");
    const add = (
      id: string,
      type: Target["type"],
      revision: string,
      title: string,
      editorial: string,
      generated: string,
      extra: Partial<Target> = {}
    ) => {
      targets.push({
        id,
        type,
        revision,
        title,
        path: paths.get(id)!,
        editorial,
        generated,
        ...extra
      });
    };
    const quote = (text: string) =>
      text
        .split("\n")
        .map((line) => `> ${line.replace(/<!--\s*memora:/g, "&lt;!-- memora:")}`)
        .join("\n");
    for (const source of sources.filter((s) => s.catalogOnly)) {
      const children = sources.filter((s) => s.parentId === source.id);
      add(
        source.id,
        "source_reference",
        projectionHash(JSON.stringify(source)),
        source.title,
        `# ${safeWikiLabel(source.title)}\n\n`,
        `${t("obsidianWiki.catalogOnly")}\n\n${t(("import.sourceTypes." + source.type) as MessageKey)}\n\n${bibliography(source)}\n\n${safeWikiLabel(source.subtitle ?? "")}\n\n${safeWikiLabel(source.sourceUri ?? "")}\n\n${list(children, "source")}\n\n${link(CATALOG, t("obsidianWiki.catalog"), "wiki")}`,
        { sourceId: source.id }
      );
    }
    const knowledge = notes.filter((n) => n.ownership === "knowledge");
    const details = new Map(
      (await repo.noteDetails(knowledge.map((n) => n.id))).map((row) => [String(row.id), row])
    );
    for (const ref of knowledge) {
      const note = details.get(ref.id);
      if (!note) continue;
      const originals = await repo.noteEvidence(note.id, note.evidenceChunkId);
      add(
        note.id,
        "atomic_note",
        note.updatedAt.toISOString(),
        note.title,
        `# ${safeWikiLabel(note.title)}\n\n${note.bodyMarkdown}\n\n`,
        [
          t(note.current ? "obsidianWiki.current" : "obsidianWiki.historical"),
          ...originals.map(
            (e, i) =>
              `[${i + 1}] ${evidenceSourceLink(e.sourceId, e.sourceTitle)} · ${e.documentId} · ${t(e.current ? "obsidianWiki.current" : "obsidianWiki.historical")}\n\n${quote(e.content)}`
          ),
          ...(note.successorIds ?? []).map((id: string) =>
            link(id, noteById.get(id)?.title ?? id, "note")
          )
        ].join("\n\n")
      );
    }
    for (const entry of topics?.planned ?? []) {
      const moc = renderTopicMoc(topics!, entry, {
        language: locale,
        link: (id, title, kind) => link(id, title, kind),
        pathOf: (id) => paths.get(id),
        titleOf: (kind, id) =>
          (kind === "note" ? noteById.get(id)?.title : sourceById.get(id)?.title) ?? id,
        home: { id: INDEX, title: t("wiki.title") }
      });
      add(entry.topic.id, "topic", moc.revision, moc.title, moc.editorial, moc.generated, {
        aliases: moc.aliases
      });
    }
    for (const r of relations) {
      // Relations decided without prose have none stored: their explanation is written on open.
      const replace = (text: string | null) =>
        (text ?? "")
          .replace(
            /<source-ref\b[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/source-ref>)?/g,
            (_m, id: string) =>
              id === r.source_item_id
                ? link(id, r.sourceTitle)
                : id === r.target_source_item_id
                  ? link(id, r.targetTitle)
                  : t("obsidianWiki.unavailable")
          )
          .replace(/<\/?source-ref[^>]*>/g, t("obsidianWiki.unavailable"));
      const evidence = (await repo.relationEvidence(r.id))
        .map(
          (e: Record<string, any>) =>
            `### ${e.id} · ${e.origin === "atomic_notes" ? t("sourceRelations.atomicNotes") : t("sourceRelations.sourceAnalysis")} · ${e.current ? t("obsidianWiki.current") : t("obsidianWiki.historical")}\n\n${link(r.source_item_id, r.sourceTitle)} · ${e.sourceDocumentId ?? e.snapshot.sourceId} · ${safeWikiLabel(e.sourceLocator ?? "")}\n\n${quote(e.snapshot.sourceExcerpt ?? "")}\n\n${link(r.target_source_item_id, r.targetTitle)} · ${e.targetDocumentId ?? e.snapshot.targetId} · ${safeWikiLabel(e.targetLocator ?? "")}\n\n${quote(e.snapshot.targetExcerpt ?? "")}`
        )
        .join("\n\n");
      add(
        r.id,
        "source_relation",
        projectionHash(JSON.stringify([r, evidence])),
        `${r.sourceTitle} → ${r.targetTitle}`,
        `# ${safeWikiLabel(r.sourceTitle)} → ${safeWikiLabel(r.targetTitle)}\n\n`,
        `${t("obsidianWiki.readOnly")}\n\n${r.id} · ${t(("knowledge.relations.types." + r.relation_type) as MessageKey)} · ${relationStatus(r.status)} · ${r.current ? t("obsidianWiki.current") : t("obsidianWiki.historical")}\n\n${link(r.source_item_id, r.sourceTitle)} → ${link(r.target_source_item_id, r.targetTitle)}\n\n${replace(r.source_idea)}\n\n${replace(r.target_idea)}\n\n${replace(r.explanation)}\n\n${evidence}\n\n[${t("obsidianWiki.openApp")}](memora://open/source/${r.source_item_id}?relation=${r.id})`
      );
    }
    const topicRoot = topics?.planned[0];
    const areas = topics
      ? (topics.children.get(topics.rows.rootId) ?? [])
          .map((topic) => topics.byId.get(topic.id))
          .filter((entry) => entry !== undefined)
          .map((entry) => ({ id: entry.topic.id, title: entry.title }))
      : [];
    const indexGenerated = [
      topicRoot ? link(topicRoot.topic.id, topicRoot.title, "wiki") : "",
      list(areas),
      link(CATALOG, t("obsidianWiki.catalog"), "wiki"),
      link(RELATIONS, t("obsidianWiki.connections"), "wiki")
    ]
      .filter(Boolean)
      .join("\n\n");
    add(
      INDEX,
      "wiki_index",
      projectionHash(indexGenerated),
      t("wiki.title"),
      `# ${t("wiki.title")}\n\n`,
      indexGenerated
    );
    add(
      CATALOG,
      "wiki_index",
      projectionHash(JSON.stringify(sources)),
      t("obsidianWiki.catalog"),
      `# ${t("obsidianWiki.catalog")}\n\n`,
      sources
        .map(
          (s) =>
            `- ${link(s.id, s.title)}${s.parentId && allowed.has(s.parentId) ? " ← " + link(s.parentId, sourceById.get(String(s.parentId))!.title) : ""}${s.catalogOnly ? " · " + t("obsidianWiki.catalogOnly") : ""}`
        )
        .join("\n")
    );
    add(
      RELATIONS,
      "wiki_index",
      projectionHash(JSON.stringify(relations)),
      t("obsidianWiki.connections"),
      `# ${t("obsidianWiki.connections")}\n\n`,
      list(
        relations.map((r) => ({
          id: r.id,
          title: `${r.sourceTitle} → ${r.targetTitle} · ${relationStatus(r.status)}`
        }))
      )
    );
    const rendered = new Map(targets.map((target) => [target.id, target]));
    const sourceUnits = new Set(sources.filter((s) => !s.catalogOnly).map((s) => String(s.id)));
    const planned: PlannedTarget[] = [
      ...[...sourceUnits].map((id) => ({
        key: targetKey("source_item", id),
        id,
        type: "source_item" as const,
        path: paths.get(id) ?? ""
      })),
      ...targets.map((target) => ({
        key: targetKey(target.type, target.id),
        id: target.id,
        type: target.type,
        path: target.path
      }))
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      targets: planned,
      sourceUnits,
      allowedNotes,
      // Rendered when the pass was planned; a topic retired meanwhile is skipped.
      render: async (batch) => {
        const live = new Set(
          await repo.liveTopicIds(batch.filter((e) => e.type === "topic").map((e) => e.id))
        );
        return batch.map((entry) =>
          entry.type === "topic" && !live.has(entry.id)
            ? { planned: entry }
            : { planned: entry, target: rendered.get(entry.id)! }
        );
      }
    };
  }
  private async assertBinding(settings: StorageSettings, binding: string) {
    if (await createObsidianLayoutRepository(this.pool()).active(this.vaultBinding(settings)))
      throw new Error("obsidianWiki.errors.paused");
    const current = await this.options.getStorageSettings();
    if (!active(current)) throw new Error("obsidianWiki.errors.paused");
    if (
      settings.obsidianVaultPath !== current.obsidianVaultPath ||
      settings.managedRoot !== current.managedRoot ||
      (await this.binding(current)) !== binding
    )
      throw new Error("obsidianWiki.errors.binding");
  }
  async projectDocument(
    id: string,
    documentId: string,
    title: string,
    markdown: string,
    admittedBinding: string
  ) {
    const settings = await this.options.getStorageSettings(),
      file = await createObsidianSyncRepository(this.pool()).findByMemoraId(id);
    if (!file) throw new Error("obsidianWiki.errors.binding");
    const body = normalizeProjectionText(markdown);
    return this.project(
      {
        id,
        type: "source_item",
        sourceId: id,
        documentId,
        title,
        revision: projectionHash(body),
        path: file.relativePath,
        editorial: body,
        generated: ""
      },
      settings,
      admittedBinding
    );
  }
  async acknowledgeDocument(id: string) {
    const settings = await this.options.getStorageSettings(),
      sync = createObsidianSyncRepository(this.pool()),
      file = await sync.findByMemoraId(id);
    if (!file || file.metadata.projectionFormat !== 1) return;
    const raw = await readOptional(
        await safeVaultPath(settings.obsidianVaultPath!, file.relativePath)
      ),
      parsed = raw ? parseObsidianMarkdown(raw) : null;
    if (
      !raw ||
      !parsed ||
      parsed.frontmatter.memoraType !== "source_item" ||
      parsed.frontmatter.memoraId !== id ||
      projectionHash(normalizeProjectionText(parsed.bodyMarkdown)) !== file.contentHash
    )
      throw new Error("obsidianWiki.errors.conflict");
    const repo = createObsidianWikiRepository(this.pool()),
      base = await repo.base(id, this.vaultBinding(settings));
    const row = await repo.prepare({
      memora_id: id,
      revision_id: file.contentHash,
      binding_hash: this.vaultBinding(settings),
      relative_path: file.relativePath,
      content: raw,
      editable_hash: file.contentHash,
      generated_hash: projectionHash(""),
      rendered_hash: projectionHash(raw),
      base_hash: base?.rendered_hash ?? null,
      before_content: base?.content ?? null
    });
    await this.receipt(row, settings);
  }
  private async project(
    target: Target,
    settings: StorageSettings,
    jobBinding: string
  ): Promise<number> {
    const binding = this.vaultBinding(settings);
    const repo = createObsidianWikiRepository(this.pool()),
      sync = createObsidianSyncRepository(this.pool());
    let latest = await repo.latest(target.id, binding);
    if (!(await sync.findByMemoraId(target.id)))
      await sync.create({
        memoraId: target.id,
        entityId: target.id,
        entityType: target.type,
        memoraType: target.type,
        ...(target.sourceId ? { sourceItemId: target.sourceId } : {}),
        ...(target.documentId ? { documentId: target.documentId } : {}),
        relativePath: target.path,
        contentHash: projectionHash(""),
        frontmatterHash: projectionHash(""),
        mtimeMs: 0,
        status: "pending",
        metadata: { projectionFormat: target.layout ? 2 : 1, bindingHash: binding }
      });
    let file = await sync.findByMemoraId(target.id);
    if (
      file?.metadata.editorialPending ||
      file?.metadata.editorialTombstone ||
      (target.layout && file?.metadata.layoutExcluded)
    )
      return 0;
    // A retired file produced again (a topic restored by an undo) starts afresh at its path: its
    // archived bytes stay in recovery, and a file still in place is a conflict, never overwritten.
    const reviving = file?.status === "retired";
    const path = await safeVaultPath(settings.obsidianVaultPath!, target.path),
      local = await readOptional(path);
    const localHash = local === null ? null : projectionHash(local);
    if (!reviving && latest && latest.status !== "written" && localHash === latest.rendered_hash) {
      await this.receipt(latest, settings);
      file = await sync.findByMemoraId(target.id);
      latest = await repo.latest(target.id, binding);
    }
    const actualBase = reviving ? null : await repo.base(target.id, binding);
    const parsed = local === null ? null : parseObsidianMarkdown(local);
    const adoptLegacy =
      target.type === "source_reference" &&
      !actualBase &&
      parsed?.frontmatter.memoraId === target.id &&
      parsed.frontmatter.memoraType === "source_item" &&
      parsed.frontmatter.memoraSyncVersion === file?.syncVersion &&
      projectionHash(normalizeProjectionText(parsed.bodyMarkdown)) === file.contentHash;
    const body =
      target.type === "source_item" && !target.layout
        ? target.editorial
        : target.editorial +
          wikiGeneratedStart +
          "\n\n" +
          target.generated +
          "\n\n" +
          wikiGeneratedEnd +
          "\n";
    const fm: ObsidianManagedFrontmatter = {
      ...(target.linkMap?.length ? { memoraLinkMap: target.linkMap } : {}),
      ...(target.rootSourceId ? { memoraRootSourceId: target.rootSourceId } : {}),
      ...(target.divisionId ? { memoraDivisionId: target.divisionId } : {}),
      ...(target.documentRevisionId ? { memoraDocumentRevisionId: target.documentRevisionId } : {}),
      memoraId: target.id,
      memoraType: target.type,
      memoraManaged: true,
      memoraSyncVersion:
        (file?.syncVersion ?? 0) + (actualBase?.revision_id === target.revision ? 0 : 1),
      memoraContentHash: projectionHash(target.editorial),
      ...(target.layout
        ? {
            memoraLayout: 2,
            memoraLayoutLanguage: target.layout.language,
            memoraWikiSchema: 2,
            memoraRevisionId: target.revision,
            ...(target.documentId ? { memoraDocumentId: target.documentId } : {})
          }
        : target.type === "source_item"
          ? { memoraDocumentId: target.documentId }
          : { memoraWikiSchema: 1, memoraRevisionId: target.revision }),
      ...(target.sourceId ? { memoraSourceId: target.sourceId } : {})
    };
    // A topic map owns its `aliases` line; any other user frontmatter is kept.
    const user =
      target.type === "topic"
        ? withTopicAliases(parsed?.userFrontmatter ?? "", target.aliases ?? [])
        : (parsed?.userFrontmatter ?? "");
    let content = serializeManagedFrontmatter(fm, user) + "\n" + body,
      renderedHash = projectionHash(content);
    if (
      actualBase &&
      renderedHash !== actualBase.rendered_hash &&
      fm.memoraSyncVersion <= (file?.syncVersion ?? 0)
    ) {
      fm.memoraSyncVersion = (file?.syncVersion ?? 0) + 1;
      content = serializeManagedFrontmatter(fm, user) + "\n" + body;
      renderedHash = projectionHash(content);
    }
    if (
      actualBase &&
      localHash === actualBase.rendered_hash &&
      renderedHash === actualBase.rendered_hash
    )
      return 0;
    // The per-file cap fails this file visibly, by name; the pass goes on.
    if (Buffer.byteLength(content) > this.delivery().fileBytes)
      throw new Error("obsidianWiki.errors.limit");
    if (
      latest &&
      ["conflict", "error"].includes(latest.status) &&
      latest.rendered_hash === renderedHash
    )
      throw new Error("obsidianWiki.errors.conflict");
    const delivery = await repo.prepare({
      memora_id: target.id,
      revision_id: target.revision,
      binding_hash: binding,
      relative_path: target.path,
      content,
      editable_hash: projectionHash(target.editorial),
      generated_hash: projectionHash(target.generated),
      rendered_hash: renderedHash,
      base_hash: actualBase?.rendered_hash ?? (adoptLegacy ? localHash : null),
      before_content: actualBase?.content ?? (adoptLegacy ? local : null)
    });
    if (target.type !== "source_item" && !parseWikiRegions(body)) {
      await repo.finish(delivery.id, "error", "obsidianWiki.errors.format");
      throw new Error("obsidianWiki.errors.format");
    }
    // Missing registered files are also pending edits. Never infer deletion or silently recreate them.
    if (
      (actualBase && localHash !== actualBase.rendered_hash) ||
      (!actualBase && local !== null && !adoptLegacy) ||
      (!reviving &&
        !actualBase &&
        file?.metadata.bindingHash &&
        file.metadata.bindingHash !== binding)
    ) {
      await repo.finish(delivery.id, "conflict", "obsidianWiki.errors.conflict");
      await sync.update(file!.id, { status: "conflict" });
      throw new Error("obsidianWiki.errors.conflict");
    }
    await this.deliver(delivery, settings, jobBinding);
    return 1;
  }
  private async deliver(row: ProjectionDelivery, settings: StorageSettings, jobBinding: string) {
    const repo = createObsidianWikiRepository(this.pool());
    return repo.withTargetLock(row.memora_id, async () => {
      try {
        await this.assertBinding(settings, jobBinding);
        const targetFrame = parseObsidianMarkdown(row.content)?.frontmatter;
        if (targetFrame?.memoraType === "source_item")
          await this.assertSourceExport(settings, jobBinding, row.memora_id);
        if (targetFrame?.memoraType === "atomic_note") {
          const scope = await this.scope();
          if (
            !(await repo.exportEligible(
              null,
              [row.memora_id],
              scope.sourceIds,
              scope.includeDescendants
            ))
          )
            throw new Error("obsidianWiki.errors.binding");
          const current = (
            await this.pool().query("select updated_at from atomic_notes where id=$1", [
              row.memora_id
            ])
          ).rows[0];
          if (!current || new Date(current.updated_at).toISOString() !== row.revision_id)
            throw new Error("obsidianWiki.errors.conflict");
        }
        // A topic map is written only while its topic is live in the active tree.
        if (targetFrame?.memoraType === "topic" && !(await repo.topicLive(row.memora_id)))
          throw new Error("obsidianWiki.errors.binding");
        const registry = createObsidianSyncRepository(this.pool()),
          registered = await registry.findByMemoraId(row.memora_id);
        if (registered)
          await registry.update(registered.id, {
            metadata: {
              ...registered.metadata,
              projectionWrite: { renderedHash: row.rendered_hash, deliveryId: row.id }
            }
          });
        await this.assertBinding(settings, jobBinding);
        await this.options.write({
          vaultPath: settings.obsidianVaultPath!,
          relativePath: row.relative_path,
          content: row.content,
          expectedHash: row.base_hash,
          recoveryId: row.id,
          managedRoot: settings.managedRoot
        });
        await this.receipt(row, settings);
      } catch (error) {
        const reason = String(error).includes("conflict")
          ? "obsidianWiki.errors.conflict"
          : "obsidianWiki.errors.write";
        await repo.finish(row.id, reason.endsWith("conflict") ? "conflict" : "error", reason);
        const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(row.memora_id);
        if (file)
          await createObsidianSyncRepository(this.pool()).update(file.id, { status: "conflict" });
        throw error;
      }
    });
  }
  private async receipt(row: ProjectionDelivery, settings: StorageSettings) {
    const parsed = parseObsidianMarkdown(row.content);
    if (
      !parsed ||
      (parsed.frontmatter.memoraType !== "source_item" && !parseWikiRegions(parsed.bodyMarkdown))
    )
      throw new Error("obsidianWiki.errors.format");
    const sync = createObsidianSyncRepository(this.pool()),
      file = await sync.findByMemoraId(row.memora_id);
    if (!file) throw new Error("obsidianWiki.errors.binding");
    // A delivered file is live again: no write in flight and, for a revived file, no retirement.
    const metadata = { ...file.metadata };
    delete metadata.projectionWrite;
    delete metadata.retired;
    await sync.update(file.id, {
      contentHash:
        parsed.frontmatter.memoraType === "source_item" && !parsed.frontmatter.memoraLayout
          ? projectionHash(normalizeProjectionText(parsed.bodyMarkdown))
          : parsed.frontmatter.memoraContentHash,
      frontmatterHash: projectionHash(serializeManagedFrontmatter(parsed.frontmatter)),
      syncVersion: parsed.frontmatter.memoraSyncVersion,
      mtimeMs: Math.trunc(
        (await stat(await safeVaultPath(settings.obsidianVaultPath!, row.relative_path))).mtimeMs
      ),
      memoraType: parsed.frontmatter.memoraType,
      ...(parsed.frontmatter.memoraType === "source_reference"
        ? { documentId: null }
        : parsed.frontmatter.memoraDocumentId
          ? { documentId: parsed.frontmatter.memoraDocumentId }
          : {}),
      status: "synced",
      metadata: {
        ...metadata,
        bindingHash: row.binding_hash,
        projectionFormat: parsed.frontmatter.memoraLayout ?? 1,
        ...(metadata.editorialBase
          ? {
              editorialBase: {
                content: row.content,
                revision:
                  parsed.frontmatter.memoraType === "source_item"
                    ? (await createSourceItemRepository(this.pool()).findById(
                        row.memora_id
                      ))!.updatedAt.toISOString()
                    : row.revision_id,
                version: parsed.frontmatter.memoraSyncVersion,
                hash: row.rendered_hash
              },
              editorialBinding: row.binding_hash
            }
          : {})
      },
      lastSyncedAt: new Date()
    });
    await createObsidianWikiRepository(this.pool()).finish(row.id, "written");
  }
}
/** The first planned target after a cursor (targets are sorted by key). */
function firstAfter(targets: readonly PlannedTarget[], cursor: string) {
  let low = 0,
    high = targets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (targets[middle]!.key <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** Where the current pass stands, from the latest projection job (a page waiting or done). */
function deliveryProgress(job: JobRecord) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const pass = passSchema.safeParse(result.pass ?? payload.pass);
  const running = job.status === "queued" || job.status === "running";
  return {
    state: running
      ? ("running" as const)
      : job.status === "succeeded"
        ? ("done" as const)
        : ("stopped" as const),
    total: pass.success ? pass.data.total : 0,
    delivered: pass.success ? pass.data.delivered : 0,
    failed: pass.success ? pass.data.failed : 0
  };
}
async function readOptional(path: string): Promise<string | null> {
  try {
    const file = await stat(path);
    if (file.size > obsidianDeliveryConfig.fileBytes) throw new Error("obsidianWiki.errors.limit");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
