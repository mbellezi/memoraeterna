import { useId } from "react";
import { remoteGenerationContextWindow } from "@app/domain";
import type { MessageKey } from "@app/i18n";
import type { AiModelParameterCapabilities, AiModelParameters } from "../../shared/ipc";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AiParameterFieldsProps {
  value: AiModelParameters;
  onChange: (value: AiModelParameters) => void;
  capabilities: AiModelParameterCapabilities;
  t: (key: MessageKey) => string;
  embeddingOnly?: boolean;
  remote?: boolean;
  planningContext?: boolean;
  inheritedContextWindow?: number | undefined;
}

export function AiParameterFields({ value, onChange, capabilities, t, embeddingOnly = false, remote = false, planningContext = false, inheritedContextWindow }: AiParameterFieldsProps) {
  const contextId=useId(),contextHelpId=contextId+"-help",requestedContext=value.contextWindow??inheritedContextWindow??(remote?remoteGenerationContextWindow:undefined),effectiveContext=requestedContext===undefined?undefined:Math.min(requestedContext,capabilities.contextWindow?.max??2_000_000);
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
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
      {capabilities.contextWindow ? <div className="grid min-w-0 gap-1">
        <Label htmlFor={contextId}>{t("settings.ai.parameters.contextWindow")}</Label>
        <Input id={contextId} aria-describedby={remote||planningContext?contextHelpId:undefined} placeholder={(remote||planningContext)&&effectiveContext!==undefined?String(effectiveContext):undefined} type="number" {...rangeProps(capabilities.contextWindow)} value={value.contextWindow ?? ""} onChange={(event) => numberValue("contextWindow", event.target.value)} />
        {remote||planningContext?<p id={contextHelpId} className="text-xs text-slate-500">{t(remote?"settings.ai.parameters.contextPlanning":"settings.ai.parameters.contextPlanningLocal")} {t(value.contextWindow===undefined?"settings.ai.parameters.contextInherited":"settings.ai.parameters.contextEffective")} {effectiveContext===undefined?t("settings.ai.parameters.contextWorkflowDefault"):String(effectiveContext)}</p>:null}
      </div> : null}
      {embeddingOnly ? (
        capabilities.dimensions ? <div className="grid min-w-0 gap-1">
          <Label>{t("settings.ai.parameters.dimensions")}</Label>
          <select value={value.dimensions ?? ""} onChange={(event) => numberValue("dimensions", event.target.value)} className="h-9 min-w-0 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
            <option value="">{t("settings.ai.parameters.inherit")}</option>
            {capabilities.dimensions.values.map((dimension) => <option key={dimension} value={dimension}>{dimension}</option>)}
          </select>
        </div> : null
      ) : (
        <>
          {capabilities.temperature ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.temperature")}</Label>
            <Input type="number" {...rangeProps(capabilities.temperature)} value={value.temperature ?? ""} onChange={(event) => numberValue("temperature", event.target.value)} />
          </div> : null}
          {capabilities.maxTokens ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.maxTokens")}</Label>
            <Input type="number" {...rangeProps(capabilities.maxTokens)} value={value.maxTokens ?? ""} onChange={(event) => numberValue("maxTokens", event.target.value)} />
          </div> : null}
          {capabilities.reasoning ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.reasoningLevel")}</Label>
            <select value={value.reasoningLevel ?? ""} onChange={(event) => reasoningValue(event.target.value)} className="h-9 min-w-0 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
              <option value="">{t("settings.ai.parameters.inherit")}</option>
              {capabilities.reasoning.levels.map((level) => <option key={level} value={level}>{t(`settings.ai.parameters.reasoning.${level}` as MessageKey)}</option>)}
            </select>
          </div> : null}
          {capabilities.reasoning?.maxTokens ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.reasoningMaxTokens")}</Label>
            <Input
              type="number"
              {...rangeProps(capabilities.reasoning.maxTokens)}
              disabled={value.reasoningLevel === "off"}
              value={value.reasoningMaxTokens ?? ""}
              onChange={(event) => numberValue("reasoningMaxTokens", event.target.value)}
            />
          </div> : null}
          {capabilities.topP ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.topP")}</Label>
            <Input type="number" {...rangeProps(capabilities.topP)} value={value.topP ?? ""} onChange={(event) => numberValue("topP", event.target.value)} />
          </div> : null}
          {capabilities.topK ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.topK")}</Label>
            <Input type="number" {...rangeProps(capabilities.topK)} value={value.topK ?? ""} onChange={(event) => numberValue("topK", event.target.value)} />
          </div> : null}
          {capabilities.presencePenalty ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.presencePenalty")}</Label>
            <Input type="number" {...rangeProps(capabilities.presencePenalty)} value={value.presencePenalty ?? ""} onChange={(event) => numberValue("presencePenalty", event.target.value)} />
          </div> : null}
          {capabilities.seed ? <div className="grid min-w-0 gap-1">
            <Label>{t("settings.ai.parameters.seed")}</Label>
            <Input type="number" {...rangeProps(capabilities.seed)} value={value.seed ?? ""} onChange={(event) => numberValue("seed", event.target.value)} />
          </div> : null}
        </>
      )}
    </div>
  );
}

function rangeProps(range: { min: number; max?: number | undefined; step?: number | undefined }) {
  return {
    min: range.min,
    ...(range.max !== undefined ? { max: range.max } : {}),
    ...(range.step !== undefined ? { step: range.step } : {})
  };
}
