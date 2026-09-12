import { useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { MatchingConfigurationSchema, recommendedMatchingConfiguration, recommendedMatchingPresetId } from "@app/domain";
import type { MessageKey } from "@app/i18n";
import type { AppSettings, AppSettingsUpdate } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function MatchingPresetControls({ settings, onChange, t }: {
  settings: AppSettings; onChange: (update: AppSettingsUpdate) => void; t: (key: MessageKey) => string;
}) {
  const [editor, setEditor] = useState<{ mode: "create" | "duplicate" | "rename"; name: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const label = (key: string) => t(`settings.matching.presets.${key}` as MessageKey);
  const selected = settings.matchingPresets.find((preset) => preset.id === settings.activeMatchingPresetId);
  const selectedName = selected ? selected.name ?? label("previous") : label("recommended");
  const save = () => {
    const name = editor?.name.trim();
    if (!editor || !name || name.length > 100) { setInvalid(true); return; }
    const id = editor.mode === "rename" ? selected?.id : crypto.randomUUID();
    if (!id) return;
    const configuration = editor.mode === "create"
      ? recommendedMatchingConfiguration
      : MatchingConfigurationSchema.parse(settings);
    const presets = editor.mode !== "rename"
      ? [...settings.matchingPresets, { id, name, settings: configuration }]
      : settings.matchingPresets.map((preset) => preset.id === id ? { ...preset, name, settings: configuration } : preset);
    onChange({ ...configuration, matchingPresets: presets, activeMatchingPresetId: id });
    setEditor(null); setInvalid(false);
  };
  return <div className="grid min-w-0 gap-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
    <label className="grid gap-2 text-sm font-medium" htmlFor="matching-preset">
      {label("title")}
      <select id="matching-preset" className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
        value={settings.activeMatchingPresetId ?? recommendedMatchingPresetId}
        onChange={(event) => {
          const id = event.currentTarget.value;
          const configuration = id === recommendedMatchingPresetId ? recommendedMatchingConfiguration : settings.matchingPresets.find((preset) => preset.id === id)?.settings;
          if (configuration) onChange({ ...configuration, matchingPresets: settings.matchingPresets, activeMatchingPresetId: id });
          setEditor(null); setInvalid(false);
        }}>
        <option value={recommendedMatchingPresetId}>{label("recommended")}</option>
        {settings.matchingPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name ?? label("previous")}</option>)}
      </select>
    </label>
    <p className="text-xs leading-5 text-slate-600 dark:text-slate-400">{label(selected ? "customHint" : "recommendedHint")}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={settings.matchingPresets.length >= 50} onClick={() => { setEditor({ mode: "create", name: "" }); setInvalid(false); }}>
        <Plus className="mr-2 h-4 w-4" aria-hidden="true" />{label("create")}
      </Button>
      <Button disabled={settings.matchingPresets.length >= 50} onClick={() => { setEditor({ mode: "duplicate", name: `${selectedName} (${label("copy")})`.slice(0,100) }); setInvalid(false); }}>
        <Copy className="mr-2 h-4 w-4" aria-hidden="true" />{label("duplicate")}
      </Button>
      {selected && <Button onClick={() => { setEditor({ mode: "rename", name: selectedName }); setInvalid(false); }}>
        <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />{label("rename")}
      </Button>}
      {selected && <Button variant="danger" onClick={() => {
        if (!window.confirm(label("deleteConfirm"))) return;
        onChange({ ...recommendedMatchingConfiguration,
          matchingPresets: settings.matchingPresets.filter((preset) => preset.id !== selected.id),
          activeMatchingPresetId: recommendedMatchingPresetId });
        setEditor(null); setInvalid(false);
      }}>
        <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />{label("delete")}
      </Button>}
    </div>
    {settings.matchingPresets.length >= 50 && <p className="text-xs text-amber-700 dark:text-amber-300">{label("limit")}</p>}
    {editor && <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label className="grid gap-1 text-xs" htmlFor="matching-preset-name">{label("name")}
        <Input id="matching-preset-name" autoFocus maxLength={100} value={editor.name} aria-invalid={invalid}
          onChange={(event) => { setEditor({ ...editor, name: event.target.value }); setInvalid(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditor(null); setInvalid(false); } }} />
      </label>
      {invalid && <p role="alert" className="text-xs text-red-600">{label("invalidName")}</p>}
      <div className="flex gap-2"><Button type="submit">{label("save")}</Button><Button type="button" onClick={() => { setEditor(null); setInvalid(false); }}>{label("cancel")}</Button></div>
    </form>}
  </div>;
}
