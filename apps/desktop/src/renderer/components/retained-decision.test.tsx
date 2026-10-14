import { it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator } from "@app/i18n";
import { RetainedDecisionNotice } from "./AutomaticMaintenancePanel";
it.each(["en", "pt-BR", "es", "fr", "it"] as const)(
  "explains a retained decision without promising another attempt in %s",
  (locale) => {
    const t = createTranslator(locale),
      block = {
        runId: crypto.randomUUID(),
        reason: "organization.errors.unsupported",
        status: "failed"
      };
    const html = renderToString(<RetainedDecisionNotice block={block} t={t} inspect={() => {}} />);
    expect(html).toContain(t("automation.retainedTitle"));
    expect(html).toContain(t("automation.retainedHint"));
    expect(html).toContain(t("automation.openBlockingRun"));
    expect(html).not.toContain("[[missing:");
    expect(
      renderToString(
        <RetainedDecisionNotice
          block={{ ...block, status: "awaiting_review" }}
          t={t}
          inspect={() => {}}
        />
      )
    ).toContain(t("automation.reviewProposal"));
  }
);

import { ValidationRejectionDetails } from "./AutomaticWikiDialog";
import type { CuratorRun } from "@app/domain";
it.each(["en", "pt-BR", "es", "fr", "it"] as const)(
  "shows validator provenance and contextual lessons safely in %s",
  (locale) => {
    const t = createTranslator(locale),
      at = new Date().toISOString(),
      snapshot = {
        evidence: [
          {
            sourceItemId: crypto.randomUUID(),
            sourceTitle: "Original source",
            documentId: crypto.randomUUID(),
            chunkId: crypto.randomUUID(),
            contentHash: "original-v1"
          }
        ],
        priorRejections: [] as NonNullable<CuratorRun["snapshot"]["priorRejections"]>
      };
    snapshot.priorRejections = [
      {
        analysisId: crypto.randomUUID(),
        decidedAt: at,
        inputFingerprint: "previous-generation",
        originals: snapshot.evidence.map((e) => ({
          sourceItemId: e.sourceItemId,
          documentId: e.documentId,
          chunkId: e.chunkId,
          contentHash: e.contentHash
        })),
        issues: [
          {
            path: "targets.0.sections.0.markdown",
            message: "Do not narrow “others” to “students”.",
            previousText: "<script>students</script>"
          }
        ]
      }
    ];
    const run = {
      id: crypto.randomUUID(),
      jobId: null,
      status: "rejected",
      snapshot,
      checkpoint: { rejection: { kind: "automatic_validation", decidedAt: at } },
      proposal: null,
      receiptRevisionId: null,
      createdAt: at,
      updatedAt: at
    } as CuratorRun;
    const html = renderToString(<ValidationRejectionDetails run={run} t={t} />);
    for (const key of [
      "automaticRejection",
      "automaticRejectionHint",
      "priorRejections",
      "priorRejectionsHint",
      "previousRejectedText",
      "rejectionOriginals"
    ] as const)
      expect(html).toContain(t(`automation.${key}`));
    expect(html).toContain(snapshot.evidence[0]!.contentHash);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("[[missing:");
    expect(
      renderToString(
        <ValidationRejectionDetails
          run={{
            ...run,
            snapshot: { ...run.snapshot, priorRejections: [] },
            checkpoint: { ...run.checkpoint, rejection: undefined }
          }}
          t={t}
        />
      )
    ).toBe("");
  }
);
