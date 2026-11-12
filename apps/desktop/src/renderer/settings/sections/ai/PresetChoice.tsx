import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { AiPresetId, HardwareProfileResult } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import type { SetupStage } from "./ai-controller";
import {
  formatUsd,
  setupHelpKeys,
  setupNameKeys,
  setupNeedsWriterWarning,
  type SetupCard
} from "./ai-model";
import { AreaNotice, StatusLine } from "./ai-parts";
import { routeLabel } from "./route-labels";

export interface PresetChoiceProps {
  t: Translator;
  /** The row's name, which names the radio group. */
  label: string;
  cards: readonly SetupCard[];
  /** No setup is stored yet: the block says what to do. */
  unset: boolean;
  stage: SetupStage;
  hardware: HardwareProfileResult | null;
  notice?: string | undefined;
  onSelect: (id: SetupCard["id"]) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one big decision of the AI section: where the AI runs. Four cards (Local, Hybrid, Cloud,
 * Custom) as one radio group; the arrows only move the focus and Space or Enter chooses, so passing
 * over a card never applies a setup. Choosing a setup asks first, in place: it replaces the model of
 * every job and tests one call of each. Local says why it cannot be chosen on a Mac that cannot run
 * it, and the recommended card carries a word as well as a colour.
 */
export function PresetChoice({
  t,
  label,
  cards,
  unset,
  stage,
  hardware,
  notice,
  onSelect,
  onConfirm,
  onCancel
}: PresetChoiceProps) {
  const group = useRef<HTMLDivElement>(null);
  const busy = stage.kind === "working";
  const tabbable =
    cards.find((card) => card.current && card.available) ?? cards.find((c) => c.available);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    const radios = [
      ...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])
    ].filter((radio) => radio.getAttribute("aria-disabled") !== "true");
    const at = radios.findIndex((radio) => radio === document.activeElement);
    if (at === -1) return;
    event.preventDefault();
    radios[(at + step + radios.length) % radios.length]?.focus();
  };

  return (
    <div className="grid w-full gap-3">
      <div
        ref={group}
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="grid w-full grid-cols-[repeat(auto-fit,minmax(9.25rem,1fr))] gap-2"
      >
        {cards.map((card) => (
          <SetupOption
            key={card.id}
            t={t}
            card={card}
            checked={card.current}
            tabbable={tabbable?.id === card.id}
            asked={stage.kind === "asking" && stage.setup === card.id}
            disabled={busy}
            onSelect={() => onSelect(card.id)}
          />
        ))}
      </div>

      {stage.kind === "asking" ? (
        <SetupConfirmation
          t={t}
          setup={stage.setup}
          warnWriter={setupNeedsWriterWarning(stage.setup, hardware)}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}

      {stage.kind === "working" ? (
        <StatusLine tone="working" live>
          {stage.phase === "applying" || stage.route === null
            ? t("settingsAi.status.applying", {
                values: { setup: t(setupNameKeys[stage.setup]) }
              })
            : t("settingsAi.status.testing", { values: { name: routeLabel(t, stage.route) } })}
        </StatusLine>
      ) : null}

      {stage.kind === "done" ? (
        <StatusLine tone="ok" live>
          {t("settingsAi.status.applied", { values: { setup: t(setupNameKeys[stage.setup]) } })}
        </StatusLine>
      ) : null}

      {stage.kind === "blocked" ? <BlockedBand t={t} stage={stage} /> : null}

      {unset && stage.kind === "idle" ? (
        <StatusLine tone="idle">{t("settingsAi.preset.unset")}</StatusLine>
      ) : null}

      <AreaNotice message={notice} />
    </div>
  );
}

function SetupOption({
  t,
  card,
  checked,
  tabbable,
  asked,
  disabled,
  onSelect
}: {
  t: Translator;
  card: SetupCard;
  checked: boolean;
  tabbable: boolean;
  /** The setup is waiting for its confirmation: it reads as pressed, not as chosen. */
  asked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const noteId = useId();
  const unavailable = !card.available;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={unavailable || disabled ? true : undefined}
      aria-describedby={noteId}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => {
        if (!unavailable && !disabled && !checked) onSelect();
      }}
      className={cn(
        "flex min-w-0 flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors [transition-duration:var(--motion-fast)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        checked
          ? "border-accent bg-surface-selected [box-shadow:inset_0_0_0_1px_var(--accent)]"
          : asked
            ? "border-accent bg-surface"
            : unavailable
              ? "border-dashed border-border bg-surface"
              : "border-border bg-surface hover:bg-surface-hover",
        unavailable || disabled ? "cursor-default" : "cursor-pointer"
      )}
    >
      <span className="flex w-full items-center gap-2 text-base font-semibold leading-5 text-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "relative size-4 shrink-0 rounded-full border-[1.5px]",
            checked ? "border-accent" : "border-border-strong"
          )}
        >
          {checked ? <span className="absolute inset-[3px] rounded-full bg-accent" /> : null}
        </span>
        <span className="min-w-0">{t(setupNameKeys[card.id])}</span>
      </span>
      <span id={noteId} className="grid gap-1">
        <span className="text-xs leading-4 text-secondary-foreground [text-wrap:pretty]">
          {t(setupHelpKeys[card.id])}
        </span>
        {card.note ? (
          <span
            className={cn(
              "text-xs leading-4 [text-wrap:pretty]",
              unavailable ? "text-warning" : "text-muted-foreground"
            )}
          >
            {t(card.note)}
          </span>
        ) : null}
        {card.estimateUsd !== null ? (
          <span className="text-xs leading-4 text-muted-foreground [text-wrap:pretty]">
            {t("settingsAi.preset.estimate", {
              values: { amount: formatUsd(t.locale, card.estimateUsd) }
            })}
          </span>
        ) : null}
      </span>
      {card.recommended ? (
        <span className="mt-1 inline-flex h-5 items-center gap-1 rounded-full border border-border bg-surface px-2 text-xs leading-none text-secondary-foreground">
          <Check aria-hidden="true" className="size-3 text-success" />
          {t("settingsAi.preset.recommended")}
        </span>
      ) : null}
    </button>
  );
}

function SetupConfirmation({
  t,
  setup,
  warnWriter,
  onConfirm,
  onCancel
}: {
  t: Translator;
  setup: AiPresetId;
  warnWriter: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="grid gap-2 rounded-lg border border-border-strong bg-soft p-3 text-sm outline-none"
    >
      <p id={headingId} className="m-0 font-semibold text-foreground">
        {t("settingsAi.confirm.title", { values: { setup: t(setupNameKeys[setup]) } })}
      </p>
      <p className="m-0 text-secondary-foreground [text-wrap:pretty]">
        {t("settingsAi.confirm.body")}
      </p>
      {warnWriter ? <StatusLine tone="warn">{t("settingsAi.confirm.bodyLocal")}</StatusLine> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onConfirm}>
          {t("settingsAi.confirm.apply")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Why a setup could not be applied: which job lacks which model, and what to do about it. */
function BlockedBand({
  t,
  stage
}: {
  t: Translator;
  stage: Extract<SetupStage, { kind: "blocked" }>;
}) {
  return (
    <div
      role="alert"
      className="grid gap-1 rounded-lg bg-warning-soft px-4 py-3 text-sm text-foreground"
    >
      <p className="m-0 flex items-start gap-2 font-semibold">
        <StatusLine tone="warn" className="text-sm font-semibold leading-5 text-foreground">
          {t("settingsAi.blocked.title", { values: { setup: t(setupNameKeys[stage.setup]) } })}
        </StatusLine>
      </p>
      <ul className="m-0 grid list-disc gap-1 pl-9 text-secondary-foreground">
        {stage.blocked.map((entry, index) => (
          <li key={`${entry.route ?? "all"}-${index}`} className="[text-wrap:pretty]">
            {entry.reason === "local_requires_apple_silicon"
              ? t("settingsAi.blocked.localRequiresAppleSilicon")
              : t(
                  entry.reason === "model_missing"
                    ? "settingsAi.blocked.modelMissing"
                    : "settingsAi.blocked.noRemoteProfile",
                  {
                    values: {
                      name:
                        entry.route === null
                          ? t("settingsAi.blocked.thisJob")
                          : routeLabel(t, entry.route),
                      model: entry.modelName ?? ""
                    }
                  }
                )}
          </li>
        ))}
      </ul>
    </div>
  );
}
