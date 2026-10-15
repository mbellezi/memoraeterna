import {
  createKnowledgeAutomationRepository,
  createLegacyStateRepository,
  createSettingsRepository,
  createWikiCuratorRepository,
  hasLegacyContent
} from "@app/db";
import {
  AutomationDashboardSchema,
  SourceJourneySchema,
  KnowledgeAssetsSchema,
  AutomationDeliveriesSchema,
  CuratorPreviewSchema,
  knowledgeAutomationPolicyKey,
  initialCuratorLimits
} from "@app/domain";
import { WikiCurator } from "./wiki-curator.js";
import { translate } from "@app/i18n";

type Options = ConstructorParameters<typeof WikiCurator>[0];
export class KnowledgeAutomation {
  constructor(private readonly options: Options) {}
  private pool() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("wiki.errors.unavailable");
    return pool;
  }
  /**
   * Installs the legacy wiki areas and the curator policy, but only on a library that already holds
   * legacy content (F2 D3). An empty library, or one a reset has just emptied, stays empty: nothing
   * is created from nothing, so the topic tree is its only organization. Returns the policy ID, or
   * `null` when nothing was installed.
   */
  async initialize(): Promise<string | null> {
    const pool = this.pool();
    if (!hasLegacyContent(await createLegacyStateRepository(pool).legacyContentCounts()))
      return null;
    const settings = createSettingsRepository(pool),
      repo = createKnowledgeAutomationRepository(pool);
    const language = await this.options.contentLanguage();
    await repo.initializeAreas({
      themes: translate(language, "automation.areas.themes"),
      entities: translate(language, "automation.areas.entities"),
      syntheses: translate(language, "automation.areas.syntheses"),
      investigations: translate(language, "automation.areas.investigations"),
      maps: translate(language, "automation.areas.maps"),
      people: translate(language, "automation.areas.people"),
      organizations: translate(language, "automation.areas.organizations"),
      places: translate(language, "automation.areas.places"),
      works: translate(language, "automation.areas.works")
    });
    let policyId = (await settings.get<{ policyId: string }>(knowledgeAutomationPolicyKey))
      ?.policyId;
    if (policyId && (await createWikiCuratorRepository(pool).policy(policyId))) return policyId;
    const existing = (await createWikiCuratorRepository(pool).policies()).find(
      (p) => p.state === "enabled"
    );
    const curator = new WikiCurator(this.options);
    const preview = CuratorPreviewSchema.parse(
      await curator.command({
        command: "preview",
        input: {
          ...(existing ? { policyId: existing.id } : {}),
          wholeLibrary: true,
          sourceIds: [],
          includeDescendants: true,
          excludedSourceIds: existing?.scope.excludedSourceIds ?? [],
          profileOverrideId: existing?.profileOverrideId ?? null,
          limits: existing?.limits ?? initialCuratorLimits,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          interpretMemory: existing?.operations.includes("interpret_memory") ?? false,
          evolveNotes: existing?.operations.includes("evolve_notes") ?? false
        }
      })
    );
    await curator.command({
      command: "activate",
      policyId: preview.policy.id,
      revisionId: preview.policy.revisionId,
      previewHash: preview.previewHash
    });
    policyId = preview.policy.id;
    await repo.requestInitialCoverage(policyId);
    await settings.set(knowledgeAutomationPolicyKey, { policyId });
    return policyId;
  }
  async dashboard(offset: number, filter: "all" | "attention") {
    const pool = this.pool(),
      policyId = (
        await createSettingsRepository(pool).get<{ policyId: string }>(knowledgeAutomationPolicyKey)
      )?.policyId;
    if (!policyId) throw new Error("wiki.errors.unavailable");
    const policy = await createWikiCuratorRepository(pool).policy(policyId);
    let model: string | null = null;
    try {
      model = (
        await this.options.ai.pinOrganizationProfile(
          policy?.profileOverrideId ?? undefined,
          "allow_remote"
        )
      ).modelId;
    } catch {
      /* Readiness is a visible state, not an inference failure. */
    }
    const repo = createKnowledgeAutomationRepository(pool);
    const [tasks, sources] = await Promise.all([
      repo.tasks(offset, filter === "attention"),
      repo.coverage(policyId)
    ]);
    return AutomationDashboardSchema.parse({
      ...tasks,
      sources,
      policyId,
      policyRevisionId: policy?.revisionId ?? null,
      ready: !!model,
      model
    });
  }
  async sources(offset: number) {
    const pool = this.pool(),
      policy = (
        await createSettingsRepository(pool).get<{ policyId: string }>(knowledgeAutomationPolicyKey)
      )?.policyId;
    if (!policy) throw new Error("wiki.errors.unavailable");
    return SourceJourneySchema.parse(
      await createKnowledgeAutomationRepository(pool).sources(policy, offset)
    );
  }
  async deliveries(
    policyId: string,
    sourceIds: string[],
    offset: number,
    revisionId: string | null
  ) {
    return AutomationDeliveriesSchema.parse(
      await createKnowledgeAutomationRepository(this.pool()).deliveries(
        policyId,
        sourceIds,
        offset,
        revisionId
      )
    );
  }
  async inspections(
    policyId: string,
    sourceIds: string[],
    offset: number,
    revisionId: string | null
  ) {
    return AutomationDeliveriesSchema.parse(
      await createKnowledgeAutomationRepository(this.pool()).inspections(
        policyId,
        sourceIds,
        offset,
        revisionId
      )
    );
  }
  async assets(offset: number) {
    return KnowledgeAssetsSchema.parse(
      await createKnowledgeAutomationRepository(this.pool()).assets(offset)
    );
  }
}
