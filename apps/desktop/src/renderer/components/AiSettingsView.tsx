import { useEffect, useState, type FormEvent } from "react";
import { Bot, Copy, KeyRound, Plus, Save, TestTubeDiagonal } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { AiProfile, AiProviderConfig, LocalModelView } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function AiSettingsView({ t }: { t: (key: MessageKey) => string }) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelView[]>([]);
  const [provider, setProvider] = useState<"google" | "openai-compatible">("google");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("");
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");

  async function load() {
    const [nextProviders, nextProfiles, nextLocalModels] = await Promise.all([
      window.app.ai.listProviders(), window.app.ai.listProfiles(), window.app.localModels.list()
    ]);
    setProviders(nextProviders);
    setProfiles(nextProfiles);
    setLocalModels(nextLocalModels.filter((model) => model.status === "ready"));
    setProfileModel((current) => current || (nextProviders[0] ? `remote:${nextProviders[0].id}` : nextLocalModels.find((model) => model.status === "ready") ? `local:${nextLocalModels.find((model) => model.status === "ready")!.id}` : ""));
  }
  useEffect(() => { void load(); }, []);

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setStatus("shell.states.loading");
    try {
      await window.app.ai.saveProvider({
        provider, displayName, modelId, capabilities: [
          "text-generation", "structured-output", "summarization", "atomic-note-generation",
          "embedding", "reranking", "requires-network", "requires-api-key"
        ],
        ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {})
      });
      setApiKey("");
      setStatus("shell.states.saved");
      await load();
    } catch { setStatus("errors.common.validationFailed"); }
  }

  async function createProfile() {
    const [kind, id] = profileModel.split(":", 2);
    const selectedProvider = kind === "remote" ? providers.find((item) => item.id === id) : undefined;
    const selectedLocalModel = kind === "local" ? localModels.find((item) => item.id === id) : undefined;
    if ((!selectedProvider && !selectedLocalModel) || !profileName) { setStatus("errors.common.missingConfiguration"); return; }
    const profile = await window.app.ai.createProfile({
      name: profileName, isDefault: profiles.length === 0,
      privacyMode: selectedLocalModel ? "offline_only" : "allow_remote"
    });
    const capabilities = selectedLocalModel?.capabilities ?? selectedProvider!.capabilities;
    const target = selectedLocalModel
      ? { localModelId: selectedLocalModel.id, modelId: selectedLocalModel.modelId, runtime: selectedLocalModel.runtime }
      : { providerConfigId: selectedProvider!.id, modelId: selectedProvider!.modelId, runtime: "remote" as const };
    const tasks = [
      { task: "embedding" as const, requiredCapabilities: ["embedding" as const] },
      { task: "summarization" as const, requiredCapabilities: ["summarization" as const] },
      { task: "atomic-note-generation" as const, requiredCapabilities: ["atomic-note-generation" as const, "structured-output" as const] },
      { task: "reranking" as const, requiredCapabilities: ["reranking" as const] }
    ].filter((item) => item.requiredCapabilities.every((capability) => capabilities.includes(capability)));
    await Promise.all(tasks.map((item) => window.app.ai.setProfileTask({
      profileId: profile.id,
      ...item,
      ...target
    })));
    setProfileName("");
    setStatus("shell.states.saved");
    await load();
  }

  return <section className="grid gap-5 rounded-md border border-slate-200 p-5 dark:border-slate-800">
    <div className="flex items-center gap-2"><Bot className="h-5 w-5 text-violet-700 dark:text-violet-300" aria-hidden="true" /><h2 className="text-lg font-semibold">{t("settings.ai.title")}</h2></div>
    <form className="grid gap-4" onSubmit={saveProvider}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2"><Label htmlFor="provider">{t("settings.ai.provider")}</Label><select id="provider" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"><option value="google">{t("settings.ai.google")}</option><option value="openai-compatible">{t("settings.ai.openAiCompatible")}</option></select></div>
        <div className="grid gap-2"><Label htmlFor="providerName">{t("settings.ai.displayName")}</Label><Input id="providerName" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>
        <div className="grid gap-2"><Label htmlFor="baseUrl">{t("settings.ai.baseUrl")}</Label><Input id="baseUrl" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div>
        <div className="grid gap-2"><Label htmlFor="modelId">{t("settings.ai.model")}</Label><Input id="modelId" required value={modelId} onChange={(event) => setModelId(event.target.value)} /></div>
        <div className="grid gap-2 md:col-span-2"><Label htmlFor="apiKey"><span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden="true" />{t("settings.ai.apiKey")}</span></Label><Input id="apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      </div>
      <div className="flex justify-end"><Button type="submit"><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveProvider")}</Button></div>
    </form>
    <div className="grid gap-2">{providers.map((item) => <div key={item.id} className="flex items-center justify-between rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-900"><span>{item.displayName} · {item.modelId}</span><Button type="button" onClick={() => void window.app.ai.testProvider(item.id).then(() => setStatus("settings.ai.connectionOk")).catch(() => setStatus("errors.common.network"))}><TestTubeDiagonal className="h-4 w-4" aria-hidden="true" />{t("settings.ai.test")}</Button></div>)}</div>
    <div className="grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-800"><h3 className="font-medium">{t("settings.ai.profiles")}</h3><div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"><Input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={t("settings.ai.profileName")} /><select aria-label={t("settings.ai.model")} value={profileModel} onChange={(event) => setProfileModel(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"><option value="">{t("settings.ai.selectModel")}</option>{providers.map((item) => <option key={item.id} value={`remote:${item.id}`}>{item.displayName} · {item.modelId}</option>)}{localModels.map((item) => <option key={item.id} value={`local:${item.id}`}>{item.displayName} · {item.runtime.toUpperCase()}</option>)}</select><Button type="button" onClick={() => void createProfile()}><Plus className="h-4 w-4" aria-hidden="true" />{t("settings.ai.createProfile")}</Button></div>{profiles.map((profile) => <div key={profile.id} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"><span>{profile.name}{profile.isDefault ? ` · ${t("settings.ai.defaultProfile")}` : ""}</span><button type="button" title={t("settings.ai.cloneProfile")} onClick={() => void window.app.ai.cloneProfile(profile.id, `${profile.name} 2`).then(load)}><Copy className="h-4 w-4" aria-hidden="true" /></button></div>)}</div>
    <p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p>
  </section>;
}
