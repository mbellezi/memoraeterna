import { useEffect, useId, useState } from "react";
import type { Translator } from "@app/i18n";

import { Input } from "../../components/ui/input";
import { SettingSelect } from "../sections/advanced/advanced-controls";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  canConfirmPrune,
  defaultPruneForm,
  pruneRequestOf,
  pruneStageOf,
  type PruneCount,
  type PruneForm,
  type PruneScope,
  type PruneUnit
} from "./prune-model";

/** How long the form rests after a keystroke before the records are counted again. */
const countDelayMs = 250;

/**
 * Deleting old call-log records, asked and counted before it is confirmed: how old (days or months),
 * what (the calls and their logs, or only the full prompts and responses) and, as the form is
 * filled, how many records that would delete (`monitoring.prune` with `preview`). Only a count above
 * zero can be confirmed; a failed count or a failed deletion says so and deletes nothing.
 */
export function PruneDialog(props: PruneDialogProps) {
  // Each time it opens it starts from the defaults, with nothing counted.
  return props.open ? <PruneDialogBody {...props} /> : null;
}

interface PruneDialogProps {
  t: Translator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The records that were deleted; the page reads its rows again. */
  onDeleted: (count: number) => void;
  portal?: boolean;
}

function PruneDialogBody({ t, open, onOpenChange, onDeleted, portal = true }: PruneDialogProps) {
  const [form, setForm] = useState<PruneForm>(defaultPruneForm);
  // What the last count said, and for which form: an answer for another form is no answer.
  const [answer, setAnswer] = useState<
    | { key: string; status: "failed" }
    | { key: string; status: "counted"; count: number; cutoff: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = pruneRequestOf(form);
  const key = request === null ? "" : `${request.amount}|${request.unit}|${request.scope}`;
  const amountId = useId();

  // Counts what the form would delete, once the person stops typing; an answer that arrives after
  // the form changed is dropped.
  useEffect(() => {
    if (!open || request === null) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      window.app.monitoring
        .prune({ ...request, preview: true })
        .then((result) => {
          if (current)
            setAnswer({ key, status: "counted", count: result.count, cutoff: result.cutoff });
        })
        .catch(() => {
          if (current) setAnswer({ key, status: "failed" });
        });
    }, countDelayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `key` stands for the request's three values.
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const counted: PruneCount =
    answer !== null && answer.key === key
      ? answer.status === "failed"
        ? { status: "failed" }
        : { status: "counted", count: answer.count, cutoff: answer.cutoff }
      : { status: "counting" };

  const stage = pruneStageOf(form, counted);

  const change = (next: Partial<PruneForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setFailed(false);
  };

  const confirm = () => {
    if (request === null || !canConfirmPrune(stage)) return;
    setBusy(true);
    setFailed(false);
    window.app.monitoring
      .prune({ ...request, preview: false })
      .then((result) => {
        onOpenChange(false);
        onDeleted(result.count);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  const date =
    stage.kind === "ready"
      ? new Intl.DateTimeFormat(t.locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(stage.cutoff)
        )
      : "";
  const count = stage.kind === "ready" ? new Intl.NumberFormat(t.locale).format(stage.count) : "";

  return (
    <ConfirmDialog
      t={t}
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      portal={portal}
      title={t("diagnostics.prune.title")}
      description={t("diagnostics.prune.description")}
      confirmLabel={t("diagnostics.prune.confirm")}
      onConfirm={confirm}
      danger
      canConfirm={canConfirmPrune(stage)}
      busy={busy}
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <label htmlFor={amountId}>{t("diagnostics.prune.olderThan")}</label>
          <Input
            id={amountId}
            inputMode="numeric"
            value={form.amount}
            aria-invalid={request === null ? true : undefined}
            onChange={(event) => change({ amount: event.target.value })}
            className="w-20 text-right tabular-nums"
          />
          <SettingSelect
            label={t("diagnostics.prune.unit")}
            value={form.unit}
            options={[
              { value: "days", label: t("diagnostics.prune.days") },
              { value: "months", label: t("diagnostics.prune.months") }
            ]}
            onChange={(unit) => change({ unit: unit as PruneUnit })}
            width="9rem"
          />
        </div>
        <div className="grid gap-1 text-sm text-foreground">
          <span aria-hidden="true">{t("diagnostics.prune.scope")}</span>
          <SettingSelect
            label={t("diagnostics.prune.scope")}
            value={form.scope}
            options={[
              { value: "all", label: t("diagnostics.prune.scopeAll") },
              { value: "payloads", label: t("diagnostics.prune.scopePayloads") }
            ]}
            onChange={(scope) => change({ scope: scope as PruneScope })}
            width="100%"
          />
        </div>
        <p
          role="status"
          className="m-0 min-h-10 text-sm text-secondary-foreground [text-wrap:pretty]"
        >
          {failed
            ? t("diagnostics.prune.failed")
            : stage.kind === "invalid"
              ? t("diagnostics.prune.invalid")
              : stage.kind === "counting"
                ? t("diagnostics.prune.counting")
                : stage.kind === "failed"
                  ? t("diagnostics.prune.countFailed")
                  : stage.kind === "nothing"
                    ? t("diagnostics.prune.nothing")
                    : t(
                        stage.count === 1
                          ? "diagnostics.prune.previewOne"
                          : "diagnostics.prune.previewMany",
                        { values: { count, date } }
                      )}
        </p>
      </div>
    </ConfirmDialog>
  );
}
