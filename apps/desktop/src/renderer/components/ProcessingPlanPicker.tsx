import { Check, ChevronRight, Cloud, Search, Sparkles, WandSparkles } from "lucide-react";
import {
  ProcessingStages,
  processingStageDependencies,
  resolveProcessingPlan,
  type ProcessingPlanRequest,
  type ProcessingPreset,
  type ProcessingStage
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../lib/cn";

const presets: Array<{ id: Exclude<ProcessingPreset, "custom">; icon: typeof Search; tone: string }> = [
  { id: "import_only", icon: Check, tone: "emerald" },
  { id: "search_ready", icon: Search, tone: "cyan" },
  { id: "summary", icon: Sparkles, tone: "violet" },
  { id: "full_knowledge", icon: WandSparkles, tone: "amber" }
];

const optionalStages = ProcessingStages.filter((stage) =>
  !["conversion", "structureDetection", "structureReview", "materialization", "aggregateSummarization"].includes(stage)
);

export function defaultProcessingPlan(preset: ProcessingPreset = "import_only"): ProcessingPlanRequest {
  const resolved = resolveProcessingPlan({
    preset,
    requestedStages: [],
    scope: "source_only",
    targetSourceItemIds: [],
    forceRegeneration: false,
    previousArtifactPolicy: "reuse_valid"
  });
  return {
    preset: resolved.preset,
    requestedStages: resolved.requestedStages,
    scope: resolved.scope,
    targetSourceItemIds: resolved.targetSourceItemIds,
    forceRegeneration: resolved.forceRegeneration,
    previousArtifactPolicy: resolved.previousArtifactPolicy
  };
}

export function ProcessingPlanPicker({
  value,
  onChange,
  t,
  compact = false
}: {
  value: ProcessingPlanRequest;
  onChange: (value: ProcessingPlanRequest) => void;
  t: Translator;
  compact?: boolean;
}) {
  const resolved = resolveProcessingPlan(value);

  function choosePreset(preset: Exclude<ProcessingPreset, "custom">) {
    onChange(defaultProcessingPlan(preset));
  }

  function toggleStage(stage: ProcessingStage) {
    const selected = new Set(resolved.requestedStages);
    if (resolved.effectiveStages.includes(stage)) {
      selected.delete(stage);
      for (const candidate of ProcessingStages) {
        if (dependsOn(candidate, stage) && selected.has(candidate)) selected.delete(candidate);
      }
    } else {
      selected.add(stage);
    }
    onChange(resolveProcessingPlan({ ...value, preset: "custom", requestedStages: [...selected] }));
  }

  return <section className={cn("grid gap-4", compact && "gap-3")}>
    <div>
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-slate-950 dark:text-white">{t("processing.title")}</h3>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {t("processing.aiOptional")}
        </span>
      </div>
      <p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-400">{t("processing.description")}</p>
    </div>

    <div className={cn("grid gap-2", compact ? "sm:grid-cols-2" : "lg:grid-cols-4")}>
      {presets.map((preset) => {
        const Icon = preset.icon;
        const active = value.preset === preset.id;
        return <button
          key={preset.id}
          type="button"
          aria-pressed={active}
          onClick={() => choosePreset(preset.id)}
          className={cn(
            "group grid min-h-28 gap-2 rounded-xl border p-3 text-left transition",
            active
              ? "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-500/15 dark:border-cyan-500 dark:bg-cyan-950/40"
              : "border-slate-200 bg-white hover:border-cyan-300 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-cyan-800"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={cn("grid h-8 w-8 place-items-center rounded-lg", presetSurface(preset.tone))}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            {active ? <Check className="h-4 w-4 text-cyan-700 dark:text-cyan-300" aria-hidden="true" /> : null}
          </div>
          <div>
            <p className="text-sm font-semibold">{t(`processing.presets.${preset.id}.title` as MessageKey)}</p>
            <p className="mt-0.5 text-xs leading-4 text-slate-500 dark:text-slate-400">
              {t(`processing.presets.${preset.id}.description` as MessageKey)}
            </p>
          </div>
        </button>;
      })}
    </div>

    <details open={value.preset === "custom"} className="group rounded-xl border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/50">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
        <span>{t("processing.customize")}</span>
        <ChevronRight className="h-4 w-4 transition group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="grid gap-2 border-t border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2 lg:grid-cols-3">
        {optionalStages.map((stage) => {
          const checked = resolved.effectiveStages.includes(stage);
          const automatic = resolved.automaticallyIncludedStages.includes(stage);
          return <label key={stage} className="flex cursor-pointer items-start gap-3 rounded-lg border border-transparent p-2.5 hover:border-slate-200 hover:bg-white dark:hover:border-slate-700 dark:hover:bg-slate-950">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-600" checked={checked}
              onChange={() => toggleStage(stage)} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(`jobs.stages.${stage}` as MessageKey)}</span>
              {automatic ? <span className="text-xs text-cyan-700 dark:text-cyan-300">{t("processing.includedDependency")}</span> : null}
            </span>
          </label>;
        })}
      </div>
    </details>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
      <span>{t("processing.stageCount", { values: { count: resolved.effectiveStages.length } })}</span>
      {resolved.effectiveStages.some((stage) => ["embedding", "summarization", "atomicNotes", "knowledgeGraph", "atomicNoteMatching"].includes(stage))
        ? <span className="inline-flex items-center gap-1.5"><Cloud className="h-3.5 w-3.5" aria-hidden="true" />{t("processing.profileNotice")}</span>
        : <span>{t("processing.noAiNotice")}</span>}
    </div>
  </section>;
}

function dependsOn(stage: ProcessingStage, dependency: ProcessingStage, seen = new Set<ProcessingStage>()): boolean {
  if (seen.has(stage)) return false;
  seen.add(stage);
  return processingStageDependencies[stage].some((candidate) =>
    candidate === dependency || dependsOn(candidate, dependency, seen)
  );
}

function presetSurface(tone: string): string {
  return ({
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    cyan: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200",
    violet: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
  } as Record<string, string>)[tone] ?? "bg-slate-100 text-slate-800";
}
