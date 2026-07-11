import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Cpu,
  Download,
  FileInput,
  HardDriveDownload,
  KeyRound,
  Play,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react";

import type { MessageKey } from "@app/i18n";
import type { AiModelParameters, LocalModelView } from "../../shared/ipc";
import { AiParameterFields } from "./AiParameterFields";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function LocalModelsView({ t }: { t: (key: MessageKey) => string }) {
  const [models, setModels] = useState<LocalModelView[]>([]);
  const [runtime, setRuntime] = useState<"all" | "gguf" | "mlx">("all");
  const [family, setFamily] = useState("all");
  const [capability, setCapability] = useState<"all" | "generation" | "embedding">("all");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [acceptedLicenses, setAcceptedLicenses] = useState<Set<string>>(new Set());
  const [repositoryToken, setRepositoryToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [testOutput, setTestOutput] = useState("");
  const [testedModelId, setTestedModelId] = useState<string | null>(null);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);

  async function load() {
    const [nextModels, tokenConfigured] = await Promise.all([
      window.app.localModels.list(),
      window.app.localModels.hasRepositoryToken()
    ]);
    setModels(nextModels);
    setHasToken(tokenConfigured);
  }

  useEffect(() => {
    void load().catch(() => setStatus("errors.common.unknown"));
  }, []);

  useEffect(() => {
    if (!models.some((model) => model.status === "downloading" || model.status === "verifying")) return;
    const timer = window.setInterval(() => { void load(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [models]);

  const families = useMemo(() => [...new Set(models.map((model) => model.family))].sort(), [models]);
  const filtered = models.filter((model) =>
    (runtime === "all" || model.runtime === runtime)
    && (family === "all" || model.family === family)
    && (capability === "all" || (capability === "embedding"
      ? model.capabilities.includes("embedding")
      : model.capabilities.includes("text-generation")))
    && (!compatibleOnly || model.compatible)
  );

  async function run(action: () => Promise<unknown>, success: MessageKey = "shell.states.saved") {
    setStatus("shell.states.loading");
    try {
      await action();
      setStatus(success);
      await load();
    } catch (error) {
      const key = error instanceof Error && error.message.startsWith("errors.")
        ? error.message.split(":")[0]
        : "errors.common.unknown";
      setStatus(key as MessageKey);
    }
  }

  async function saveToken() {
    if (!repositoryToken) return;
    await run(async () => {
      await window.app.localModels.setRepositoryToken(repositoryToken);
      setRepositoryToken("");
      setHasToken(true);
    });
  }

  async function testModel(model: LocalModelView) {
    setTestedModelId(model.id);
    setTestingModelId(model.id);
    setTestOutput("");
    try {
      await run(async () => {
        setTestOutput(await window.app.localModels.test(model.catalogId));
      }, "localModels.testSucceeded");
    } finally {
      setTestingModelId(null);
    }
  }

  return (
    <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2">
        <Cpu className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("localModels.title")}</h2>
      </div>
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900 md:grid-cols-[1fr_auto]">
        <div className="grid gap-2">
          <Label htmlFor="repositoryToken">
            <span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden="true" />{t("localModels.repositoryToken")}</span>
          </Label>
          <Input
            id="repositoryToken"
            type="password"
            value={repositoryToken}
            placeholder={hasToken ? t("localModels.tokenConfigured") : t("localModels.tokenOptional")}
            onChange={(event) => setRepositoryToken(event.target.value)}
          />
        </div>
        <Button type="button" className="self-end" disabled={!repositoryToken} onClick={() => void saveToken()}>
          {t("localModels.saveToken")}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-5">
        <select aria-label={t("localModels.filters.runtime")} value={runtime} onChange={(event) => setRuntime(event.target.value as typeof runtime)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("localModels.filters.allRuntimes")}</option>
          <option value="mlx">MLX</option>
          <option value="gguf">GGUF</option>
        </select>
        <select aria-label={t("localModels.filters.family")} value={family} onChange={(event) => setFamily(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("localModels.filters.allFamilies")}</option>
          {families.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select aria-label={t("localModels.filters.capability")} value={capability} onChange={(event) => setCapability(event.target.value as typeof capability)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("localModels.filters.allCapabilities")}</option>
          <option value="generation">{t("localModels.filters.generation")}</option>
          <option value="embedding">{t("localModels.filters.embedding")}</option>
        </select>
        <label className="flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm dark:border-slate-700">
          <input type="checkbox" checked={compatibleOnly} onChange={(event) => setCompatibleOnly(event.target.checked)} />
          {t("localModels.filters.compatibleOnly")}
        </label>
        <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" onClick={() => void run(() => window.app.localModels.importGguf())}>
          <FileInput className="h-4 w-4" aria-hidden="true" />{t("localModels.actions.importGguf")}
        </Button>
      </div>
      <div className="grid gap-3">
        {filtered.map((model) => {
          const active = model.status === "downloading" || model.status === "verifying";
          const progress = model.download && model.download.totalBytes > 0
            ? Math.min(100, Math.round(model.download.downloadedBytes / model.download.totalBytes * 100))
            : 0;
          const licenseAccepted = model.licenseAccepted || acceptedLicenses.has(model.catalogId);
          return (
            <details key={model.id} open={active} className="group overflow-hidden rounded-xl border border-slate-200 bg-slate-50/60 open:ring-2 open:ring-emerald-100 dark:border-slate-800 dark:bg-slate-900/50 dark:open:ring-emerald-950">
              <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 p-4">
                <div className="grid gap-1">
                  <h3 className="font-medium">{model.displayName}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {model.runtime.toUpperCase()} · {model.quantization} · {formatBytes(model.expectedSizeBytes)} · {model.revision.slice(0, 12)}
                  </p>
                  <p className={model.compatible ? "text-xs text-emerald-700 dark:text-emerald-300" : "text-xs text-amber-700 dark:text-amber-300"}>
                    {t(`localModels.compatibility.${model.compatibilityReason}` as MessageKey)}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-slate-900">
                    {model.status === "ready" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <HardDriveDownload className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t(`localModels.status.${model.status}` as MessageKey)}
                  </span>
                  <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
                </span>
              </summary>
              <div className="grid gap-3 border-t border-slate-200 p-4 dark:border-slate-800">
                <p className="text-xs text-slate-600 dark:text-slate-300">{model.capabilities.join(" · ")}</p>
                <LocalModelDefaults model={model} t={t} onSave={(parameters) => run(() => window.app.localModels.setDefaults(model.id, parameters))} />
                {model.requiresLicenseAcceptance && !model.licenseAccepted ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={acceptedLicenses.has(model.catalogId)}
                      onChange={(event) => setAcceptedLicenses((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(model.catalogId); else next.delete(model.catalogId);
                        return next;
                      })}
                    />
                    <span>{t("localModels.licenseAccept")} <a className="text-cyan-700 underline dark:text-cyan-300" href={model.licenseUrl} target="_blank" rel="noreferrer">{model.licenseName}</a></span>
                  </label>
                ) : null}
                {active && model.download ? (
                  <div className="grid gap-2">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className="h-full bg-cyan-600" style={{ width: `${progress}%` }} /></div>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      {model.download.currentFile ?? t("localModels.progress.verifying")} · {formatBytes(model.download.downloadedBytes)} / {formatBytes(model.download.totalBytes)} · {formatBytes(model.download.bytesPerSecond)}/s · {formatEta(model.download.etaSeconds, t)}
                    </p>
                  </div>
                ) : null}
                {model.lastError ? <p className="text-sm text-rose-700 dark:text-rose-300">{translateError(model.lastError, t)}</p> : null}
                {model.profilesUsing.length > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">{t("localModels.profileUsage")}: {model.profilesUsing.join(", ")}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                  {model.status === "not_downloaded" ? <Button type="button" disabled={!model.compatible || (model.requiresLicenseAcceptance && !licenseAccepted)} onClick={() => void run(() => window.app.localModels.download({ catalogId: model.catalogId, acceptLicense: licenseAccepted }))}><Download className="h-4 w-4" aria-hidden="true" />{t("localModels.actions.download")}</Button> : null}
                  {active ? <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" onClick={() => void run(() => window.app.localModels.cancel(model.catalogId))}><CircleStop className="h-4 w-4" aria-hidden="true" />{t("shell.actions.cancel")}</Button> : null}
                  {model.status === "failed" ? <Button type="button" onClick={() => void run(() => window.app.localModels.resume(model.catalogId))}><RefreshCw className="h-4 w-4" aria-hidden="true" />{t("localModels.actions.resume")}</Button> : null}
                  {model.status === "ready" ? <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={testingModelId !== null} onClick={() => void testModel(model)}>{testingModelId === model.id ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{t(testingModelId === model.id ? "shell.states.loading" : "localModels.actions.test")}</Button> : null}
                  {model.status === "ready" ? <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={model.profilesUsing.length > 0} onClick={() => {
                    if (window.confirm(t("localModels.removeConfirmation"))) void run(() => window.app.localModels.remove(model.catalogId));
                  }}><Trash2 className="h-4 w-4" aria-hidden="true" />{t("localModels.actions.remove")}</Button> : null}
                </div>
                {testedModelId === model.id ? (
                  <div className="grid gap-2" role="status">
                    {testOutput ? <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{testOutput}</pre> : null}
                    <p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p>
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
      {filtered.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">{t("localModels.empty")}</p> : null}
      <p className="text-sm text-slate-600 dark:text-slate-300" role="status">{t(status)}</p>
    </section>
  );
}

function LocalModelDefaults({ model, t, onSave }: { model: LocalModelView; t: (key: MessageKey) => string; onSave: (parameters: AiModelParameters) => Promise<unknown> }) {
  const [parameters, setParameters] = useState(model.defaultParameters);
  return <div className="grid gap-3 rounded-md bg-slate-50 p-3 dark:bg-slate-900"><p className="text-sm font-medium">{t("localModels.defaultParameters")}</p><AiParameterFields value={parameters} onChange={setParameters} t={t} embeddingOnly={model.capabilities.includes("embedding")} /><div className="flex justify-end"><Button type="button" onClick={() => void onSave(parameters)}><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveDefaults")}</Button></div></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1_024;
    unit = candidate;
    if (value < 1_024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatEta(seconds: number | null, t: (key: MessageKey) => string): string {
  if (seconds === null) return t("localModels.progress.etaUnknown");
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

function translateError(error: string, t: (key: MessageKey) => string): string {
  return error.startsWith("errors.") ? t(error.split(":")[0] as MessageKey) : t("errors.common.unknown");
}
