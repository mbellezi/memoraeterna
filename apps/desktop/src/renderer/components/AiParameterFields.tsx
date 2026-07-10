import type { MessageKey } from "@app/i18n";
import type { AiModelParameters } from "../../shared/ipc";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AiParameterFieldsProps {
  value: AiModelParameters;
  onChange: (value: AiModelParameters) => void;
  t: (key: MessageKey) => string;
  embeddingOnly?: boolean;
}

export function AiParameterFields({ value, onChange, t, embeddingOnly = false }: AiParameterFieldsProps) {
  function numberValue(key: keyof AiModelParameters, raw: string) {
    const next = { ...value };
    if (raw === "") delete next[key];
    else Object.assign(next, { [key]: Number(raw) });
    onChange(next);
  }

  function reasoningValue(raw: string) {
    const next = { ...value };
    if (raw) next.reasoningLevel = raw as NonNullable<AiModelParameters["reasoningLevel"]>;
    else delete next.reasoningLevel;
    onChange(next);
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="grid gap-1">
        <Label>{t("settings.ai.parameters.contextWindow")}</Label>
        <Input type="number" min={128} value={value.contextWindow ?? ""} onChange={(event) => numberValue("contextWindow", event.target.value)} />
      </div>
      {embeddingOnly ? (
        <div className="grid gap-1">
          <Label>{t("settings.ai.parameters.dimensions")}</Label>
          <select value={value.dimensions ?? ""} onChange={(event) => numberValue("dimensions", event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
            <option value="">{t("settings.ai.parameters.inherit")}</option>
            <option value="256">256</option>
            <option value="768">768</option>
          </select>
        </div>
      ) : (
        <>
          <div className="grid gap-1">
            <Label>{t("settings.ai.parameters.temperature")}</Label>
            <Input type="number" min={0} max={2} step={0.1} value={value.temperature ?? ""} onChange={(event) => numberValue("temperature", event.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label>{t("settings.ai.parameters.maxTokens")}</Label>
            <Input type="number" min={1} value={value.maxTokens ?? ""} onChange={(event) => numberValue("maxTokens", event.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label>{t("settings.ai.parameters.reasoningLevel")}</Label>
            <select value={value.reasoningLevel ?? ""} onChange={(event) => reasoningValue(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
              <option value="">{t("settings.ai.parameters.inherit")}</option>
              {(["off", "minimal", "low", "medium", "high"] as const).map((level) => <option key={level} value={level}>{t(`settings.ai.parameters.reasoning.${level}` as MessageKey)}</option>)}
            </select>
          </div>
          <div className="grid gap-1">
            <Label>{t("settings.ai.parameters.topP")}</Label>
            <Input type="number" min={0} max={1} step={0.05} value={value.topP ?? ""} onChange={(event) => numberValue("topP", event.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label>{t("settings.ai.parameters.seed")}</Label>
            <Input type="number" min={0} value={value.seed ?? ""} onChange={(event) => numberValue("seed", event.target.value)} />
          </div>
        </>
      )}
    </div>
  );
}
