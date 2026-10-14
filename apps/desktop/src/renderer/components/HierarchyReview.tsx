import {
  countHierarchyChanges,
  hierarchyMoveReviews,
  hierarchyReviewPath,
  hasCompleteHierarchySupport,
  type CuratorRun,
  type HierarchyChangeSet
} from "@app/domain";
import type { Translator } from "@app/i18n";

export function retainedHierarchyProposal(run: CuratorRun) {
  return run.proposal ?? run.checkpoint.proposal;
}
export function hierarchyCandidateState(run: CuratorRun, proposal: HierarchyChangeSet) {
  if (run.status === "applied") return "applied";
  if (run.candidateSupportMatches && run.checkpoint.supportAssessment?.verdict.supported === false)
    return "unsupported";
  if (
    run.candidateSupportMatches &&
    run.checkpoint.proposal &&
    JSON.stringify(run.checkpoint.proposal) === JSON.stringify(proposal) &&
    hasCompleteHierarchySupport(proposal, run.checkpoint.supportAssessment?.verdict)
  )
    return "supported";
  return "unchecked";
}
export function canApproveHierarchy(run: CuratorRun) {
  const proposal = retainedHierarchyProposal(run);
  if (!proposal || hierarchyCandidateState(run, proposal) !== "supported") return false;
  try {
    hierarchyMoveReviews(run.snapshot.placement, proposal);
    return true;
  } catch {
    return false;
  }
}
export function HierarchyReview({ run, t }: { run: CuratorRun; t: Translator }) {
  const proposal = retainedHierarchyProposal(run);
  if (!proposal) return null;
  const counts = countHierarchyChanges(proposal),
    inventory = run.snapshot.placement;
  let reviews: ReturnType<typeof hierarchyMoveReviews> | null = null;
  try {
    reviews = hierarchyMoveReviews(inventory, proposal);
  } catch {
    /* An incomplete review never guesses a mutable current path. */
  }
  return (
    <section className="mt-3 grid min-w-0 gap-3 rounded-xl border border-border p-3 text-sm">
      <p className="font-medium">{t("hierarchy.review")}</p>
      <p role="status">{t(`hierarchy.candidate.${hierarchyCandidateState(run, proposal)}`)}</p>
      <p>{t("hierarchy.counts", { values: counts })}</p>
      {proposal.ancestors.length > 0 && (
        <div>
          <h4 className="font-medium">{t("hierarchy.ancestors")}</h4>
          <p className="text-xs text-muted-foreground">{t("hierarchy.ancestorHint")}</p>
        </div>
      )}
      {[...proposal.ancestors, ...proposal.targets].map((target) => {
        const reference =
          "pageId" in target && target.pageId
            ? {
                reference: "existing" as const,
                target: { kind: "page" as const, id: target.pageId },
                expectedRevisionId: target.expectedRevisionId!,
                fingerprint:
                  inventory.pages.find((p) => p.pageId === target.pageId)?.fingerprint ??
                  target.expectedRevisionId!
              }
            : { reference: "proposed" as const, handle: target.handle };
        const path = hierarchyReviewPath(inventory, proposal, reference),
          role = target.role,
          entity =
            role.kind === "entity"
              ? run.snapshot.references.find((r) => r.kind === "entity" && r.id === role.entityId)
              : undefined;
        return (
          <div key={target.handle} className="min-w-0 border-t border-border pt-2">
            <p className="font-medium break-words">
              {target.title} ·{" "}
              {t(
                proposal.ancestors.some((a) => a.handle === target.handle)
                  ? "hierarchy.ancestor"
                  : "hierarchy.workTarget"
              )}
            </p>
            <p className="whitespace-pre-wrap break-words">
              {t("hierarchy.proposedPath")}:{" "}
              {path
                ? path.map((p) => p.title).join(" / ") || t("hierarchy.root")
                : t("hierarchy.reviewUnavailable")}
            </p>
            <p className="break-words text-xs text-muted-foreground">{target.purpose}</p>
            {target.role.kind === "entity" && (
              <div className="mt-2 break-words text-xs">
                <p>
                  {t("hierarchy.entityBinding")}: {entity?.title ?? t("organization.unavailable")}
                </p>
                <code className="break-all">{target.role.entityId}</code>
                <p>
                  {t("hierarchy.attribution")}:{" "}
                  {entity?.sourceIds
                    .map(
                      (id) =>
                        run.snapshot.references.find((r) => r.kind === "source" && r.id === id)
                          ?.title ??
                        run.snapshot.evidence.find((e) => e.sourceItemId === id)?.sourceTitle ??
                        id
                    )
                    .join(" · ") ?? t("organization.unavailable")}
                </p>
                {entity?.chunkIds.map((id) => (
                  <code key={id} className="block break-all">
                    {id}
                  </code>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {proposal.moves.length > 0 && (
        <>
          <h4 className="font-medium">{t("hierarchy.moves")}</h4>
          {!reviews ? (
            <p role="alert">{t("hierarchy.reviewUnavailable")}</p>
          ) : (
            reviews.map((review) => (
              <section
                key={review.move.handle}
                className="grid min-w-0 gap-2 border-t border-border pt-3"
              >
                <p className="break-words">
                  {t("organization.before")}: {review.before.map((p) => p.title).join(" / ")}
                </p>
                <p className="break-words">
                  {t("organization.after")}: {review.after.map((p) => p.title).join(" / ")}
                </p>
                <p className="break-words">{review.move.reason}</p>
                <p>
                  {t("hierarchy.moveImpact", {
                    values: {
                      descendants: review.descendantCount,
                      memberships: review.affectedMemberships.length,
                      backlinks: review.backlinks.length
                    }
                  })}
                </p>
                <p>
                  {t(
                    review.placementProtected
                      ? "hierarchy.placementProtected"
                      : "hierarchy.placementUnprotected"
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{t("hierarchy.preservation")}</p>
                <details>
                  <summary className="cursor-pointer">{t("hierarchy.exactRevisions")}</summary>
                  <div className="mt-2 grid gap-3 break-all text-xs">
                    {review.before.map((p) => (
                      <p key={p.pageId}>
                        {p.title} · {p.pageId} · {p.revisionId}
                      </p>
                    ))}
                    {review.affectedMemberships.map((m) => (
                      <div key={m.id}>
                        <p>
                          {t("hierarchy.membership")}: {m.id}
                        </p>
                        <p>
                          {t("hierarchy.pageRevision")}: {m.pageId} · {m.expectedRevisionId}
                        </p>
                        <p>
                          {t("hierarchy.groupOrder", {
                            values: {
                              group: m.groupId,
                              order: m.groupOrder + 1,
                              member: m.order + 1
                            }
                          })}
                        </p>
                        <p>
                          {t(`hierarchy.link.${m.purpose}`)} · {t(`wiki.results.${m.target.kind}`)}{" "}
                          · {m.target.id}
                        </p>
                        <p>
                          {t(
                            m.placementProtected
                              ? "hierarchy.placementProtected"
                              : "hierarchy.placementUnprotected"
                          )}{" "}
                          ·{" "}
                          {t(
                            m.groupOrderProtected
                              ? "hierarchy.orderProtected"
                              : "hierarchy.orderUnprotected"
                          )}
                        </p>
                      </div>
                    ))}
                    {review.backlinks.map((p) => (
                      <p key={p.pageId}>
                        {t("hierarchy.backlink")}: {p.pageId} · {p.revisionId}
                      </p>
                    ))}
                  </div>
                </details>
              </section>
            ))
          )}
        </>
      )}
    </section>
  );
}
