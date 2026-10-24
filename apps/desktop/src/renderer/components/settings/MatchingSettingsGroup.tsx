import { useState } from "react";
import { Network, RotateCcw } from "lucide-react";
import { MatchingConfigurationSchema, type MatchingValueControlId } from "@app/domain";
import type { Translator } from "@app/i18n";
import type { AppSettings, AppSettingsUpdate } from "../../../shared/ipc";
import { defaultAppSettings } from "../../../shared/ipc";
import { matchingControlDomIds } from "../../../shared/settings-registry";
import { AdvancedMatchingSettings } from "../AdvancedMatchingSettings";
import { MatchingPresetControls } from "../MatchingPresetControls";
import { MatchingResetButton } from "../MatchingResetButton";
import { MatchingSlider } from "../MatchingSlider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { CalibratedValue } from "./CalibratedValue";
import { matchingGroupModel, restoreCalibratedUpdate } from "./matching-group-model";

/** The matching preset selector's DOM id (the registry's `matching-preset`). */
const presetSelectId = "matching-preset";

/**
 * Settings › Knowledge › Advanced › Matching settings (F4 Q4): the 17 matching controls and the
 * saved presets, at the recommended values F3's bars were measured under. A saved value applies to
 * new decisions only; when any value differs from the calibrated set the group says so, offers to
 * restore it and shows the calibrated value beside each differing control, in text.
 */
export function MatchingSettingsGroup({
  appSettings,
  t,
  onChange: saveSettings
}: {
  appSettings: AppSettings;
  t: Translator;
  onChange: (update: AppSettingsUpdate) => void;
}) {
  const model = matchingGroupModel(appSettings, t);
  const { calibratedText } = model;
  const onChange = (update: AppSettingsUpdate) => {
    if (model.isRecommended) return;
    const configuration = MatchingConfigurationSchema.parse({ ...appSettings, ...update });
    saveSettings({
      ...configuration,
      activeMatchingPresetId: appSettings.activeMatchingPresetId,
      matchingPresets: appSettings.matchingPresets.map((preset) =>
        preset.id === appSettings.activeMatchingPresetId
          ? { ...preset, settings: configuration }
          : preset
      )
    });
  };
  const restore = () => {
    saveSettings(restoreCalibratedUpdate(appSettings));
    // The button leaves with the notice: focus goes to the selector that now reads "recommended".
    queueMicrotask(() => document.getElementById(presetSelectId)?.focus());
  };
  const settings = appSettings.sourceRelationSettings;
  const resetSource = (key: keyof typeof settings) => () =>
    onChange({
      sourceRelationSettings: {
        ...settings,
        [key]: defaultAppSettings.sourceRelationSettings[key]
      }
    });
  const resetLabel = t("settings.matching.resetDefault");
  /** "Calibrated: 0.92" for a control whose value differs from the calibrated set. */
  const calibratedFor = (id: MatchingValueControlId): string | undefined => {
    const text = calibratedText.get(id);
    return text === undefined
      ? undefined
      : t("settings.matching.calibration.calibrated", { values: { value: text } });
  };
  return (
    <section
      aria-labelledby="matching-group-title"
      className="grid content-start gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-soft text-accent">
          <Network className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 id="matching-group-title" className="font-semibold text-foreground">
            {t("settings.matching.title")}
          </h3>
          <p className="mt-1 text-sm leading-5 text-secondary-foreground">
            {t("settings.matching.description")}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.matching.groupHint")}
          </p>
        </div>
      </div>
      <div role="status" className="grid gap-2 empty:hidden">
        {model.differences.length > 0 ? (
          <div className="grid gap-2 rounded-lg border border-border-strong bg-warning-soft p-3">
            <p className="flex items-start gap-2 text-sm text-foreground">
              <span className="min-w-0">
                {t("settings.matching.calibration.notice")}{" "}
                <span className="text-secondary-foreground">
                  {t("settings.matching.calibration.count", {
                    values: {
                      count: new Intl.NumberFormat(t.locale).format(model.differences.length)
                    }
                  })}
                </span>
              </span>
            </p>
            <Button type="button" className="w-fit" onClick={restore}>
              <RotateCcw aria-hidden="true" />
              {t("settings.matching.calibration.restore")}
            </Button>
          </div>
        ) : null}
      </div>
      <MatchingPresetControls settings={appSettings} onChange={saveSettings} t={t} />
      <fieldset
        key={appSettings.activeMatchingPresetId}
        disabled={model.isRecommended}
        className="grid min-w-0 gap-5"
      >
        <div className="grid gap-2">
          <MatchingSlider
            id={matchingControlDomIds.relationTypeSimilarityThreshold}
            label={t("relationTypes.threshold")}
            defaultValue={defaultAppSettings.relationTypeSimilarityThreshold}
            resetLabel={resetLabel}
            value={appSettings.relationTypeSimilarityThreshold}
            calibratedText={calibratedFor("relationTypeSimilarityThreshold")}
            onCommit={(value) => onChange({ relationTypeSimilarityThreshold: value })}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {t("relationTypes.thresholdHint")}
          </p>
        </div>
        <div className="grid gap-2">
          <MatchingSlider
            id={matchingControlDomIds.entityIdentitySimilarityThreshold}
            label={t("entityIdentity.threshold")}
            defaultValue={defaultAppSettings.entityIdentitySimilarityThreshold}
            resetLabel={resetLabel}
            value={appSettings.entityIdentitySimilarityThreshold}
            calibratedText={calibratedFor("entityIdentitySimilarityThreshold")}
            onCommit={(value) => onChange({ entityIdentitySimilarityThreshold: value })}
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("entityIdentity.hint")}</p>
        </div>
        <AdvancedMatchingSettings
          settings={appSettings}
          onChange={onChange}
          t={t}
          calibrated={calibratedFor}
        />
        <div className="grid min-w-0 gap-4 border-t border-border pt-4">
          <div>
            <h4 className="font-semibold">{t("sourceRelations.title")}</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("sourceRelations.budgetHint")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["maxRelationsPerPair", 1, 20],
                ["maxInputTokens", 2000, 200000]
              ] as const
            ).map(([key, min, max]) => (
              <div key={key} className="grid gap-1 text-xs">
                <span className="flex items-center justify-between gap-2">
                  <label htmlFor={matchingControlDomIds[`sourceRelationSettings.${key}`]}>
                    {t(`sourceRelations.${key}`)}
                  </label>
                  <MatchingResetButton
                    label={`${t(`sourceRelations.${key}`)}: ${resetLabel}`}
                    onReset={resetSource(key)}
                  />
                </span>
                <SourceRelationLimitInput
                  id={matchingControlDomIds[`sourceRelationSettings.${key}`]}
                  min={min}
                  max={max}
                  value={settings[key]}
                  onCommit={(value) =>
                    onChange({ sourceRelationSettings: { ...settings, [key]: value } })
                  }
                />
                {calibratedFor(`sourceRelationSettings.${key}`) ? (
                  <CalibratedValue text={calibratedFor(`sourceRelationSettings.${key}`)!} />
                ) : null}
              </div>
            ))}
          </div>
          {(["minImportance", "minConfidence"] as const).map((key) => (
            <MatchingSlider
              key={key}
              id={matchingControlDomIds[`sourceRelationSettings.${key}`]}
              label={t(`sourceRelations.${key}`)}
              value={settings[key]}
              defaultValue={defaultAppSettings.sourceRelationSettings[key]}
              resetLabel={resetLabel}
              calibratedText={calibratedFor(`sourceRelationSettings.${key}`)}
              onCommit={(value) =>
                onChange({ sourceRelationSettings: { ...settings, [key]: value } })
              }
            />
          ))}
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <label htmlFor={matchingControlDomIds["sourceRelationSettings.includeWeakTypes"]}>
                {t("sourceRelations.includeWeakTypes")}
              </label>
              <span className="flex items-center gap-2">
                <MatchingResetButton
                  label={`${t("sourceRelations.includeWeakTypes")}: ${resetLabel}`}
                  onReset={resetSource("includeWeakTypes")}
                />
                <Switch
                  id={matchingControlDomIds["sourceRelationSettings.includeWeakTypes"]}
                  checked={settings.includeWeakTypes}
                  onChange={(event) =>
                    onChange({
                      sourceRelationSettings: {
                        ...settings,
                        includeWeakTypes: event.target.checked
                      }
                    })
                  }
                />
              </span>
            </div>
            {calibratedFor("sourceRelationSettings.includeWeakTypes") ? (
              <CalibratedValue text={calibratedFor("sourceRelationSettings.includeWeakTypes")!} />
            ) : null}
          </div>
        </div>
      </fieldset>
    </section>
  );
}

/** A whole-number source limit: edited as text, committed on blur or Enter, Escape cancels. */
function SourceRelationLimitInput({
  id,
  value,
  min,
  max,
  onCommit
}: {
  id: string;
  value: number;
  min: number;
  max: number;
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
    const number = Number(draft);
    const next =
      draft.trim() && Number.isFinite(number)
        ? Math.max(min, Math.min(max, Math.floor(number)))
        : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={1}
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
  );
}
