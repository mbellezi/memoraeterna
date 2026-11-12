import { useId, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../shared/settings-registry";
import { cn } from "../lib/cn";
import { ChangedMarker } from "./ChangedMarker";
import { InlineAction } from "./InlineAction";
import { useSettings } from "./settings-context";
import { defaultText, helpOf, labelOf, valueText } from "./settings-model";
import type { RowReset } from "./settings-store";

export interface SettingRowProps {
  t: Translator;
  /** The registry id: the row's `data-setting-id`, which a link and the search find it by (X10). */
  id: string;
  label: string;
  /** Plain-language help; one or two lines. */
  help?: ReactNode;
  /** The control, at the right of the text. */
  control?: ReactNode;
  /** Differs from the default: the marker, the accent bar and the way back. */
  changed?: boolean;
  /** What the default reads like ("same as macOS"); the row says "Default: …". */
  defaultLabel?: ReactNode;
  /** The default depends on this Mac or on another option, so no value can be named. */
  defaultVaries?: boolean;
  /** Puts the setting back; the row offers it only while it differs. */
  onReset?: (() => void) | undefined;
  reset?: RowReset;
  /** A line under the help (a status, a pointer to another section). */
  note?: ReactNode;
  /** A wide control goes under the text instead of beside it. */
  stack?: boolean;
  /** Highlighted for 2 s after a link or a search result took the person here. */
  highlighted?: boolean;
  className?: string;
}

/**
 * One setting (design record §7.6): the label (14, 500) with the "Changed" marker, its help (13,
 * secondary), the control at the right and, while it differs from the default, a 2 px accent bar,
 * "Default: …" and "Restore default". The row is focusable by script (`tabIndex -1`) so a link or a
 * search result can scroll to it, focus it and light it for two seconds. The reset control's name
 * carries the setting's, so a screen reader hears which one it restores.
 */
export function SettingRow({
  t,
  id,
  label,
  help,
  control,
  changed = false,
  defaultLabel,
  defaultVaries = false,
  onReset,
  reset = "idle",
  note,
  stack = false,
  highlighted = false,
  className
}: SettingRowProps) {
  const labelId = useId();
  const showDefault = changed && (defaultLabel !== undefined || defaultVaries || onReset);
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-setting-id={id}
      data-changed={changed ? "" : undefined}
      tabIndex={-1}
      className={cn(
        "relative grid items-center gap-x-6 gap-y-1 border-b border-border py-4 outline-none",
        "transition-colors [transition-duration:var(--motion-slow)]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        stack ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto]",
        highlighted
          ? "-mx-4 bg-surface-selected px-4 [box-shadow:inset_2px_0_0_var(--accent)]"
          : changed
            ? "-ml-4 pl-4 [box-shadow:inset_2px_0_0_var(--accent)]"
            : "",
        className
      )}
    >
      <div
        id={labelId}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-base font-medium leading-5 text-foreground"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        {changed ? <ChangedMarker t={t} /> : null}
      </div>
      {help ? (
        <p className="m-0 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
          {help}
        </p>
      ) : null}
      {note ? <div className="min-w-0 text-xs text-secondary-foreground">{note}</div> : null}
      {showDefault ? (
        <p className="m-0 flex flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground">
          {defaultLabel !== undefined ? (
            <>
              <span>{t("settingsShell.row.default")}</span>
              <b className="font-medium text-secondary-foreground">{defaultLabel}</b>
            </>
          ) : defaultVaries ? (
            <span>{t("settingsShell.row.defaultVaries")}</span>
          ) : null}
          {onReset ? (
            <>
              {defaultLabel !== undefined || defaultVaries ? (
                <span aria-hidden="true">·</span>
              ) : null}
              {reset === "working" ? (
                <span role="status" className="text-secondary-foreground">
                  {t("settingsShell.row.resetting")}
                </span>
              ) : (
                <InlineAction
                  onClick={onReset}
                  aria-label={`${t("settingsShell.row.reset")}: ${label}`}
                  className="text-xs"
                >
                  <RotateCcw aria-hidden="true" />
                  {t("settingsShell.row.reset")}
                </InlineAction>
              )}
            </>
          ) : null}
        </p>
      ) : null}
      {reset === "failed" || reset === "pending" ? (
        <p role="status" className="m-0 text-xs text-secondary-foreground [text-wrap:pretty]">
          {t(
            reset === "failed" ? "settingsShell.row.resetFailed" : "settingsShell.row.resetPending"
          )}
        </p>
      ) : null}
      {control ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            stack
              ? "mt-2 justify-start"
              : "col-start-2 row-span-4 row-start-1 self-center justify-self-end justify-end"
          )}
        >
          {control}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A row of the registry: its label and help from the registry's copy, its "changed" marker, default
 * and reset from `settings.describe`, its highlight from the surface. A section gives it the control
 * (and the words of the default when a code such as "system" is not copy).
 */
export function RegistryRow({
  entry,
  control,
  defaultLabel,
  note,
  stack,
  className
}: {
  entry: SettingEntryV2;
  control?: ReactNode;
  /** The default in words; absent, the row names it when it can say it without options. */
  defaultLabel?: ReactNode;
  note?: ReactNode;
  stack?: boolean;
  className?: string;
}) {
  const settings = useSettings();
  const { t } = settings;
  const description = settings.describe(entry.id);
  const changed = description?.changed === true;
  const defaultWords = defaultLabel ?? defaultText(t, entry, description) ?? undefined;
  return (
    <SettingRow
      t={t}
      id={entry.id}
      label={labelOf(t, entry)}
      help={helpOf(t, entry)}
      changed={changed}
      defaultLabel={defaultWords}
      defaultVaries={defaultWords === undefined && description?.default === null}
      onReset={entry.reset === "none" ? undefined : () => void settings.reset(entry.id)}
      reset={settings.rowState(entry.id)}
      highlighted={settings.highlighted === entry.id}
      {...(control !== undefined ? { control } : {})}
      {...(note !== undefined ? { note } : {})}
      {...(stack !== undefined ? { stack } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}

/** A row that has no control of its own yet shows what can be said of its value without one. */
export function ReadOnlyValue({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const text = valueText(settings.t, entry, settings.describe(entry.id));
  if (text === null) return null;
  return <span className="text-sm text-secondary-foreground tabular-nums">{text}</span>;
}
