import { translate } from "@app/i18n";
import { organizationAiFailure } from "./ai-task-parameters.js";
import { createAutomaticMaintenanceRepository } from "@app/db";
import {
  createWikiImpactReconciliationRepository,
  createWikiCollectionRepository,
  createWikiRemovalRepository,
  createWikiCuratorRepository,
  createOrganizationRepository,
  curatorHash,
  type PgPool
} from "@app/db";
import {
  countHierarchyChanges,
  WikiCollectionCommandSchema,
  type WikiBootstrap,
  type AutomaticWikiPolicy
} from "@app/domain";
import type { z } from "zod";
import { WikiCurator, validateCuratorProposal, curatorSupportView } from "./wiki-curator.js";
import { planHierarchyRoute } from "./wiki-hierarchy-continuation.js";
import { capturePromptPin, promptFingerprint, withPromptPin } from "./prompt-runtime.js";
const ticks = new WeakMap<PgPool, Promise<void>>();
export const collectionGenerationHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)])
          )
        : v;
  return curatorHash(canonical(value));
};
type Options = ConstructorParameters<typeof WikiCurator>[0];
/** A source cursor and child receipts live in the existing organization checkpoint owner. */
export class WikiCollection {
  constructor(private options: Options) {}
  private pool() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("wiki.errors.unavailable");
    return pool;
  }
  async command(
    raw: z.input<typeof WikiCollectionCommandSchema>,
    participation: import("@app/domain").CuratorSnapshot["participation"] = null
  ) {
    const c = WikiCollectionCommandSchema.parse(raw),
      repo = createWikiCollectionRepository(this.pool()),
      curator = createWikiCuratorRepository(this.pool());
    if (c.command === "assessment") {
      const policy = await curator.policy(c.input.policyId);
      if (!policy) throw new Error("organization.errors.policy");
      let profile;
      try {
        profile = await this.options.ai.pinOrganizationProfile(
          policy.profileOverrideId ?? undefined,
          "allow_remote"
        );
      } catch {
        profile = null;
      }
      const result = await repo.assessment(
        policy,
        c.input.after,
        c.input.limit,
        [],
        profile
          ? this.generation({
              policy,
              profile,
              promptPin: capturePromptPin(policy.scope.domainId),
              contentLanguage: await this.options.contentLanguage()
            })
          : "unconfigured"
      );
      for (const source of result.sources.slice(0, 3)) {
        const evidence = await curator.evidencePage([source.id], null, 6);
        if (!evidence.items.length) continue;
        const discovery = await curator.discover(
          policy,
          [source.id],
          evidence.items.map((e) => e.excerpt).join(" ")
        );
        for (const conflict of discovery.excluded)
          if (!result.scopeConflicts.some((c) => c.pageId === conflict.id))
            result.scopeConflicts.push({
              pageId: conflict.id,
              title: conflict.title,
              excludedSources: await curator.sourceMetadata(conflict.sourceIds)
            });
      }
      return result;
    }

    if (c.command === "bootstraps") return repo.list(c.policyId, c.after);
    if (c.command === "drainImpacts") {
      await this.tick();
      return null;
    }
    if (c.command === "bootstrap") {
      const policy = await curator.policy(c.input.policyId);
      if (policy?.state !== "enabled" || policy.revisionId !== c.input.policyRevisionId)
        throw new Error("organization.errors.policy");
      const sourceIds = c.input.sourceIds.length
        ? await curator.scope(policy, c.input.sourceIds)
        : [];
      const maintenanceRepo = createAutomaticMaintenanceRepository(this.pool()),
        existingMaintenance = await maintenanceRepo.authority(policy.id),
        maintenance =
          (await maintenanceRepo.installed(policy.id)) && !existingMaintenance
            ? await maintenanceRepo.manualAuthority(
                policy.id,
                new Date(),
                {
                  profile: await this.options.ai.pinOrganizationProfile(
                    policy.profileOverrideId ?? undefined,
                    "allow_remote"
                  ),
                  promptPin: capturePromptPin(policy.scope.domainId),
                  contentLanguage: await this.options.contentLanguage()
                },
                "daily"
              )
            : existingMaintenance,
        profile =
          maintenance?.snapshot.profile ??
          (await this.options.ai.pinOrganizationProfile(
            policy.profileOverrideId ?? undefined,
            "allow_remote"
          ));
      const id = await repo.bootstrap({
        version: "wiki-bootstrap-v1",
        participation,
        includeExistingNotes: c.input.includeExistingNotes,
        noteIds: c.input.noteIds,
        policy,
        sourceIds,
        profile,
        promptPin: maintenance?.snapshot.promptPin ?? capturePromptPin(policy.scope.domainId),
        contentLanguage:
          maintenance?.snapshot.contentLanguage ?? (await this.options.contentLanguage()),
        admittedAt: new Date().toISOString()
      });
      if (maintenance) {
        maintenance.checkpoint.bootstrapId = id;
        maintenance.checkpoint.phase = "coverage";
        await maintenanceRepo.checkpoint(maintenance);
      }
      this.options.wake();
      return repo.get(id);
    }
    const run = await repo.get(c.id);
    if (!run) throw new Error("organization.errors.invalid");
    if (c.command === "bootstrapGet") return run;
    if (run.checkpoint.state === "rejected") throw new Error("organization.errors.rejected");
    if (c.command === "bootstrapCancel") {
      run.checkpoint.state = "canceled";
      if (run.checkpoint.hierarchy) {
        run.checkpoint.hierarchy.outcome = "canceled";
        for (const route of run.checkpoint.hierarchy.routes)
          if (route.state !== "complete") route.state = "canceled";
      }
      if (run.checkpoint.childRunId)
        await new WikiCurator(this.options).command({
          command: "cancel",
          id: run.checkpoint.childRunId
        });
    }
    if (c.command === "bootstrapPause") run.checkpoint.state = "paused";
    if (c.command === "bootstrapResume") {
      const policy = await curator.policy(run.snapshot.policy.id);
      if (policy?.state !== "enabled" || policy.revisionId !== run.snapshot.policy.revisionId)
        throw new Error("organization.errors.policy");
      if (run.checkpoint.state === "canceled" || run.checkpoint.state === "complete")
        throw new Error("organization.errors.canceled");
      run.checkpoint.state = "running";
      run.checkpoint.error = null;
      await repo.checkpoint(run);
      if (run.checkpoint.childRunId) {
        const child = await new WikiCurator(this.options).get(run.checkpoint.childRunId);
        if (child?.status === "failed")
          await new WikiCurator(this.options).command({ command: "retry", id: child.id });
      }
    }
    await repo.checkpoint(run);
    this.options.wake();
    return repo.get(run.id);
  }
  tick() {
    const pool = this.pool(),
      active = ticks.get(pool);
    if (active) return active;
    const task = this.drain().finally(() => ticks.delete(pool));
    ticks.set(pool, task);
    return task;
  }
  async reconcile(policy: AutomaticWikiPolicy) {
    const repo = createWikiCollectionRepository(this.pool());
    await createWikiImpactReconciliationRepository(this.pool()).editorial(policy);
    await repo.reconcileAppliedChildren(policy);
    if (policy.state !== "enabled") return;
    for (const run of await repo.pendingRouteChildren(policy.id)) {
      const profile = await this.options.ai.pinOrganizationProfile(
        run.snapshot.policy.profileOverrideId ?? undefined,
        run.snapshot.profile.privacy
      );
      if (profile.identityHash !== run.snapshot.profile.identityHash) continue;
      await repo.deferUnstartedRouteChild(run, run.checkpoint.childRunId!);
    }
    // Resource-deferred synthesis is planning data, not human review. Adopt its
    // validated route before maintenance resolves child attention/revokes authority.
    for (const run of (await repo.active()).filter(
      (r) => r.snapshot.policy.id === policy.id && r.checkpoint.childRunId
    )) {
      const child = await new WikiCurator(this.options).get(run.checkpoint.childRunId!);
      if (
        child?.status === "failed" &&
        !child.snapshot.continuationRoute &&
        child.checkpoint.proposal &&
        !child.checkpoint.callPending &&
        ["organization.errors.scopeLimit", "organization.errors.context"].includes(
          child.checkpoint.error ?? ""
        )
      )
        await this.advance(run);
    }
    for (const event of await repo.exhaustedAttention(policy)) {
      const bootstrap = await repo.get(event.bootstrap_id);
      if (
        !bootstrap ||
        !(await repo.discoveryCovered(
          policy,
          event.source_ids,
          this.generation(bootstrap.snapshot)
        ))
      )
        continue;
      if ((await repo.dependents(event.kind, event.input_id, null, 1)).length) continue;
      await repo.acknowledgeCoveredAttention(policy, event.id, bootstrap.id);
    }
  }
  private async drain() {
    const repo = createWikiCollectionRepository(this.pool()),
      curator = createWikiCuratorRepository(this.pool());
    for (const policy of await curator.policies()) await this.reconcile(policy);
    // One bounded step per active bootstrap and one delivery per policy per supervisor pass.
    for (const run of await repo.active()) {
      const maintenance = createAutomaticMaintenanceRepository(this.pool());
      if (
        (await maintenance.installed(run.snapshot.policy.id)) &&
        !(await maintenance.authority(run.snapshot.policy.id))
      )
        continue;
      run.checkpoint.lastTickAt = new Date().toISOString();
      try {
        await repo.checkpoint(run);
        await this.advance(run);
      } catch (error) {
        if (!String(error).includes("organization.errors.conflict")) throw error;
      }
    }
    for (const policy of await curator.policies())
      if (policy.triggers.includes("input_changed")) {
        await repo.reconcileDeliveries(policy);
        if (policy.state !== "enabled") continue;
        const maintenance = createAutomaticMaintenanceRepository(this.pool());
        const installed = await maintenance.installed(policy.id),
          authority = await maintenance.authority(policy.id);
        if (installed && !authority) continue;
        const event = await repo.claimDelivery(policy.id);
        if (!event) continue;
        if (
          event.operation !== "delete" &&
          !(await repo.currentWikiEvent(event.kind, event.input_id, event.fingerprint))
        ) {
          await repo.delivery(event.id, event.checkpoint, {
            kind: "excluded",
            reason: "superseded_revision"
          });
          continue;
        }
        if (!event.input_generation.endsWith(":" + policy.revisionId)) {
          await repo.delivery(event.id, event.checkpoint, {
            kind: "excluded",
            reason: "policy_revised"
          });
          continue;
        }
        type Work = {
          removalRepair: {
            pageId: string;
            revision_id: string;
            source_ids: string[];
            archived: boolean;
            changed: boolean;
            preservedMissing: boolean;
          } | null;
          after: string | null;
          visited: string[];
          bootstrapId: string | null;
          discovery: boolean;
          childRunId: string | null;
          pageId: string | null;
          blockedReason: string | null;
          blockedMaintenanceRunId: string | null;
          outcomes: Array<{ pageId: string; runId: string | null; status: string }>;
        };
        const work: Work = {
          removalRepair: null,
          after: null,
          visited: [],
          bootstrapId: null,
          discovery: false,
          childRunId: null,
          pageId: null,
          blockedReason: null,
          blockedMaintenanceRunId: null,
          outcomes: [],
          ...event.checkpoint
        };
        if (work.childRunId) {
          const child = await new WikiCurator(this.options).get(work.childRunId);
          if (child && ["rejected", "canceled"].includes(child.status)) {
            work.blockedReason = child.checkpoint.error;
            await repo.delivery(event.id, work, {
              kind: "rejected",
              runId: child.id,
              reason: child.checkpoint.error,
              inputFingerprint: child.snapshot.inputFingerprint
            });
            continue;
          }
          if (
            child &&
            ["queued", "analyzing", "awaiting_review", "failed", "canceled", "rejected"].includes(
              child.status
            )
          ) {
            work.blockedReason = ["queued", "analyzing"].includes(child.status)
              ? null
              : (child.checkpoint.error ?? "organization.errors.review");
            await repo.delivery(event.id, work, null, child.status === "failed" ? 60000 : 2000);
            continue;
          }
          work.blockedReason = null;
          work.outcomes.push({
            pageId: work.pageId!,
            runId: work.childRunId,
            status: child?.status ?? "missing"
          });
          work.after = work.pageId;
          work.removalRepair = null;
          work.childRunId = null;
          work.pageId = null;
          await repo.delivery(event.id, work, null, 0);
          continue;
        }
        const unresolved = work.outcomes.some(
          (outcome) =>
            ![
              "applied",
              "removal_repaired",
              "causal_output_already_applied",
              "scope_decision"
            ].includes(outcome.status)
        );
        if (work.bootstrapId && unresolved) {
          work.blockedReason ??= "organization.errors.review";
          await repo.delivery(event.id, work, null);
          continue;
        }
        if (work.bootstrapId) {
          const run = await repo.get(work.bootstrapId);
          if (
            run &&
            ["complete", "attention", "canceled", "rejected"].includes(run.checkpoint.state)
          ) {
            await repo.delivery(event.id, work, {
              kind: run.checkpoint.state,
              runId: run.id,
              reason: run.checkpoint.error,
              outcomes: work.outcomes
            });
          } else await repo.delivery(event.id, work, null);
          continue;
        }
        const allowed = await curator.allowed(policy);
        let dependent = work.removalRepair
          ? { ...work.removalRepair, id: work.removalRepair.pageId }
          : (await repo.dependents(event.kind, event.input_id, work.after, 1))[0];
        if (dependent) {
          const key = dependent.id + ":" + dependent.revision_id;
          if (work.visited.length >= 100) {
            await repo.delivery(event.id, work, {
              kind: "attention",
              reason: "propagation_limit",
              remainingAfter: work.after,
              outcomes: work.outcomes
            });
            continue;
          }
          if (!work.visited.includes(key)) work.visited.push(key);
          work.pageId = dependent.id;
          const skip = async (reason: string) => {
            work.outcomes.push({ pageId: dependent.id, runId: null, status: reason });
            work.after = dependent.id;
            work.pageId = null;
            work.removalRepair = null;
            await repo.delivery(event.id, work, null, 0);
          };
          try {
            if (!work.removalRepair)
              work.removalRepair = await createWikiRemovalRepository(this.pool()).repair(
                policy,
                dependent.id,
                dependent.revision_id,
                translate(await this.options.contentLanguage(), "wiki.remainingReferences"),
                { id: event.id, checkpoint: work }
              );
            if (work.removalRepair) {
              for (const peer of await repo.removalPeers(dependent.id)) {
                const repair = await createWikiRemovalRepository(this.pool()).repair(
                  policy,
                  peer.id,
                  peer.revision_id,
                  translate(await this.options.contentLanguage(), "wiki.remainingReferences")
                );
                if (repair?.preservedMissing) work.removalRepair.preservedMissing = true;
              }
              dependent = { ...work.removalRepair, id: work.removalRepair.pageId };
              if (
                work.removalRepair.archived ||
                !work.removalRepair.source_ids.length ||
                !work.removalRepair.changed ||
                work.removalRepair.preservedMissing
              ) {
                await skip("removal_repaired");
                continue;
              }
            }
          } catch (error) {
            work.blockedReason = organizationAiFailure(error, "organization.errors.failed");
            await repo.delivery(event.id, work, null);
            continue;
          }
          if (dependent.source_ids.some((id: string) => !allowed.includes(id))) {
            await skip("scope_decision");
            continue;
          }
          if (
            event.causal_run_id &&
            (await repo.causalApplied(event.causal_run_id, dependent.id))
          ) {
            await skip("causal_output_already_applied");
            continue;
          }
          if (await repo.sourceBusy(dependent.source_ids)) {
            await repo.delivery(event.id, work, null);
            continue;
          }
          try {
            const pages = await curator.exactPages(policy, [dependent.id]),
              page = pages[0]!;
            let chunkIds = [
              ...new Set(page.evidence.filter((e) => e.current).map((e) => e.chunkId))
            ];
            if (work.removalRepair || page.evidence.some((e) => !e.current)) {
              const replacement = await curator.evidencePage(
                dependent.source_ids,
                null,
                policy.limits.originalPassages
              );
              if (replacement.next) throw new Error("organization.errors.scopeLimit");
              chunkIds = [...new Set([...chunkIds, ...replacement.items.map((e) => e.chunkId)])];
            }
            const noteIds = [
              ...new Set(
                pages.flatMap(
                  (p) =>
                    p.automatic?.memberships
                      .filter((m) => m.target.kind === "atomic_note")
                      .map((m) => m.target.id) ?? []
                )
              )
            ];
            for (const id of noteIds) {
              const note = await curator.noteOriginals(id);
              chunkIds = [...new Set([...chunkIds, ...note.chunk_ids])];
            }
            // Required target groups keep complete originals; oversize targets remain explicit attention.
            if (!chunkIds.length || chunkIds.length > policy.limits.originalPassages)
              throw new Error("organization.errors.scopeLimit");
            const generation = await repo.inputGeneration(
              dependent.source_ids,
              event.kind === "wiki_section" || event.kind === "wiki_page" ? event.fingerprint : null
            );
            const child = await new WikiCurator(this.options).start(
              {
                policyId: policy.id,
                policyRevisionId: policy.revisionId,
                sourceIds: dependent.source_ids,
                noteIds,
                evidenceChunkIds: chunkIds
              },
              null,
              {
                targetPageId: dependent.id,
                inputGeneration: generation,
                causalRunId: event.causal_run_id ?? null,
                causalGroupId: event.causal_group_id ?? null
              }
            );
            work.blockedReason = null;
            work.blockedMaintenanceRunId = null;
            work.childRunId = child!.id;
            await repo.delivery(event.id, work, null, 0);
          } catch (error) {
            work.blockedReason = organizationAiFailure(error, "organization.errors.failed");
            work.blockedMaintenanceRunId = authority?.id ?? null;
            if (
              !installed &&
              !work.removalRepair &&
              ["organization.errors.scopeLimit", "organization.errors.scopeDecision"].includes(
                work.blockedReason
              )
            ) {
              work.outcomes.push({ pageId: dependent.id, runId: null, status: work.blockedReason });
              work.after = dependent.id;
              work.pageId = null;
              work.blockedReason = null;
            }
            await repo.delivery(event.id, work, null, 2000);
          }
          continue;
        }
        if (unresolved) {
          work.blockedReason ??= "organization.errors.review";
          await repo.delivery(event.id, work, null);
          continue;
        }
        // New material has no dependents: a separate once-per-current-generation discovery path.
        if (event.causal_run_id || work.discovery || event.kind.startsWith("wiki_")) {
          await repo.delivery(event.id, work, { kind: "inspected", outcomes: work.outcomes });
          continue;
        }
        const enabledAt = await repo.enabledAt(policy.id, policy.revisionId);
        if (enabledAt && new Date(event.event_created_at).getTime() < enabledAt.getTime()) {
          await repo.delivery(event.id, work, {
            kind: "inspected",
            reason: "initial_collection_requires_bootstrap",
            outcomes: work.outcomes
          });
          continue;
        }
        const sources = [
          ...new Set<string>(
            event.source_ids.filter((id: unknown): id is string => typeof id === "string")
          )
        ].filter((id) => allowed.includes(id));
        if (!sources.length) {
          await repo.delivery(event.id, work, {
            kind: "excluded",
            reason: "outside_scope_or_deleted",
            outcomes: work.outcomes
          });
          continue;
        }
        if (await repo.sourceBusy(sources)) {
          await repo.delivery(event.id, work, null);
          continue;
        }
        try {
          const profile =
            authority?.snapshot.profile ??
            (await this.options.ai.pinOrganizationProfile(
              policy.profileOverrideId ?? undefined,
              "allow_remote"
            ));
          const generation = this.generation({
            policy,
            profile,
            promptPin: authority?.snapshot.promptPin ?? capturePromptPin(policy.scope.domainId),
            contentLanguage:
              authority?.snapshot.contentLanguage ?? (await this.options.contentLanguage())
          });
          if (await repo.discoveryCovered(policy, sources, generation)) {
            await repo.delivery(event.id, work, {
              kind: "inspected",
              reason: "coverage_current",
              outcomes: work.outcomes
            });
            continue;
          }
          const started = (await this.command({
            command: "bootstrap",
            input: {
              policyId: policy.id,
              policyRevisionId: policy.revisionId,
              sourceIds: sources,
              includeExistingNotes: true
            }
          })) as WikiBootstrap;
          work.discovery = true;
          work.bootstrapId = started.id;
          await repo.delivery(event.id, work, null, 0);
        } catch (error) {
          await repo.delivery(event.id, work, {
            kind: "attention",
            reason: organizationAiFailure(error, "organization.errors.failed"),
            outcomes: work.outcomes
          });
        }
      }
  }
  private generation(
    snapshot: Pick<
      WikiBootstrap["snapshot"],
      "policy" | "profile" | "promptPin" | "contentLanguage"
    >
  ) {
    return collectionGenerationHash({
      policy: snapshot.policy.revisionId,
      profile: snapshot.profile.identityHash,
      parameters: snapshot.profile.parameters,
      language: snapshot.contentLanguage,
      prompts: promptFingerprint(
        ["organization.curator", "organization.curator.repair", "organization.curator.support"],
        snapshot.promptPin,
        snapshot.profile.provider
      )
    });
  }
  async settled(
    snapshot: Pick<
      WikiBootstrap["snapshot"],
      "policy" | "profile" | "promptPin" | "contentLanguage"
    >
  ) {
    return createWikiCollectionRepository(this.pool()).settled(
      snapshot.policy,
      this.generation(snapshot)
    );
  }
  private hierarchy(run: WikiBootstrap) {
    const checkpoint = run.checkpoint,
      policy = run.snapshot.policy;
    checkpoint.hierarchy ??= {
      version: "automatic-wiki-v1",
      fingerprint: {
        version: "automatic-wiki-v1",
        branchFingerprint: "pending",
        scopeFingerprint: curatorHash(policy.scope),
        policyRevisionId: policy.revisionId,
        promptFingerprint: this.generation(run.snapshot),
        modelFingerprint: collectionGenerationHash(run.snapshot.profile)
      },
      afterPageId: null,
      inspectedPages: 0,
      outcome: "pending",
      routes: [],
      counts: { workTargets: 0, structuralAncestors: 0, changedPages: 0 },
      appliedGroupIds: [],
      decisions: []
    };
    return checkpoint.hierarchy;
  }
  private async structure(run: WikiBootstrap) {
    const repo = createWikiCollectionRepository(this.pool()),
      curator = createWikiCuratorRepository(this.pool()),
      checkpoint = run.checkpoint,
      policy = run.snapshot.policy;
    const hierarchy = this.hierarchy(run);
    const maintenance = await createAutomaticMaintenanceRepository(this.pool()).authority(
      policy.id
    );
    const wide = ["weekly", "monthly"].includes(maintenance?.snapshot.policy.kind ?? "daily");
    const batch = await repo.structuralCandidates(
      policy,
      hierarchy.afterPageId,
      run.snapshot.sourceIds,
      wide ? 50 : 20,
      wide
    );
    for (const item of batch.items) {
      const previousCursor = hierarchy.afterPageId;
      const fingerprint = collectionGenerationHash({
        branch: item.fingerprint,
        generation: this.generation(run.snapshot),
        scope: policy.scope
      });
      const prior = await repo.structuralDecision(policy.id, item.pageId, fingerprint);
      hierarchy.afterPageId = item.pageId;
      hierarchy.inspectedPages++;
      hierarchy.fingerprint.branchFingerprint = item.fingerprint;
      if (prior) {
        if (
          !hierarchy.decisions.some(
            (d) => d.pageId === prior.pageId && d.fingerprint === prior.fingerprint
          )
        )
          hierarchy.decisions.push(prior);
        if (prior.outcome !== "applied" && prior.outcome !== "no_change") {
          checkpoint.state =
            prior.outcome === "rejected"
              ? "rejected"
              : prior.outcome === "canceled"
                ? "canceled"
                : "attention";
          checkpoint.error = prior.reason ?? "organization.errors.review";
          await repo.checkpoint(run);
          return;
        }
        continue;
      }
      if (item.kind === "settled") {
        hierarchy.decisions.push({
          pageId: item.pageId,
          fingerprint,
          kind: item.kind,
          outcome: "no_change",
          runId: null
        });
        continue;
      }
      // Admission can stop on resources or occurrence authority. Keep this owner
      // discoverable until its child receipt, rather than skipping it on resume.
      hierarchy.afterPageId = previousCursor;
      const kind = item.kind;
      const candidates =
        kind === "missing_toc"
          ? batch.items.slice(batch.items.indexOf(item)).filter((i) => i.kind === "missing_toc")
          : [item];
      let selected: Array<{ item: typeof item; fingerprint: string; chunks: string[] }> = [];
      for (const candidate of candidates) {
        const identity = collectionGenerationHash({
          branch: candidate.fingerprint,
          generation: this.generation(run.snapshot),
          scope: policy.scope
        });
        if (
          candidate !== item &&
          (await repo.structuralDecision(policy.id, candidate.pageId, identity))
        )
          continue;
        const page = (await curator.exactPages(policy, [candidate.pageId]))[0]!;
        const chunks = [...new Set(page.evidence.filter((e) => e.current).map((e) => e.chunkId))];
        if (!chunks.length || chunks.length > policy.limits.originalPassages) {
          if (!selected.length) throw new Error("organization.errors.scopeLimit");
          continue;
        }
        if (
          new Set([...selected.flatMap((s) => s.chunks), ...chunks]).size >
          policy.limits.originalPassages
        )
          continue;
        selected.push({ item: candidate, fingerprint: identity, chunks });
        if (selected.length >= policy.limits.targets) break;
      }
      let child: Awaited<ReturnType<WikiCurator["start"]>> = null;
      while (!child) {
        const owners = selected.map((s) => ({ pageId: s.item.pageId, fingerprint: s.fingerprint }));
        try {
          child = await withPromptPin(run.snapshot.promptPin, () =>
            new WikiCurator(this.options).start(
              {
                policyId: policy.id,
                policyRevisionId: policy.revisionId,
                sourceIds: [...new Set(selected.flatMap((s) => s.item.sourceIds))],
                noteIds: [],
                evidenceChunkIds: [...new Set(selected.flatMap((s) => s.chunks))]
              },
              null,
              {
                parentBootstrapId: run.id,
                inputGeneration: collectionGenerationHash(owners),
                structuralIntent: { kind, owners },
                ...(kind === "unplaced"
                  ? { targetPageId: item.pageId }
                  : { destinationPageIds: owners.map((o) => o.pageId) })
              }
            )
          );
        } catch (error) {
          if (
            selected.length === 1 ||
            !/(?:organization.errors.(context|scopeLimit))/.test(String(error))
          )
            throw error;
          selected = selected.slice(0, -1);
        }
      }
      for (const selectedItem of selected)
        hierarchy.decisions.push({
          pageId: selectedItem.item.pageId,
          fingerprint: selectedItem.fingerprint,
          kind,
          outcome: "pending",
          runId: child.id
        });
      checkpoint.childRunId = child.id;
      await repo.checkpoint(run);
      return;
    }
    hierarchy.afterPageId = batch.after;
    if (batch.done) {
      if (hierarchy.routes.some((r) => r.state !== "complete"))
        throw new Error("organization.errors.scopeLimit");
      hierarchy.outcome = hierarchy.counts.changedPages ? "complete" : "no_change";
      checkpoint.state = "complete";
    }
    await repo.checkpoint(run);
  }
  private async advance(run: WikiBootstrap) {
    const repo = createWikiCollectionRepository(this.pool()),
      curator = createWikiCuratorRepository(this.pool()),
      checkpoint = run.checkpoint;
    const policy = await curator.policy(run.snapshot.policy.id);
    if (policy?.state !== "enabled" || policy.revisionId !== run.snapshot.policy.revisionId) {
      checkpoint.state = "paused";
      checkpoint.error = "organization.errors.policy";
      await repo.checkpoint(run);
      return;
    }
    try {
      const profile = await this.options.ai.pinOrganizationProfile(
        run.snapshot.policy.profileOverrideId ?? undefined,
        run.snapshot.profile.privacy
      );
      if (profile.identityHash !== run.snapshot.profile.identityHash)
        throw new Error("organization.errors.modelChanged");
      if (checkpoint.childRunId) {
        const child = await new WikiCurator(this.options).get(checkpoint.childRunId);
        if (!child) throw new Error("organization.errors.invalid");
        if (["queued", "analyzing"].includes(child.status)) return;
        if (
          child.status === "failed" &&
          child.checkpoint.proposal &&
          !child.checkpoint.callPending &&
          ["organization.errors.scopeLimit", "organization.errors.context"].includes(
            child.checkpoint.error ?? ""
          ) &&
          !child.snapshot.continuationRoute
        ) {
          // The retained oversized output is untrusted until every ordinary scope,
          // content, note and target check succeeds. Only the byte check is relaxed.
          validateCuratorProposal(
            {
              ...child.snapshot,
              resources: { ...child.snapshot.resources, maxProposalBytes: Number.MAX_SAFE_INTEGER }
            },
            child.checkpoint.proposal
          );
          await curator.validate(child.snapshot);
          const route = planHierarchyRoute(
            child,
            curatorSupportView(child.snapshot, child.checkpoint.proposal).associations
          );
          checkpoint.hierarchy ??= {
            version: "automatic-wiki-v1",
            fingerprint: route.fingerprint,
            afterPageId: null,
            inspectedPages: 0,
            outcome: "partial",
            routes: [],
            counts: { workTargets: 0, structuralAncestors: 0, changedPages: 0 },
            appliedGroupIds: [],
            decisions: []
          };
          checkpoint.hierarchy.routes.push(route);
          checkpoint.childRunId = null;
          await repo.adoptHierarchyRoute(run, child);
          return;
        }
        if (child.status !== "applied") {
          checkpoint.state =
            child.status === "rejected"
              ? "rejected"
              : child.status === "canceled"
                ? "canceled"
                : "attention";
          checkpoint.error = child.checkpoint.error ?? "organization.errors.review";
          if (checkpoint.hierarchy) {
            if (child.status === "rejected") checkpoint.hierarchy.outcome = "rejected";
            else if (child.status === "awaiting_review")
              checkpoint.hierarchy.outcome = "awaiting_review";
            else if (child.status === "canceled") {
              checkpoint.hierarchy.outcome = "canceled";
              for (const route of checkpoint.hierarchy.routes)
                if (route.state !== "complete") route.state = "canceled";
            }
          }
          for (const decision of checkpoint.hierarchy?.decisions.filter(
            (d) => d.runId === child.id
          ) ?? []) {
            decision.outcome =
              child.status === "awaiting_review"
                ? "awaiting_review"
                : child.status === "rejected"
                  ? "rejected"
                  : child.status === "canceled"
                    ? "canceled"
                    : "failed";
            decision.reason = checkpoint.error;
          }
          if (checkpoint.sourceId)
            await repo.coverage(
              policy.id,
              checkpoint.sourceId,
              checkpoint.sourceFingerprint!,
              "attention",
              checkpoint.sourceCovered,
              run.id
            );
          await repo.checkpoint(run);
          return;
        }
        if (child.snapshot.continuationRoute) {
          // Hierarchy apply commits the owner checkpoint and its timestamp alongside
          // the receipt. Refresh before consuming it; never overwrite route progress.
          const fresh = (await repo.get(run.id))!;
          Object.assign(run, fresh);
          Object.assign(checkpoint, fresh.checkpoint);
          run.checkpoint = checkpoint;
          const route = checkpoint.hierarchy!.routes.find(
            (r) => r.routeId === child.snapshot.continuationRoute!.routeId
          )!;
          if (route.state !== "complete") {
            checkpoint.completedGroups++;
            checkpoint.childRunId = null;
            await repo.checkpoint(run);
            return;
          }
        }
        const hierarchy = this.hierarchy(run);
        if (!hierarchy.appliedGroupIds.includes(child.snapshot.groupId)) {
          const counts = countHierarchyChanges(child.checkpoint.proposal!);
          hierarchy.counts = {
            workTargets: hierarchy.counts.workTargets + counts.workTargets,
            structuralAncestors: hierarchy.counts.structuralAncestors + counts.structuralAncestors,
            changedPages: hierarchy.counts.changedPages + counts.changedPages
          };
          hierarchy.appliedGroupIds.push(child.snapshot.groupId);
        }
        if (checkpoint.phase === "structure") {
          for (const decision of hierarchy.decisions.filter((d) => d.runId === child.id)) {
            decision.outcome = "applied";
            decision.reason = null;
          }
          hierarchy.afterPageId = null;
          checkpoint.completedGroups++;
          checkpoint.childRunId = null;
          await repo.checkpoint(run);
          return;
        }
        if (checkpoint.phase === "notes") {
          if (checkpoint.nextNote) {
            checkpoint.afterNote = checkpoint.nextNote;
            checkpoint.nextNote = null;
          } else
            checkpoint.noteCursor +=
              child.snapshot.references.filter((r) => r.kind === "atomic_note").length || 1;
          checkpoint.completedGroups++;
          checkpoint.childRunId = null;
          await repo.checkpoint(run);
          return;
        }
        checkpoint.sourceCovered += checkpoint.pendingOriginals;
        checkpoint.completedGroups++;
        checkpoint.childRunId = null;
        checkpoint.afterChunk = checkpoint.nextChunk;
        await repo.coverage(
          policy.id,
          checkpoint.sourceId!,
          checkpoint.sourceFingerprint!,
          checkpoint.nextChunk || run.snapshot.noteIds.length || run.snapshot.includeExistingNotes
            ? "partial"
            : "integrated",
          checkpoint.sourceCovered,
          run.id
        );
        if (!checkpoint.nextChunk) {
          checkpoint.completedSources++;
          checkpoint.afterSource = checkpoint.sourceId;
          checkpoint.sourceId = null;
          checkpoint.sourceCovered = 0;
          checkpoint.afterChunk = null;
          checkpoint.sourceFingerprint = null;
        }
        await repo.checkpoint(run);
        return;
      }
      const route = checkpoint.hierarchy?.routes.find(
        (r) => r.state !== "complete" && r.state !== "canceled"
      );
      if (route) {
        const planning = route.planningRunId
          ? await new WikiCurator(this.options).get(route.planningRunId)
          : null;
        if (!planning) throw new Error("organization.errors.invalid");
        await withPromptPin(run.snapshot.promptPin, () =>
          new WikiCurator(this.options).start(
            {
              policyId: policy.id,
              policyRevisionId: policy.revisionId,
              sourceIds: planning.snapshot.sourceIds,
              noteIds: planning.snapshot.references
                .filter((r) => r.kind === "atomic_note")
                .map((r) => r.id),
              evidenceChunkIds: planning.snapshot.evidence.map((e) => e.chunkId)
            },
            null,
            { parentBootstrapId: run.id, continuationRouteId: route.routeId }
          )
        );
        return; // Admission atomically binds the owner and child; no stale CAS write.
      }
      if (checkpoint.phase === "structure") {
        await this.structure(run);
        return;
      }
      if (!checkpoint.sourceId) {
        const assessment = await repo.assessment(
            policy,
            checkpoint.afterSource,
            1,
            run.snapshot.sourceIds,
            this.generation(run.snapshot)
          ),
          source = assessment.sources[0];
        if (!source) {
          const explicit = checkpoint.noteCursor < run.snapshot.noteIds.length;
          let selectedNotes = explicit
            ? run.snapshot.noteIds.slice(
                checkpoint.noteCursor,
                checkpoint.noteCursor + (policy.operations.includes("evolve_notes") ? 6 : 1)
              )
            : run.snapshot.includeExistingNotes
              ? await curator.unplacedNotes(
                  run.snapshot.sourceIds.length
                    ? run.snapshot.sourceIds
                    : await curator.allowed(policy),
                  checkpoint.afterNote
                )
              : [];
          if (selectedNotes.length) {
            checkpoint.phase = "notes";
            let child: Awaited<ReturnType<WikiCurator["start"]>> = null;
            while (!child) {
              const note = await curator.noteOriginals(selectedNotes[0]!);
              for (const id of selectedNotes.slice(1)) {
                const next = await curator.noteOriginals(id);
                if (
                  new Set([...note.chunk_ids, ...next.chunk_ids]).size >
                  policy.limits.originalPassages
                ) {
                  selectedNotes = selectedNotes.slice(0, selectedNotes.indexOf(id));
                  break;
                }
                note.chunk_ids = [...new Set([...note.chunk_ids, ...next.chunk_ids])];
                note.source_ids = [...new Set([...note.source_ids, ...next.source_ids])];
              }
              if (note.chunk_ids.length > policy.limits.originalPassages)
                throw new Error("organization.errors.scopeLimit");
              try {
                child = await withPromptPin(run.snapshot.promptPin, () =>
                  new WikiCurator(this.options).start(
                    {
                      policyId: policy.id,
                      policyRevisionId: policy.revisionId,
                      sourceIds: note.source_ids,
                      noteIds: selectedNotes,
                      ...(explicit && policy.operations.includes("evolve_notes")
                        ? { intent: "consolidation" as const }
                        : {}),
                      evidenceChunkIds: note.chunk_ids
                    },
                    null,
                    { parentBootstrapId: run.id }
                  )
                );
              } catch (error) {
                if (
                  selectedNotes.length <= 1 ||
                  !/(?:organization.errors.(context|scopeLimit)|maintenance.errors.budget)/.test(
                    String(error)
                  )
                )
                  throw error;
                selectedNotes = selectedNotes.slice(
                  0,
                  Math.max(1, Math.floor(selectedNotes.length / 2))
                );
              }
            }
            checkpoint.nextNote = explicit ? null : selectedNotes.at(-1)!;
            checkpoint.childRunId = child.id;
            await repo.checkpoint(run);
            return;
          }
          await repo.finishCoverage(run.id);
          checkpoint.contentComplete = true;
          checkpoint.notesComplete = true;
          checkpoint.phase = "structure";
          await repo.checkpoint(run);
          return;
        }
        if (source.coverage === "integrated" || !source.originals) {
          await repo.coverage(
            policy.id,
            source.id,
            source.fingerprint,
            source.originals ? "integrated" : "cataloged",
            source.originals,
            run.id
          );
          checkpoint.afterSource = source.id;
          checkpoint.completedSources++;
          if (!source.originals) checkpoint.catalogedSources++;
          await repo.checkpoint(run);
          return;
        }
        checkpoint.sourceId = source.id;
        checkpoint.sourceFingerprint = source.fingerprint;
        checkpoint.sourceCovered = 0;
        await repo.checkpoint(run);
      }
      if (await repo.sourceBusy([checkpoint.sourceId!])) return;
      const originals = await curator.evidencePage(
        [checkpoint.sourceId!],
        checkpoint.afterChunk,
        Math.min(6, policy.limits.originalPassages)
      );
      if (!originals.items.length) {
        checkpoint.afterSource = checkpoint.sourceId;
        checkpoint.sourceId = null;
        checkpoint.afterChunk = null;
        await repo.checkpoint(run);
        return;
      }
      let selected = originals.items,
        child: Awaited<ReturnType<WikiCurator["start"]>> = null,
        next = originals.next;
      while (!child) {
        try {
          child = await withPromptPin(run.snapshot.promptPin, () =>
            new WikiCurator(this.options).start(
              {
                policyId: policy.id,
                policyRevisionId: policy.revisionId,
                sourceIds: [checkpoint.sourceId!],
                noteIds: [],
                evidenceChunkIds: selected.map((e) => e.chunkId)
              },
              null,
              { parentBootstrapId: run.id }
            )
          );
        } catch (error) {
          if (
            selected.length <= 1 ||
            !String(error).match(
              /(?:organization.errors.(context|scopeLimit)|maintenance.errors.budget)/
            )
          )
            throw error;
          selected = selected.slice(0, Math.max(1, Math.floor(selected.length / 2)));
          next = selected.at(-1)!.chunkId;
        }
      }
      checkpoint.childRunId = child.id;
      checkpoint.pendingOriginals = selected.length;
      checkpoint.nextChunk = next;
      await repo.coverage(
        policy.id,
        checkpoint.sourceId!,
        checkpoint.sourceFingerprint!,
        "analyzing",
        checkpoint.sourceCovered,
        run.id
      );
      await repo.checkpoint(run);
    } catch (error) {
      if (/maintenance.errors.(wait|idle|busy|sync)$/.test(String(error))) {
        await repo.checkpoint(run);
        return;
      }
      checkpoint.state = "attention";
      checkpoint.error = organizationAiFailure(error, "organization.errors.failed");
      checkpoint.attentionSources++;
      if (checkpoint.sourceId)
        await repo.coverage(
          policy.id,
          checkpoint.sourceId,
          checkpoint.sourceFingerprint!,
          "attention",
          checkpoint.sourceCovered,
          run.id
        );
      await repo.checkpoint(run);
    }
  }
}
