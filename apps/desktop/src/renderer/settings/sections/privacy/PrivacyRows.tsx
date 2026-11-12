import { useState } from "react";
import { Info } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { SolidTriangle } from "../../../components/ui/solid-glyphs";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { requestSettingsTarget } from "../../settings-target";
import { objectKindChanged, useSectionRead } from "../general/use-section-read";
import { ConfirmDialog } from "./ConfirmDialog";
import { questionCount } from "./privacy-model";

/** "1 item", "3 items": the one or many key that a count asks for. */
const plural = (
  t: Translator,
  count: number,
  keys: {
    none?: Parameters<Translator>[0];
    one: Parameters<Translator>[0];
    many: Parameters<Translator>[0];
  }
): string =>
  t(count === 0 && keys.none ? keys.none : count === 1 ? keys.one : keys.many, {
    values: { count: count.toLocaleString(t.locale) }
  });

/**
 * Clear Recents: one button that asks first (the list of what was opened lately, pins stay) and then
 * says, in the row, how many items left it. The list never leaves this Mac, and the dialog says that
 * nothing else changes.
 */
export function ClearRecentsRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState<number | null>(null);
  return (
    <RegistryRow
      entry={entry}
      note={
        removed !== null ? (
          <span role="status" className="block text-foreground">
            {plural(t, removed, {
              none: "settingsPrivacy.history.doneNone",
              one: "settingsPrivacy.history.doneOne",
              many: "settingsPrivacy.history.doneMany"
            })}
          </span>
        ) : undefined
      }
      control={
        <>
          <Button onClick={() => setOpen(true)}>{t("settingsPrivacy.history.action")}</Button>
          <ConfirmDialog
            t={t}
            open={open}
            onOpenChange={setOpen}
            title={t("settingsPrivacy.history.dialogTitle")}
            body={t("settingsPrivacy.history.dialogBody")}
            confirmLabel={t("settingsPrivacy.history.confirm")}
            workingLabel={t("settingsPrivacy.working")}
            onConfirm={async () => {
              try {
                setRemoved(await window.app.viewHistory.clear());
                return null;
              } catch {
                return t("settingsPrivacy.history.failed");
              }
            }}
          />
        </>
      }
    />
  );
}

const questionsChanged = objectKindChanged("question");

/**
 * Delete questions: how many are saved (up to the first page, then "more than"), a button that asks
 * first and says what stays (the sources and the notes), and, after, how many went. With none saved
 * the button rests. The count follows the bus (`object.changed` of a question), never a timer.
 */
export function ClearQuestionsRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const { state, set } = useSectionRead(
    () => window.app.questions.list({ limit: 50 }),
    [{ type: "object.changed", when: questionsChanged }]
  );
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const known = state.status === "ready" ? questionCount(state.value) : null;
  const countLine =
    state.status === "error"
      ? t("settingsPrivacy.questions.readFailed")
      : known === null
        ? null
        : known.more
          ? t("settingsPrivacy.questions.countMore", {
              values: { count: known.count.toLocaleString(t.locale) }
            })
          : plural(t, known.count, {
              none: "settingsPrivacy.questions.countNone",
              one: "settingsPrivacy.questions.countOne",
              many: "settingsPrivacy.questions.countMany"
            });
  return (
    <RegistryRow
      entry={entry}
      note={
        <>
          {countLine ? <span className="block">{countLine}</span> : null}
          {deleted !== null ? (
            <span role="status" className="block text-foreground">
              {deleted === 0
                ? t("settingsPrivacy.questions.doneNone")
                : plural(t, deleted, {
                    one: "settingsPrivacy.questions.doneOne",
                    many: "settingsPrivacy.questions.doneMany"
                  })}
            </span>
          ) : null}
        </>
      }
      control={
        <>
          <Button disabled={known !== null && known.count === 0} onClick={() => setOpen(true)}>
            {t("settingsPrivacy.questions.action")}
          </Button>
          <ConfirmDialog
            t={t}
            open={open}
            onOpenChange={setOpen}
            title={t("settingsPrivacy.questions.dialogTitle")}
            body={t("settingsPrivacy.questions.dialogBody")}
            confirmLabel={t("settingsPrivacy.questions.confirm")}
            workingLabel={t("settingsPrivacy.working")}
            onConfirm={async () => {
              try {
                const result = await window.app.questions.clear();
                setDeleted(result.deleted);
                set({ items: [] });
                return null;
              } catch {
                return t("settingsPrivacy.questions.failed");
              }
            }}
          />
        </>
      }
    />
  );
}

/**
 * The AI call log, said in a sentence: how many calls it keeps, what each holds (times, models and
 * tokens, or whole prompts and answers while full capture is on) and where to see and delete them, in
 * Advanced. It is a pointer, not a second log: the log is read and pruned there.
 */
export function CallLogRow({ entry }: { entry: SettingEntryV2 }) {
  const { t, describe } = useSettings();
  const { state } = useSectionRead(
    () =>
      window.app.monitoring.list({
        view: "ai",
        kind: "all",
        status: "all",
        search: "",
        limit: 1,
        offset: 0
      }),
    [{ type: "monitoring.changed" }]
  );
  const fullCapture = describe("debugFullCapture")?.value === true;
  const count = state.status === "ready" ? state.value.totals.count : null;
  const sentence =
    state.status === "error"
      ? t("settingsPrivacy.callLog.readFailed")
      : count === null
        ? null
        : count === 0
          ? t("settingsPrivacy.callLog.none")
          : plural(t, count, {
              one: "settingsPrivacy.callLog.summaryOne",
              many: "settingsPrivacy.callLog.summaryMany"
            });
  return (
    <RegistryRow
      entry={entry}
      stack
      control={
        <div className="flex w-full max-w-[34rem] items-start gap-3 rounded-lg bg-info-soft p-3 text-sm text-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
          <p className="m-0 min-w-0 [text-wrap:pretty]">
            {sentence ? <>{sentence} </> : null}
            <span className={fullCapture ? "font-semibold" : undefined}>
              {fullCapture ? t("settingsPrivacy.callLog.full") : t("settingsPrivacy.callLog.light")}
            </span>{" "}
            <InlineAction
              onClick={() =>
                requestSettingsTarget({ section: "advanced", setting: "advanced.callLog" })
              }
            >
              {t("settingsPrivacy.callLog.open")}
            </InlineAction>
          </p>
        </div>
      }
    />
  );
}

/** What a reset that left files behind tells the renderer it reloads into: it lives for the window. */
export const resetLeftoversKey = "memora.settings.resetLeftovers";

function readLeftovers(): boolean {
  try {
    return window.sessionStorage.getItem(resetLeftoversKey) === "1";
  } catch {
    return false;
  }
}

function writeLeftovers(left: boolean): void {
  try {
    if (left) window.sessionStorage.setItem(resetLeftoversKey, "1");
    else window.sessionStorage.removeItem(resetLeftoversKey);
  } catch {
    // The warning is a courtesy; the reset itself is done.
  }
}

/**
 * Reset everything: the one thing here that cannot be taken back. The row says so and points at the
 * backup first; the button opens a dialog that lists what goes and what stays, with the red button
 * last. When it is done the app always reloads, so no panel keeps showing what no longer exists. If
 * some stored files could not be removed the warning is kept for the window across the reload and
 * this row says so when Privacy is shown again.
 */
export function ResetRow({
  entry,
  reload = () => window.location.reload()
}: {
  entry: SettingEntryV2;
  reload?: () => void;
}) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const [leftovers] = useState(readLeftovers);
  return (
    <RegistryRow
      entry={entry}
      note={
        leftovers ? (
          <span role="status" className="text-foreground">
            {t("settingsPrivacy.reset.warnings")}
          </span>
        ) : (
          <span className="flex items-start gap-1.5">
            <SolidTriangle className="mt-0.5 size-3.5 text-warning" />
            <span>
              {t("settingsPrivacy.reset.noUndo")}{" "}
              <InlineAction
                size="xs"
                onClick={() =>
                  requestSettingsTarget({ section: "library", setting: "library.backup" })
                }
              >
                {t("settingsPrivacy.reset.backupLink")}
              </InlineAction>
              .
            </span>
          </span>
        )
      }
      control={
        <>
          <Button onClick={() => setOpen(true)}>{t("settingsPrivacy.reset.action")}</Button>
          <ConfirmDialog
            t={t}
            open={open}
            onOpenChange={setOpen}
            title={t("settingsPrivacy.reset.dialogTitle")}
            body={t("settingsPrivacy.reset.dialogBody")}
            warn={t("settingsPrivacy.reset.dialogWarn")}
            confirmLabel={t("settingsPrivacy.reset.confirm")}
            workingLabel={t("settingsPrivacy.reset.running")}
            onConfirm={async () => {
              try {
                const result = await window.app.settings.resetLibrary();
                writeLeftovers(result.failedFiles > 0);
                reload();
                return null;
              } catch {
                return t("settingsPrivacy.reset.failed");
              }
            }}
          />
        </>
      }
    />
  );
}
