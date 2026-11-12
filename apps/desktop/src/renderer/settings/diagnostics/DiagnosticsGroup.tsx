import { useState } from "react";
import type { Translator } from "@app/i18n";

import type { AppSettingsUpdate } from "../../../shared/ipc";
import type { SettingEntryV2 } from "../../../shared/settings-registry";
import { Button } from "../../components/ui/button";
import { SolidTriangle } from "../../components/ui/solid-glyphs";
import { PageRow } from "../PageRow";
import { RegistryRow } from "../SettingRow";
import { useHeldValue, SettingSwitch } from "../sections/advanced/advanced-controls";
import { useSettings } from "../settings-context";
import { helpOf, labelOf } from "../settings-model";
import { CallLogView } from "./CallLogView";
import { ConfirmDialog } from "./ConfirmDialog";
import { TaskHistoryView } from "./TaskHistoryView";
import { useCallLog, useTaskHistory } from "./use-call-log";

/** A page that reads only while it is open: the hook lives in the body PageRow mounts. */
function CallLogPage({ t }: { t: Translator }) {
  return <CallLogView t={t} state={useCallLog(true)} />;
}
function TaskHistoryPage({ t }: { t: Translator }) {
  return <TaskHistoryView t={t} state={useTaskHistory(true)} />;
}

type Step = "idle" | "asking" | "working";

/** "Delete the similarity debug runs": asked first; says how many went, or that none was there. */
function SimilarityRunsRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const [step, setStep] = useState<Step>("idle");
  const [result, setResult] = useState<{ deleted: number } | "failed" | null>(null);
  const run = () => {
    setStep("working");
    setResult(null);
    window.app.debug
      .clearSimilarityRuns()
      .then(({ deletedCount }) => setResult({ deleted: deletedCount }))
      .catch(() => setResult("failed"))
      .finally(() => setStep("idle"));
  };
  const count = (n: number) => new Intl.NumberFormat(t.locale).format(n);
  return (
    <>
      <RegistryRow
        entry={entry}
        control={
          <Button onClick={() => setStep("asking")}>{t("diagnostics.similarity.action")}</Button>
        }
        note={
          result === null ? undefined : (
            <span role="status">
              {result === "failed"
                ? t("diagnostics.similarity.failed")
                : result.deleted === 0
                  ? t("diagnostics.similarity.none")
                  : t(
                      result.deleted === 1
                        ? "diagnostics.similarity.deletedOne"
                        : "diagnostics.similarity.deletedMany",
                      { values: { count: count(result.deleted) } }
                    )}
            </span>
          )
        }
      />
      <ConfirmDialog
        t={t}
        open={step !== "idle"}
        onOpenChange={(open) => {
          if (!open && step !== "working") setStep("idle");
        }}
        title={t("diagnostics.similarity.title")}
        description={t("diagnostics.similarity.body")}
        confirmLabel={t("diagnostics.similarity.confirm")}
        danger
        busy={step === "working"}
        onConfirm={run}
      />
    </>
  );
}

/** The two switches: operation diagnostics, and the full capture that needs them (and asks first). */
function DebugSwitches({
  entries,
  saveApp
}: {
  entries: { mode: SettingEntryV2 | undefined; capture: SettingEntryV2 | undefined };
  saveApp: (update: AppSettingsUpdate) => Promise<boolean>;
}) {
  const settings = useSettings();
  const { t } = settings;
  const mode = settings.describe("debugMode")?.value === true;
  const capture = settings.describe("debugFullCapture")?.value === true;
  const [shownMode, holdMode] = useHeldValue(mode);
  const [shownCapture, holdCapture] = useHeldValue(capture);
  const [asking, setAsking] = useState(false);
  const write = (update: AppSettingsUpdate, hold: () => void) => {
    hold();
    void saveApp(update).then((ok) => {
      if (!ok) {
        holdMode(null);
        holdCapture(null);
      }
    });
  };
  return (
    <>
      {entries.mode ? (
        <RegistryRow
          entry={entries.mode}
          control={
            <SettingSwitch
              label={labelOf(t, entries.mode)}
              checked={shownMode}
              onChange={(next) =>
                write(
                  // Without the diagnostics there is nothing to capture in full.
                  next ? { debugMode: true } : { debugMode: false, debugFullCapture: false },
                  () => {
                    holdMode(next);
                    if (!next) holdCapture(false);
                  }
                )
              }
            />
          }
        />
      ) : null}
      {entries.capture ? (
        <RegistryRow
          entry={entries.capture}
          control={
            <SettingSwitch
              label={labelOf(t, entries.capture)}
              checked={shownCapture}
              disabled={!shownMode}
              onChange={(next) => {
                if (next) setAsking(true);
                else write({ debugFullCapture: false }, () => holdCapture(false));
              }}
            />
          }
          note={
            shownCapture ? (
              <span className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-foreground [text-wrap:pretty]">
                <SolidTriangle className="mt-0.5 text-warning" />
                <span>{t("diagnostics.debug.captureWarning")}</span>
              </span>
            ) : !shownMode ? (
              <span>{t("diagnostics.debug.captureNeedsDiagnostics")}</span>
            ) : undefined
          }
        />
      ) : null}
      <ConfirmDialog
        t={t}
        open={asking}
        onOpenChange={setAsking}
        title={t("diagnostics.debug.captureTitle")}
        description={t("diagnostics.debug.captureBody")}
        confirmLabel={t("diagnostics.debug.captureConfirm")}
        onConfirm={() => {
          setAsking(false);
          write({ debugFullCapture: true }, () => holdCapture(true));
        }}
      />
    </>
  );
}

/**
 * The Diagnostics group of Advanced (D17, Q9): the two debug switches, the AI call log and the job
 * history as pages that open in place, and "Delete the similarity debug runs". `saveApp` writes the
 * app settings the switches live in.
 */
export function DiagnosticsGroup({
  entries,
  saveApp
}: {
  entries: readonly SettingEntryV2[];
  saveApp: (update: AppSettingsUpdate) => Promise<boolean>;
}) {
  const { t } = useSettings();
  const byId = (id: string) => entries.find((entry) => entry.id === id);
  const page = (id: string, body: React.ReactNode) => {
    const entry = byId(id);
    return entry ? (
      <PageRow key={id} id={id} label={labelOf(t, entry)} help={helpOf(t, entry)}>
        {body}
      </PageRow>
    ) : null;
  };
  const similarity = byId("advanced.similarityRuns");
  return (
    <>
      <DebugSwitches
        entries={{ mode: byId("debugMode"), capture: byId("debugFullCapture") }}
        saveApp={saveApp}
      />
      {page("advanced.callLog", <CallLogPage t={t} />)}
      {page("advanced.taskHistory", <TaskHistoryPage t={t} />)}
      {similarity ? <SimilarityRunsRow entry={similarity} /> : null}
    </>
  );
}
