import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import type { AiDecisionsStatus } from "../../../../shared/ipc";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { Skeleton } from "../../../components/ui/skeleton";
import { SettingRow } from "../../SettingRow";
import { decisionsLine, formatSpend, formatUsd } from "./ai-model";
import { AreaNotice, StatusLine, SwitchControl } from "./ai-parts";
import type { Load } from "./ai-controller";
import { useRowProps } from "./ai-rows";

/**
 * The opt-in OpenAI Decisions decider: a switch and, under it, what decides the relations now (and
 * why, when the local ranker steps in), what it costs and what it sends. Turning it on asks first,
 * in place, with the disclosure of what leaves this Mac (the note text, to OpenAI, under its
 * retention terms); turning it off needs no question. It is unavailable in Local and Custom, which
 * never send note text out, and says so. Until its status is read it is the same row with a bar in
 * place of the switch (or the plain error and Try again): it is one component, so the element a
 * person landed on from a link or a search result is not replaced when the status arrives.
 */
export function DecisionsRow({
  entry,
  load,
  onRetry,
  asking,
  busy,
  note,
  notice,
  onToggle,
  onConfirm,
  onCancel
}: {
  entry: SettingEntryV2;
  load: Load<AiDecisionsStatus>;
  onRetry: () => void;
  asking: boolean;
  busy: boolean;
  /** What the last action came to ("OpenAI Decisions is on."). */
  note: string | null;
  notice: string | undefined;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const status = load.status === "ready" ? load.value : null;
  const row = useRowProps(entry, status === null ? { withReset: false } : {});
  const { t } = row;
  if (status === null)
    return (
      <SettingRow
        {...row}
        stack={load.status === "error"}
        control={
          load.status === "loading" ? <Skeleton className="h-5 w-9 rounded-full" /> : undefined
        }
        note={
          load.status === "error" ? (
            <ErrorState
              t={t}
              message={t("settingsAi.decisions.errorTitle")}
              retryLabel={t("shell.actions.retry")}
              onRetry={onRetry}
            />
          ) : undefined
        }
      />
    );
  const line = decisionsLine(t, status);
  const locked = !status.presetAllowed;
  return (
    <SettingRow
      {...row}
      defaultLabel={t("settingsShell.row.valueOff")}
      control={
        <>
          <span className="text-sm text-secondary-foreground">
            {status.enabled ? t("settingsShell.row.valueOn") : t("settingsShell.row.valueOff")}
          </span>
          <SwitchControl
            checked={status.enabled}
            disabled={locked || busy}
            aria-label={row.label}
            onClick={onToggle}
          />
        </>
      }
      note={
        <div className="grid gap-2">
          <StatusLine tone={line.tone === "blocked" ? "idle" : line.tone} live>
            {line.text}
          </StatusLine>
          {note ? (
            <StatusLine tone="ok" live>
              {note}
            </StatusLine>
          ) : null}
          {status.enabled ? <Spend t={t} status={status} /> : null}
          {asking ? (
            <EnableNotice
              t={t}
              status={status}
              busy={busy}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          ) : null}
          <AreaNotice message={notice} />
        </div>
      }
    />
  );
}

function Spend({ t, status }: { t: Translator; status: AiDecisionsStatus }) {
  return (
    <div className="grid gap-0.5 text-muted-foreground">
      <span className="tabular-nums">
        {t("settingsAi.decisions.spend", {
          values: {
            spent: formatSpend(t.locale, status.spentTodayUsd),
            cap: formatUsd(t.locale, status.dailyCapUsd),
            requests: status.requestsToday
          }
        })}
      </span>
      <span className="[text-wrap:pretty]">
        {t(
          status.calibrated
            ? "settingsAi.decisions.calibrated"
            : "settingsAi.decisions.uncalibrated"
        )}
      </span>
    </div>
  );
}

/** What turning it on sends, and to whom, before the person says yes. */
function EnableNotice({
  t,
  status,
  busy,
  onConfirm,
  onCancel
}: {
  t: Translator;
  status: AiDecisionsStatus;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={t("settingsAi.decisions.confirmTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="grid gap-2 rounded-lg border border-border-strong bg-soft p-3 text-sm text-secondary-foreground"
    >
      <p className="m-0 font-semibold text-foreground">{t("settingsAi.decisions.noticeTitle")}</p>
      <p className="m-0 [text-wrap:pretty]">
        {t("settingsAi.decisions.noticeBody", {
          values: { characters: status.bodyCharacters, model: status.model }
        })}
      </p>
      <p className="m-0 [text-wrap:pretty]">
        {t("settingsAi.decisions.noticeCost", {
          values: {
            price: formatUsd(t.locale, status.priceInputPerMillionUsd),
            cap: formatUsd(t.locale, status.dailyCapUsd)
          }
        })}
      </p>
      <p className="m-0 font-medium text-foreground">{t("settingsAi.decisions.confirmBody")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} autoFocus onClick={onConfirm}>
          {t("settingsAi.decisions.confirmApply")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
