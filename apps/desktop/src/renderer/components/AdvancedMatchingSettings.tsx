import { useState } from "react";
import { recommendedMatchingConfiguration, type MatchingValueControlId } from "@app/domain";
import type { MessageKey } from "@app/i18n";
import type { AppSettings, AppSettingsUpdate } from "../../shared/ipc";
import { matchingControlDomIds } from "../../shared/settings-registry";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { MatchingResetButton } from "./MatchingResetButton";
import { CalibratedValue } from "./settings/CalibratedValue";

/**
 * The note, identity and source-evidence values of the matching group (F4 Q4: Settings › Knowledge
 * › Advanced › Matching settings). A value away from the calibrated set shows the calibrated one
 * beside it, in text.
 */
export function AdvancedMatchingSettings({
  settings,
  onChange,
  t,
  calibrated
}: {
  settings: AppSettings;
  onChange: (update: AppSettingsUpdate) => void;
  t: (key: MessageKey) => string;
  /** "Calibrated: …" for a control whose value differs from the calibrated set; else undefined. */
  calibrated: (id: MatchingValueControlId) => string | undefined;
}) {
  const notes = settings.atomicNoteMatchingSettings;
  const {
    atomicNoteMatchingSettings: defaultAtomicNoteMatchingSettings,
    canonicalMatchingSettings: defaultCanonicalMatchingSettings,
    sourceRelationSettings: defaultSourceRelationSettings
  } = recommendedMatchingConfiguration;
  const resetLabel = t("settings.matching.resetDefault");
  const label = (key: string) => t(`settings.matching.advanced.${key}` as MessageKey);
  return (
    <div className="grid min-w-0 gap-5">
      <p className="text-xs leading-5 text-muted-foreground">{label("hint")}</p>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 font-medium">{label("notes")}</legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <NumericSetting
            id={matchingControlDomIds["atomicNoteMatchingSettings.maxRerankOutputTokens"]}
            label={label("maxRerankOutputTokens")}
            value={notes.maxRerankOutputTokens}
            defaultValue={defaultAtomicNoteMatchingSettings.maxRerankOutputTokens}
            resetLabel={resetLabel}
            min={512}
            max={16384}
            calibratedText={calibrated("atomicNoteMatchingSettings.maxRerankOutputTokens")}
            onCommit={(value) =>
              onChange({ atomicNoteMatchingSettings: { ...notes, maxRerankOutputTokens: value } })
            }
          />
        </div>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 border-t border-border pt-4">
        <legend className="font-medium">{label("canonical")}</legend>
        <p className="text-xs leading-5 text-muted-foreground">{label("canonicalHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["relationTypeCandidateLimit", 1, 20],
              ["entityCandidateLimit", 1, 20],
              ["confirmationBatchSize", 1, 12],
              ["confirmationMaxCharacters", 2000, 24000]
            ] as const
          ).map(([key, min, max]) => (
            <NumericSetting
              key={key}
              id={matchingControlDomIds[`canonicalMatchingSettings.${key}`]}
              label={label(key)}
              min={min}
              max={max}
              value={settings.canonicalMatchingSettings[key]}
              defaultValue={defaultCanonicalMatchingSettings[key]}
              resetLabel={resetLabel}
              calibratedText={calibrated(`canonicalMatchingSettings.${key}`)}
              onCommit={(value) =>
                onChange({
                  canonicalMatchingSettings: {
                    ...settings.canonicalMatchingSettings,
                    [key]: value
                  }
                })
              }
            />
          ))}
        </div>
        <Button
          className="justify-self-start"
          onClick={() => onChange({ canonicalMatchingSettings: defaultCanonicalMatchingSettings })}
        >
          {label("resetCanonical")}
        </Button>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 border-t border-border pt-4">
        <legend className="font-medium">{label("sources")}</legend>
        <p className="text-xs leading-5 text-muted-foreground">{label("sourcesHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["evidenceChunksPerSource", 1, 12],
              ["evidenceMaxCharacters", 300, 6000],
              ["summaryMaxCharacters", 300, 6000],
              ["maxOutputTokens", 512, 16384]
            ] as const
          ).map(([key, min, max]) => (
            <NumericSetting
              key={key}
              id={matchingControlDomIds[`sourceRelationSettings.${key}`]}
              label={label(key)}
              min={min}
              max={max}
              value={settings.sourceRelationSettings[key]}
              defaultValue={defaultSourceRelationSettings[key]}
              resetLabel={resetLabel}
              calibratedText={calibrated(`sourceRelationSettings.${key}`)}
              onCommit={(value) =>
                onChange({
                  sourceRelationSettings: { ...settings.sourceRelationSettings, [key]: value }
                })
              }
            />
          ))}
        </div>
        <Button
          className="justify-self-start"
          onClick={() => {
            const {
              evidenceChunksPerSource,
              evidenceMaxCharacters,
              summaryMaxCharacters,
              maxOutputTokens
            } = defaultSourceRelationSettings;
            onChange({
              sourceRelationSettings: {
                ...settings.sourceRelationSettings,
                evidenceChunksPerSource,
                evidenceMaxCharacters,
                summaryMaxCharacters,
                maxOutputTokens
              }
            });
          }}
        >
          {label("resetSources")}
        </Button>
      </fieldset>
    </div>
  );
}

/** A whole-number matching value: edited as text, committed on blur or Enter, Escape cancels. */
export function NumericSetting({
  id,
  label,
  value,
  defaultValue,
  resetLabel,
  min,
  max,
  calibratedText,
  onCommit
}: {
  id: string;
  label: string;
  value: number;
  defaultValue: number;
  resetLabel: string;
  min: number;
  max: number;
  calibratedText?: string | undefined;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // A saved or restored value replaces the text being edited.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const commit = () => {
    const parsed = Number(draft);
    const next =
      draft.trim() && Number.isFinite(parsed)
        ? Math.max(min, Math.min(max, Math.floor(parsed)))
        : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className="grid min-w-0 gap-1 text-xs">
      <span className="flex items-center justify-between gap-2">
        <label htmlFor={id}>{label}</label>
        <MatchingResetButton
          label={`${label}: ${resetLabel}`}
          onReset={() => {
            setDraft(String(defaultValue));
            onCommit(defaultValue);
          }}
        />
      </span>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
      {calibratedText ? <CalibratedValue text={calibratedText} /> : null}
    </div>
  );
}
