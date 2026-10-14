import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  WikiPageContentSchema,
  wikiAreaIds,
  type CuratorSnapshot,
  type CuratorChangeSet
} from "@app/domain";
import type { PgPool, PgClient } from "../client.js";
import { createWikiRepository } from "./wikiRepository.js";
import { addWikiDependency } from "./wikiContextRepository.js";
import { appendInterpretation } from "./knowledgeEvolution.js";
import { curatorHash } from "./wikiCuratorRepository.js";

/** The system area that holds automatic pages of a role: Themes, Entities or Maps. */
export function wikiAreaForRole(kind: string): string {
  return kind === "topic"
    ? wikiAreaIds.themes
    : kind === "entity"
      ? wikiAreaIds.entities
      : wikiAreaIds.maps;
}

/**
 * The parent of a new automatic page. A draft that proposes no parent (or omits it) never creates
 * a root: the page goes under the area of its role, as long as that area exists.
 */
export async function initialParentId(
  db: Pick<PgClient, "query">,
  target: {
    initialParent: CuratorChangeSet["targets"][number]["initialParent"];
    role: { kind: string };
  },
  resolve: (reference: NonNullable<typeof target.initialParent>) => { id: string }
): Promise<string | null> {
  if (target.initialParent) return resolve(target.initialParent).id;
  const area = wikiAreaForRole(target.role.kind);
  return (await db.query("select 1 from wiki_pages where id=$1", [area])).rows.length ? area : null;
}

/** Shared canonical target writes. Caller owns all admission, support and transaction locks. */
export async function persistCuratorTargets(
  db: PgClient,
  pool: PgPool,
  snapshot: Pick<
    CuratorSnapshot,
    "pages" | "references" | "evidence" | "sourceIds" | "sourceDates" | "inputFingerprint"
  >,
  proposal: Pick<CuratorChangeSet, "targets">,
  human: boolean,
  supportAuditId: string,
  options?: {
    parents?: Map<string, string | null>;
    explicitParent?: boolean;
    allocation?: Map<string, string>;
    placementOnlyIds?: Set<string>;
  }
) {
  const ids =
    options?.allocation ??
    new Map(proposal.targets.map((t) => [t.handle, t.pageId ?? randomUUID()]));
  const resolve = (r: CuratorChangeSet["targets"][number]["links"][number]) =>
    r.reference === "existing" ? r.target : { kind: "page" as const, id: ids.get(r.handle)! };
  // Allocate all page identities first; only the transaction can observe them.
  for (const target of proposal.targets)
    if (!target.pageId) {
      const duplicate = (
        await db.query(
          `select p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where not p.archived and p.role is distinct from 'investigation' and (unaccent(lower(p.title))=unaccent(lower($1)) or exists(select 1 from jsonb_array_elements_text(r.content->'aliases') a where unaccent(lower(a))=unaccent(lower($1))))`,
          [target.title]
        )
      ).rows;
      if (duplicate.length) {
        const same = (
          await db.query(
            "select r.content->'automatic'->>'purpose' as purpose from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.id=any($1::uuid[]) and p.kind=$2 and (exists(select 1 from wiki_evidence e where e.page_id=p.id and e.source_item_id=any($3::uuid[])) or exists(select 1 from wiki_dependencies d where d.revision_id=r.id and d.kind='source' and d.input_id=any($3::uuid[])))",
            [duplicate.map((r) => r.id), target.role.kind, snapshot.sourceIds]
          )
        ).rows;
        if (
          same.some(
            (r) => r.purpose && r.purpose.toLocaleLowerCase() === target.purpose.toLocaleLowerCase()
          )
        )
          throw new Error("organization.errors.conflict");
      }
      await db.query("insert into wiki_pages(id,title,kind,management) values($1,$2,$3,$4)", [
        ids.get(target.handle),
        target.title,
        target.role.kind,
        "ai_managed"
      ]);
    }
  const initialParents = new Map<string, string | null>();
  for (const target of proposal.targets)
    if (!target.pageId)
      initialParents.set(target.handle, await initialParentId(db, target, resolve));
  if (options?.explicitParent)
    for (const target of proposal.targets)
      if (!target.pageId)
        await db.query("update wiki_pages set parent_id=$2 where id=$1", [
          ids.get(target.handle),
          initialParents.get(target.handle) ?? null
        ]);
  const result: Array<{ pageId: string; revisionId: string }> = [];
  // Parent identities exist before saving; existing global placement lock validates canonical cycles.
  for (const target of proposal.targets) {
    const pageId = ids.get(target.handle)!,
      old = snapshot.pages.find((p) => p.id === pageId);
    if (old && old.revisionId !== target.expectedRevisionId)
      throw new Error("organization.errors.conflict");
    if (
      old &&
      !human &&
      (old.automatic?.management !== "ai_managed" ||
        old.review === "reviewed" ||
        target.sections.some((p) => old.sections.find((s) => s.id === p.sectionId)?.protected))
    )
      throw new Error("organization.errors.review");
    const content = old
      ? WikiPageContentSchema.strip().parse(old)
      : WikiPageContentSchema.parse({
          title: target.title,
          kind: target.role.kind,
          parentId: initialParents.get(target.handle) ?? null,
          entityId: target.role.kind === "entity" ? target.role.entityId : null
        });
    content.title = target.title;
    if (target.sections.length) content.review = "draft";
    const plannedRevision = randomUUID();
    if (options?.parents?.has(pageId)) content.parentId = options.parents.get(pageId)!;
    if (options?.placementOnlyIds?.has(pageId)) {
      if (!old) throw new Error("organization.errors.conflict");
      await createWikiRepository(pool).save(
        {
          id: pageId,
          expectedRevisionId: target.expectedRevisionId,
          content,
          evidenceChunkIds: []
        },
        {
          transaction: db,
          origin: "organization",
          allocatedTarget: false,
          humanApproved: human,
          revisionId: plannedRevision,
          explicitParent: true
        }
      );
      result.push({ pageId, revisionId: plannedRevision });
      continue;
    }
    for (const patch of target.sections) {
      const previous = content.sections.find((s) => s.id === patch.sectionId);
      const sectionId = patch.sectionId ?? randomUUID(),
        sectionRevisionId = randomUUID();
      const evidenceIds = [
        ...new Set(
          patch.originalHandles.map((h) => snapshot.evidence.find((e) => e.handle === h)!.chunkId)
        )
      ];
      const section = {
        interpretations: appendInterpretation(snapshot, patch, previous?.interpretations),
        id: sectionId,
        sectionRevisionId,
        title: patch.title,
        kind: previous?.kind ?? ("prose" as const),
        markdown: patch.markdown.replace(
          /\[(e[1-9][0-9]{0,3})\]/g,
          (m, h: string) => `[${patch.originalHandles.indexOf(h) + 1}]`
        ),
        provenance: "generated" as const,
        protected: previous?.protected ?? false,
        evidenceReview: "needs_review" as const,
        evidenceIds,
        assessment: {
          version: "automatic-wiki-v1" as const,
          sectionId,
          sectionRevisionId,
          humanReview: "unreviewed" as const,
          support: "validated" as const,
          reason: "generated_pending_verification" as const,
          supportMethod: "model_checked" as const,
          supportAuditId: supportAuditId,
          inputFingerprint: curatorHash(
            patch.originalHandles.map((h) => snapshot.evidence.find((e) => e.handle === h))
          ),
          freshness: "current" as const
        }
      };
      if (previous) content.sections[content.sections.indexOf(previous)] = section;
      else content.sections.push(section);
    }
    const role =
      target.role.kind === "collection"
        ? { ...target.role, owner: target.role.owner ? resolve(target.role.owner) : null }
        : target.role;
    const automatic = structuredClone(
      old?.automatic ?? {
        version: "automatic-wiki-v1" as const,
        management: "ai_managed" as const,
        role,
        purpose: target.purpose,
        placementProtected: false,
        links: [],
        groups: [],
        memberships: []
      }
    );
    automatic.purpose = target.purpose;
    automatic.links = target.links.map(resolve);
    automatic.role = role;
    for (const group of target.tocGroups) {
      const prior = automatic.groups.find((g) => g.id === group.id);
      if (
        prior &&
        !human &&
        (prior.orderProtected ||
          automatic.memberships.some((m) => m.groupId === prior.id && m.placementProtected))
      )
        throw new Error("organization.errors.review");
      if (!group.id && automatic.groups.some((g) => g.title === group.title))
        throw new Error("organization.errors.conflict");
      const groupId = group.id ?? randomUUID();
      const members: typeof automatic.memberships = group.memberships.map((m) => ({
        version: "automatic-wiki-v1" as const,
        id:
          m.id ??
          automatic.memberships.find(
            (old) =>
              old.groupId === groupId &&
              old.target.kind === resolve(m.target).kind &&
              old.target.id === resolve(m.target).id
          )?.id ??
          randomUUID(),
        pageId,
        groupId,
        target: resolve(m.target),
        purpose: m.purpose,
        order: m.order,
        origin: "generated" as const,
        placementProtected:
          automatic.memberships.find((old) => old.id === m.id)?.placementProtected ?? false,
        expectedPageRevisionId: plannedRevision,
        targetFingerprint:
          m.target.reference === "existing" ? m.target.fingerprint : snapshot.inputFingerprint
      }));
      const retained = automatic.memberships.filter(
        (m) =>
          m.groupId === groupId &&
          !members.some(
            (next) => next.target.kind === m.target.kind && next.target.id === m.target.id
          )
      );
      members.unshift(...retained.map((m) => ({ ...m, expectedPageRevisionId: plannedRevision })));
      members.forEach((member, order) => (member.order = order));
      const newGroup = {
        version: "automatic-wiki-v1" as const,
        id: groupId,
        collectionId: pageId,
        title: group.title,
        explanation:
          group.explanation?.replace(
            /\[(e[1-9][0-9]{0,3})\]/g,
            (_m, h: string) => "[" + (group.originalHandles.indexOf(h) + 1) + "]"
          ) ?? null,
        explanationEvidenceIds: group.originalHandles.map(
          (h) => snapshot.evidence.find((e) => e.handle === h)!.chunkId
        ),
        membershipIds: members.map((m) => m.id),
        orderProtected: prior?.orderProtected ?? false,
        origin: "generated" as const
      };
      if (prior) automatic.groups[automatic.groups.indexOf(prior)] = newGroup;
      else automatic.groups.push(newGroup);
      automatic.memberships = automatic.memberships
        .filter((m) => m.groupId !== groupId)
        .concat(members);
    }
    if (old?.automatic && !isDeepStrictEqual(old.automatic.role, role))
      throw new Error("organization.errors.scope");
    content.automatic = options?.placementOnlyIds?.has(pageId)
      ? structuredClone(old!.automatic)
      : automatic;
    const chunkIds = [
      ...new Set(
        [
          ...target.sections.flatMap((s) => s.originalHandles),
          ...target.tocGroups.flatMap((g) => g.originalHandles)
        ].map((h) => snapshot.evidence.find((e) => e.handle === h)!.chunkId)
      )
    ];
    for (const chunkId of chunkIds) {
      const original = snapshot.evidence.find((e) => e.chunkId === chunkId)!;
      const existing = (
        await db.query("select snapshot from wiki_evidence where page_id=$1 and chunk_id=$2", [
          pageId,
          chunkId
        ])
      ).rows[0];
      if (existing && existing.snapshot.contentHash !== original.contentHash)
        throw new Error("organization.errors.evidence");
    }
    await createWikiRepository(pool).save(
      {
        id: pageId,
        expectedRevisionId: target.expectedRevisionId,
        content,
        evidenceChunkIds: chunkIds
      },
      {
        transaction: db,
        origin: "organization",
        allocatedTarget: true,
        humanApproved: human,
        revisionId: plannedRevision,
        explicitParent: options?.explicitParent
      }
    );
    const revisionId = (
      await db.query("select current_revision_id from wiki_pages where id=$1", [pageId])
    ).rows[0]!.current_revision_id;
    for (const patch of target.sections) {
      const section = content.sections.find(
        (s) => s.id === patch.sectionId || (!patch.sectionId && s.markdown === patch.markdown)
      );
      if (section)
        await db.query(
          "update wiki_dependencies set stale_reason=null,changed_at=null where revision_id=$1 and section_id=$2 and kind in('source','document','chunk')",
          [revisionId, section.id]
        );
    }
    for (const link of [
      ...automatic.links,
      ...(role.kind === "collection" && role.owner ? [role.owner] : [])
    ]) {
      const reference = snapshot.references.find((r) => r.kind === link.kind && r.id === link.id);
      if (!reference) continue;
      for (const sourceId of reference.sourceIds)
        await addWikiDependency(
          db,
          revisionId,
          pageId,
          { kind: "source", id: sourceId, fingerprint: reference.fingerprint },
          reference
        );
      if (link.kind !== "page") {
        await addWikiDependency(
          db,
          revisionId,
          pageId,
          { kind: link.kind, id: link.id, fingerprint: reference.fingerprint },
          reference
        );
        for (const chunkId of reference.chunkIds) {
          const e = snapshot.evidence.find((e) => e.chunkId === chunkId);
          if (e)
            for (const [kind, id] of [
              ["chunk", e.chunkId],
              ["document", e.documentId]
            ])
              await addWikiDependency(
                db,
                revisionId,
                pageId,
                { kind: kind!, id: id!, fingerprint: e.contentHash },
                e
              );
        }
        continue;
      }
      await addWikiDependency(
        db,
        revisionId,
        pageId,
        { kind: "wiki_page", id: link.id, fingerprint: reference.fingerprint },
        reference
      );
      for (const section of snapshot.pages.find((p) => p.id === link.id)?.sections ?? []) {
        const fingerprint = (
          await db.query(
            "select md5(sec::text) fingerprint from wiki_page_revisions r cross join lateral jsonb_array_elements(r.content->'sections') sec where r.id=$1 and sec->>'id'=$2",
            [reference.fingerprint, section.id]
          )
        ).rows[0]?.fingerprint;
        if (fingerprint)
          await addWikiDependency(
            db,
            revisionId,
            pageId,
            { kind: "wiki_section", id: section.id, fingerprint },
            reference
          );
      }
    }

    await db.query(
      "update wiki_pages set management=$2,role=$3,toc_owner_kind=$4,toc_owner_id=$5 where id=$1",
      [
        pageId,
        automatic.management,
        role.role,
        role.kind === "collection" ? role.owner?.kind : null,
        role.kind === "collection" ? role.owner?.id : null
      ]
    );
    for (const section of content.sections)
      if (section.assessment)
        await db.query(
          "insert into wiki_section_assessments(section_revision_id,section_id,page_id,assessment) values($1,$2,$3,$4) on conflict do nothing",
          [section.sectionRevisionId, section.id, pageId, section.assessment]
        );
    for (const group of automatic.groups)
      for (const membership of automatic.memberships.filter((m) => m.groupId === group.id)) {
        const reference = snapshot.references.find(
          (r) => r.kind === membership.target.kind && r.id === membership.target.id
        );
        if (reference) {
          if (reference.kind === "page") {
            await addWikiDependency(
              db,
              revisionId,
              group.id,
              { kind: "wiki_page", id: reference.id, fingerprint: reference.fingerprint },
              reference
            );
            for (const section of snapshot.pages.find((p) => p.id === reference.id)?.sections ?? [])
              await addWikiDependency(
                db,
                revisionId,
                group.id,
                {
                  kind: "wiki_section",
                  id: section.id,
                  fingerprint:
                    (
                      await db.query(
                        "select md5(sec::text) fingerprint from wiki_page_revisions r cross join lateral jsonb_array_elements(r.content->'sections') sec where r.id=$1 and sec->>'id'=$2",
                        [reference.fingerprint, section.id]
                      )
                    ).rows[0]?.fingerprint ?? reference.fingerprint
                },
                reference
              );
          }
          if (reference.kind !== "page")
            await addWikiDependency(
              db,
              revisionId,
              group.id,
              { kind: reference.kind, id: reference.id, fingerprint: reference.fingerprint },
              reference
            );
          for (const sourceId of reference.sourceIds)
            await addWikiDependency(
              db,
              revisionId,
              group.id,
              { kind: "source", id: sourceId, fingerprint: reference.fingerprint },
              reference
            );
          for (const chunkId of reference.chunkIds) {
            const e = snapshot.evidence.find((e) => e.chunkId === chunkId);
            if (e)
              for (const [kind, id] of [
                ["chunk", e.chunkId],
                ["document", e.documentId]
              ])
                await addWikiDependency(
                  db,
                  revisionId,
                  group.id,
                  { kind: kind!, id: id!, fingerprint: e.contentHash },
                  e
                );
          }
        }
      }
    result.push({ pageId, revisionId });
  }
  return { targets: result, ids };
}
