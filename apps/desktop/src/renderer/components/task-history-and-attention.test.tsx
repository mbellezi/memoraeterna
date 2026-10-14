import { it, expect } from "vitest";
import { renderToString } from "react-dom/server";
const randomUUID = () => crypto.randomUUID();
import {
  automaticRoutinePresets,
  AutomaticMaintenanceRunSchema,
  automaticMaintenanceDisplayStatus
} from "@app/domain";
import { createTranslator } from "@app/i18n";
import { AutomaticMaintenanceResult } from "./AutomaticMaintenancePanel";
import { TaskHistoryCleanup } from "./TaskHistoryCleanup";
const policy = automaticRoutinePresets(randomUUID(), randomUUID(), "scope", "UTC")[0]!;
const run = AutomaticMaintenanceRunSchema.parse({
  id: randomUUID(),
  jobId: randomUUID(),
  scheduleIds: [randomUUID()],
  status: "awaiting_review",
  snapshot: {
    version: "automatic-maintenance-v1",
    policy,
    policyRevisionId: policy.policyRevisionId,
    dueAt: new Date().toISOString(),
    cutoff: new Date().toISOString(),
    manual: false
  },
  checkpoint: { reason: "organization.errors.evidence", incomplete: true },
  reservation: { calls: 4, tokens: 2000 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attention: {
    kind: "blocked",
    childRunId: randomUUID(),
    childVersion: "wiki-curator-v2",
    reason: "organization.errors.unsupported",
    issues: [
      {
        path: "targets.0.sections.1.markdown",
        message: "Use “other people”; the source does not specify students."
      }
    ]
  }
});
it.each(["en", "pt-BR", "es", "fr", "it"] as const)(
  "distinguishes failed validation from review and exposes its diagnostics in %s",
  (locale) => {
    const t = createTranslator(locale),
      html = renderToString(
        <AutomaticMaintenanceResult run={run} t={t} busy={false} cancel={() => {}} />
      );
    expect(html).toContain(t("maintenance.status.blocked"));
    expect(html).toContain(t("organization.errors.unsupported"));
    expect(html).toContain(t("automation.openBlockingRun"));
    expect(html).not.toContain(t("automation.reviewProposal"));
    expect(html).toContain("the source does not specify students");
    expect(html).not.toContain("[[missing:");
    const review = {
      ...run,
      attention: { ...run.attention!, kind: "review" as const, issues: [], reason: null }
    };
    expect(automaticMaintenanceDisplayStatus(review)).toBe("awaiting_review");
    expect(
      renderToString(
        <AutomaticMaintenanceResult run={review} t={t} busy={false} cancel={() => {}} />
      )
    ).toContain(t("automation.reviewProposal"));
    const clear = renderToString(<TaskHistoryCleanup t={t} onCleared={async () => {}} />);
    expect(clear).toContain(t("automation.clearHistory"));
    expect(clear).toContain(t("automation.clearHistoryHint"));
    expect(clear).not.toContain("[[missing:");
  }
);
it("does not infer approval authority from the legacy waiting state alone", () => {
  expect(automaticMaintenanceDisplayStatus({ ...run, attention: null })).toBe("blocked");
  expect(automaticMaintenanceDisplayStatus({ ...run, status: "canceled" })).toBe("canceled");
});
