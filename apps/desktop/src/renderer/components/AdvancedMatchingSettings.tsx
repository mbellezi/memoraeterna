import { useEffect, useState } from "react";
import { AtomicNoteMatchingSettingsSchema, defaultAtomicNoteMatchingSettings, defaultCanonicalMatchingSettings, defaultSourceRelationSettings } from "@app/domain";
import type { MessageKey } from "@app/i18n";
import type { AppSettings, AppSettingsUpdate } from "../../shared/ipc";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { MatchingSlider } from "./MatchingSlider";

export function AdvancedMatchingSettings({ settings, onChange, t }: {
  settings: AppSettings; onChange: (update: AppSettingsUpdate) => void; t: (key: MessageKey) => string;
}) {
  const notes = settings.atomicNoteMatchingSettings;
  const [invalidWeights, setInvalidWeights] = useState(false);
  const label = (key: string) => t(`settings.matching.advanced.${key}` as MessageKey);
  const updateNotes = (patch: Partial<typeof notes>) => {
    const result = AtomicNoteMatchingSettingsSchema.safeParse({ ...notes, ...patch });
    setInvalidWeights(!result.success);
    if (result.success) onChange({ atomicNoteMatchingSettings: result.data });
    return result.success;
  };
  return <details className="min-w-0 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
    <summary className="cursor-pointer text-sm font-semibold">{label("title")}</summary>
    <div className="mt-4 grid min-w-0 gap-5">
      <p className="text-xs leading-5 text-slate-500">{label("hint")}</p>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 font-medium">{label("notes")}</legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {([
            ["textCandidateLimit",1,200], ["vectorCandidateLimit",1,200], ["graphCandidateLimit",0,200],
            ["fusedCandidateLimit",1,100], ["minimumGraphOnlyCandidates",0,100], ["reciprocalRankConstant",1,200],
            ["maxRelationsPerNote",1,100], ["maxRerankOutputTokens",512,16384]
          ] as const).map(([key,min,max]) => <NumericSetting key={key} label={label(key)} value={notes[key]} min={min} max={max}
            onCommit={(value) => updateNotes({ [key]: value })} />)}
        </div>
        <MatchingSlider id="matching-minRerankScore" label={label("minRerankScore")} value={notes.minRerankScore}
          defaultValue={defaultAtomicNoteMatchingSettings.minRerankScore} resetLabel={t("settings.matching.resetDefault")}
          onCommit={(value) => updateNotes({ minRerankScore: value })} />
        <p className="text-xs leading-5 text-slate-500">{label("validationHint")}</p>
        {(["requireReranking", "includeWeakTypes"] as const).map((key) => <label key={key} className="flex items-center justify-between gap-3 text-sm">
          {label(key)}<Switch checked={notes[key]} onChange={(event) => updateNotes({ [key]: event.target.checked })} />
        </label>)}
        <Button className="justify-self-start" onClick={() => { setInvalidWeights(false); onChange({ atomicNoteMatchingSettings: defaultAtomicNoteMatchingSettings }); }}>{label("resetNotes")}</Button>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <legend className="font-medium">{label("weights")}</legend>
        <p className="text-xs leading-5 text-slate-500">{label("weightsHint")}</p>
        {invalidWeights && <p role="alert" className="text-sm text-red-600">{label("invalidWeights")}</p>}
        {(["withEmbeddingAndGraph", "withEmbedding", "withGraph", "textAndMetadata"] as const).map((group) => <div key={group} className="grid gap-2">
          <p className="text-xs font-medium">{label(group)}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(notes[group]).map(([key, value]) => <NumericSetting key={key} label={label(key)} value={value} min={0} max={1} step={0.01}
              onCommit={(next) => updateNotes({ [group]: { ...notes[group], [key]: next } })} />)}
          </div>
        </div>)}
        <NumericSetting label={label("rerankerWeight")} value={notes.rerankerWeight} min={0} max={1} step={0.01} onCommit={(value) => updateNotes({ rerankerWeight: value })} />
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <legend className="font-medium">{label("canonical")}</legend>
        <p className="text-xs leading-5 text-slate-500">{label("canonicalHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["relationTypeCandidateLimit",1,20], ["entityCandidateLimit",1,20], ["confirmationBatchSize",1,12], ["confirmationMaxCharacters",2000,24000]] as const).map(([key,min,max]) =>
            <NumericSetting key={key} label={label(key)} min={min} max={max} value={settings.canonicalMatchingSettings[key]}
              onCommit={(value) => onChange({ canonicalMatchingSettings: { ...settings.canonicalMatchingSettings, [key]: value } })} />)}
        </div>
        <Button className="justify-self-start" onClick={() => onChange({ canonicalMatchingSettings: defaultCanonicalMatchingSettings })}>{label("resetCanonical")}</Button>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <legend className="font-medium">{label("sources")}</legend>
        <p className="text-xs leading-5 text-slate-500">{label("sourcesHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["reciprocalRankConstant",1,200], ["evidenceChunksPerSource",1,12], ["evidenceMaxCharacters",300,6000], ["summaryMaxCharacters",300,6000], ["noteRelationsPerPair",0,30], ["maxOutputTokens",512,16384]] as const).map(([key,min,max]) =>
            <NumericSetting key={key} label={label(key)} min={min} max={max} value={settings.sourceRelationSettings[key]}
              onCommit={(value) => onChange({ sourceRelationSettings: { ...settings.sourceRelationSettings, [key]: value } })} />)}
        </div>
        <Button className="justify-self-start" onClick={() => {
          const { reciprocalRankConstant, evidenceChunksPerSource, evidenceMaxCharacters, summaryMaxCharacters, noteRelationsPerPair, maxOutputTokens } = defaultSourceRelationSettings;
          onChange({ sourceRelationSettings: { ...settings.sourceRelationSettings, reciprocalRankConstant, evidenceChunksPerSource, evidenceMaxCharacters, summaryMaxCharacters, noteRelationsPerPair, maxOutputTokens } });
        }}>{label("resetSources")}</Button>
      </fieldset>
    </div>
  </details>;
}

function NumericSetting({ label, value, min, max, step = 1, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; onCommit: (value: number) => boolean | void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    const next = draft.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, step === 1 ? Math.floor(parsed) : Math.round(parsed * 100) / 100)) : value;
    setDraft(String(next));
    if (next !== value && onCommit(next) === false) setDraft(String(value));
  };
  return <label className="grid min-w-0 gap-1 text-xs">{label}
    <Input type="number" min={min} max={max} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { event.preventDefault(); setDraft(String(value)); } }} />
  </label>;
}
