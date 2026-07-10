import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Bot, Copy, Plus, Save, TestTubeDiagonal, Trash2 } from "lucide-react";
import type { AiCapability } from "@app/domain";
import type { LanguageCode, MessageKey } from "@app/i18n";
import {
  appLanguageCodes,
  type AiConfigurableTask,
  type AiModelParameters,
  type AiOutputLanguage,
  type AiProfile,
  type AiProfileTask,
  type AiProfileTaskInput,
  type AiProviderConfig,
  type LocalModelView
} from "../../shared/ipc";
import { AiParameterFields } from "./AiParameterFields";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AiSettingsViewProps {
  t: (key: MessageKey) => string;
  interfaceLanguage?: LanguageCode;
}

type ModelPurpose = "generation" | "embedding" | "reranking";
type ModelOption = {
  value: string;
  label: string;
  modelId: string;
  runtime: "remote" | "gguf" | "mlx";
  providerConfigId?: string;
  localModelId?: string;
  capabilities: AiCapability[];
};

const taskDefinitions: Array<{ task: AiConfigurableTask; capabilities: AiCapability[] }> = [
  { task: "embedding", capabilities: ["embedding"] },
  { task: "summarization", capabilities: ["summarization"] },
  { task: "atomic-note-generation", capabilities: ["atomic-note-generation", "structured-output"] },
  { task: "reranking", capabilities: ["reranking"] },
  { task: "text-generation", capabilities: ["text-generation"] },
  { task: "structured-output", capabilities: ["structured-output"] }
];

const purposeCapabilities: Record<ModelPurpose, AiCapability[]> = {
  generation: ["text-generation", "structured-output", "summarization", "atomic-note-generation", "requires-network", "requires-api-key"],
  embedding: ["embedding", "requires-network", "requires-api-key"],
  reranking: ["reranking", "requires-network", "requires-api-key"]
};

export function AiSettingsView({ t, interfaceLanguage = "en" }: AiSettingsViewProps) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [profileTasks, setProfileTasks] = useState<AiProfileTask[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [localModels, setLocalModels] = useState<LocalModelView[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [provider, setProvider] = useState<"google" | "openai-compatible">("google");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelPurpose, setModelPurpose] = useState<ModelPurpose>("generation");
  const [modelDefaults, setModelDefaults] = useState<AiModelParameters>({});
  const [apiKey, setApiKey] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profilePrivacy, setProfilePrivacy] = useState<"allow_remote" | "offline_only">("allow_remote");
  const [profileLanguage, setProfileLanguage] = useState<AiOutputLanguage>("ui");
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");

  async function load() {
    const [nextProviders, nextProfiles, nextTasks, nextRoutes, nextLocalModels] = await Promise.all([
      window.app.ai.listProviders(),
      window.app.ai.listProfiles(),
      window.app.ai.listProfileTasks(),
      window.app.ai.listTaskRoutes(),
      window.app.localModels.list()
    ]);
    setProviders(nextProviders);
    setProfiles(nextProfiles);
    setProfileTasks(nextTasks);
    setRoutes(Object.fromEntries(nextRoutes.map((route) => [route.task, route.profileId])));
    setLocalModels(nextLocalModels.filter((model) => model.status === "ready"));
    setSelectedProfileId((current) => nextProfiles.some((profile) => profile.id === current)
      ? current
      : nextProfiles[0]?.id ?? "");
  }

  useEffect(() => { void load().catch(() => setStatus("errors.common.unknown")); }, []);

  async function run(action: () => Promise<unknown>) {
    setStatus("shell.states.loading");
    try {
      await action();
      await load();
      setStatus("shell.states.saved");
    } catch (error) {
      setStatus(error instanceof Error && error.message.startsWith("errors.")
        ? error.message.split(":")[0] as MessageKey
        : "errors.common.validationFailed");
    }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await window.app.ai.saveProvider({
        provider,
        displayName,
        modelId,
        capabilities: purposeCapabilities[modelPurpose],
        defaultParameters: modelDefaults,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {})
      });
      setDisplayName("");
      setModelId("");
      setApiKey("");
      setModelDefaults({});
    });
  }

  async function createProfile() {
    if (!profileName) { setStatus("errors.common.missingConfiguration"); return; }
    await run(async () => {
      const profile = await window.app.ai.createProfile({
        name: profileName,
        isDefault: profiles.length === 0,
        privacyMode: profilePrivacy,
        outputLanguage: profileLanguage
      });
      setSelectedProfileId(profile.id);
      setProfileName("");
    });
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const remoteEmbeddingModels = providers.filter((item) => item.capabilities.includes("embedding"));
  const remoteGenerationModels = providers.filter((item) => !item.capabilities.includes("embedding"));

  return (
    <section className="grid gap-6 rounded-md border border-slate-200 p-5 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("settings.ai.title")}</h2>
      </div>

      <form className="grid gap-4 rounded-md bg-slate-50 p-4 dark:bg-slate-900" onSubmit={saveProvider}>
        <h3 className="font-medium">{t("settings.ai.remoteModels")}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t("settings.ai.provider")}><select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} className={selectClass}><option value="google">{t("settings.ai.google")}</option><option value="openai-compatible">{t("settings.ai.openAiCompatible")}</option></select></Field>
          <Field label={t("settings.ai.modelPurpose")}><select value={modelPurpose} onChange={(event) => setModelPurpose(event.target.value as ModelPurpose)} className={selectClass}><option value="generation">{t("settings.ai.purposes.generation")}</option><option value="embedding">{t("settings.ai.purposes.embedding")}</option><option value="reranking">{t("settings.ai.purposes.reranking")}</option></select></Field>
          <Field label={t("settings.ai.displayName")}><Input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <Field label={t("settings.ai.baseUrl")}><Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field label={t("settings.ai.model")}><Input required value={modelId} onChange={(event) => setModelId(event.target.value)} /></Field>
          <Field label={t("settings.ai.apiKey")}><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></Field>
        </div>
        <AiParameterFields value={modelDefaults} onChange={setModelDefaults} t={t} embeddingOnly={modelPurpose === "embedding"} />
        <div className="flex justify-end"><Button type="submit"><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveModel")}</Button></div>
      </form>

      <ModelGroup title={t("settings.ai.embeddingModels")} models={remoteEmbeddingModels} t={t} onSave={(model, defaults) => run(() => saveRemoteModelDefaults(model, defaults))} />
      <ModelGroup title={t("settings.ai.generationModels")} models={remoteGenerationModels} t={t} onSave={(model, defaults) => run(() => saveRemoteModelDefaults(model, defaults))} />

      <div className="grid gap-4 border-t border-slate-200 pt-5 dark:border-slate-800">
        <h3 className="font-medium">{t("settings.ai.profiles")}</h3>
        <div className="grid gap-3 md:grid-cols-4">
          <Input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={t("settings.ai.profileName")} />
          <select value={profilePrivacy} onChange={(event) => setProfilePrivacy(event.target.value as typeof profilePrivacy)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select>
          <LanguageSelect value={profileLanguage} onChange={setProfileLanguage} t={t} interfaceLanguage={interfaceLanguage} />
          <Button type="button" onClick={() => void createProfile()}><Plus className="h-4 w-4" aria-hidden="true" />{t("settings.ai.createProfile")}</Button>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(14rem,0.4fr)_1fr]">
          <div className="grid content-start gap-2">
            {profiles.map((profile) => <button key={profile.id} type="button" onClick={() => setSelectedProfileId(profile.id)} className={profile.id === selectedProfileId ? "flex items-center justify-between rounded-md border border-cyan-500 bg-cyan-50 px-3 py-2 text-left text-sm dark:bg-cyan-950" : "flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm dark:border-slate-800"}><span>{profile.name}{profile.isDefault ? ` · ${t("settings.ai.defaultProfile")}` : ""}</span><Copy className="h-4 w-4" aria-hidden="true" onClick={(event) => { event.stopPropagation(); void run(() => window.app.ai.cloneProfile(profile.id, `${profile.name} 2`)); }} /></button>)}
          </div>
          {selectedProfile ? (
            <div className="grid gap-4 rounded-md border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex justify-end">
                <Button
                  type="button"
                  className="border-red-700 bg-red-700 hover:bg-red-800 dark:border-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                  onClick={() => {
                    if (!window.confirm(t("settings.ai.removeProfileConfirmation"))) return;
                    void run(async () => {
                      await window.app.ai.deleteProfile(selectedProfile.id);
                      setSelectedProfileId("");
                    });
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("settings.ai.removeProfile")}
                </Button>
              </div>
              <ProfileHeader profile={selectedProfile} providers={providers} localModels={localModels} t={t} interfaceLanguage={interfaceLanguage} onSave={(update) => run(() => window.app.ai.updateProfile({ id: selectedProfile.id, ...update }))} />
              {taskDefinitions.filter((definition) => supportsTask(selectedProfile, definition)).map((definition) => (
                <ProfileTaskEditor
                  key={`${selectedProfile.id}:${definition.task}`}
                  definition={definition}
                  profile={selectedProfile}
                  existing={profileTasks.find((item) => item.profileId === selectedProfile.id && item.task === definition.task)}
                  t={t}
                  onSave={(input) => run(() => window.app.ai.setProfileTask(input))}
                />
              ))}
            </div>
          ) : <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.noProfiles")}</p>}
        </div>
      </div>

      <div className="grid gap-3 border-t border-slate-200 pt-5 dark:border-slate-800">
        <h3 className="font-medium">{t("settings.ai.taskRouting")}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.taskRoutingDescription")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          {taskDefinitions.map(({ task }) => {
            const definition = taskDefinitions.find((candidate) => candidate.task === task)!;
            const eligibleProfiles = profiles.filter((profile) => supportsTask(profile, definition));
            return <Field key={task} label={t(`settings.ai.tasks.${task}` as MessageKey)}><select value={routes[task] ?? ""} disabled={eligibleProfiles.length === 0} onChange={(event) => void run(() => window.app.ai.setTaskRoute({ task, profileId: event.target.value }))} className={selectClass}><option value="">{t("settings.ai.selectProfile")}</option>{eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>;
          })}
        </div>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300" role="status">{t(status)}</p>
    </section>
  );

  function saveRemoteModelDefaults(model: AiProviderConfig, defaultParameters: AiModelParameters) {
    return window.app.ai.saveProvider({
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      capabilities: model.capabilities,
      defaultParameters
    });
  }
}

function ModelGroup({ title, models, t, onSave }: { title: string; models: AiProviderConfig[]; t: (key: MessageKey) => string; onSave: (model: AiProviderConfig, defaults: AiModelParameters) => Promise<unknown> }) {
  return <div className="grid gap-3"><h3 className="font-medium">{title}</h3>{models.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.noModels")}</p> : models.map((model) => <RemoteModelCard key={model.id} model={model} t={t} onSave={onSave} />)}</div>;
}

function RemoteModelCard({ model, t, onSave }: { model: AiProviderConfig; t: (key: MessageKey) => string; onSave: (model: AiProviderConfig, defaults: AiModelParameters) => Promise<unknown> }) {
  const [defaults, setDefaults] = useState(model.defaultParameters);
  const embeddingOnly = model.capabilities.includes("embedding");
  return <article className="grid gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-800"><div className="flex items-center justify-between gap-3"><div><p className="font-medium">{model.displayName}</p><p className="text-xs text-slate-500">{model.modelId} · {model.provider}</p></div><Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" onClick={() => void window.app.ai.testProvider(model.id)}><TestTubeDiagonal className="h-4 w-4" aria-hidden="true" />{t("settings.ai.test")}</Button></div><AiParameterFields value={defaults} onChange={setDefaults} t={t} embeddingOnly={embeddingOnly} /><div className="flex justify-end"><Button type="button" onClick={() => void onSave(model, defaults)}><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveDefaults")}</Button></div></article>;
}

function ProfileHeader({ profile, providers, localModels, t, interfaceLanguage, onSave }: { profile: AiProfile; providers: AiProviderConfig[]; localModels: LocalModelView[]; t: (key: MessageKey) => string; interfaceLanguage: LanguageCode; onSave: (update: { privacyMode: "allow_remote" | "offline_only"; outputLanguage: AiOutputLanguage; providerConfigId?: string; localModelId?: string; modelId: string; runtime: "remote" | "gguf" | "mlx"; capabilities: AiCapability[] }) => Promise<unknown> }) {
  const [privacyMode, setPrivacyMode] = useState(profile.privacyMode as "allow_remote" | "offline_only");
  const [outputLanguage, setOutputLanguage] = useState(profile.outputLanguage);
  const options = useMemo<ModelOption[]>(() => [
    ...providers.filter(() => privacyMode !== "offline_only").map((model) => ({ value: `remote:${model.id}`, label: `${model.displayName} · ${model.modelId}`, modelId: model.modelId, runtime: "remote" as const, providerConfigId: model.id, capabilities: model.capabilities })),
    ...localModels.map((model) => ({ value: `local:${model.id}`, label: `${model.displayName} · ${model.runtime.toUpperCase()}`, modelId: model.modelId, runtime: model.runtime, localModelId: model.id, capabilities: model.capabilities }))
  ], [localModels, privacyMode, providers]);
  const existingValue = profile.providerConfigId ? `remote:${profile.providerConfigId}` : profile.localModelId ? `local:${profile.localModelId}` : "";
  const [selection, setSelection] = useState(existingValue);
  useEffect(() => { setPrivacyMode(profile.privacyMode as typeof privacyMode); setOutputLanguage(profile.outputLanguage); setSelection(existingValue); }, [existingValue, profile.outputLanguage, profile.privacyMode]);
  const selected = options.find((option) => option.value === selection);
  return <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto]"><select value={privacyMode} onChange={(event) => setPrivacyMode(event.target.value as typeof privacyMode)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select><LanguageSelect value={outputLanguage} onChange={setOutputLanguage} t={t} interfaceLanguage={interfaceLanguage} /><select aria-label={t("settings.ai.model")} value={selection} onChange={(event) => setSelection(event.target.value)} className={selectClass}><option value="">{t("settings.ai.selectModel")}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Button type="button" disabled={!selected} onClick={() => selected && void onSave({ privacyMode, outputLanguage, modelId: selected.modelId, runtime: selected.runtime, capabilities: selected.capabilities, ...(selected.providerConfigId ? { providerConfigId: selected.providerConfigId } : {}), ...(selected.localModelId ? { localModelId: selected.localModelId } : {}) })}><Save className="h-4 w-4" aria-hidden="true" />{t("shell.actions.save")}</Button></div>;
}

function ProfileTaskEditor({ definition, profile, existing, t, onSave }: { definition: { task: AiConfigurableTask; capabilities: AiCapability[] }; profile: AiProfile; existing: AiProfileTask | undefined; t: (key: MessageKey) => string; onSave: (input: AiProfileTaskInput) => Promise<unknown> }) {
  const [parameters, setParameters] = useState<AiModelParameters>(existing?.parameters ?? {});
  useEffect(() => { setParameters(existing?.parameters ?? {}); }, [existing]);
  return <div className="grid gap-3 rounded-md bg-slate-50 p-3 dark:bg-slate-900"><div className="flex items-center justify-between gap-2"><Label>{t(`settings.ai.tasks.${definition.task}` as MessageKey)}</Label><Button type="button" onClick={() => void onSave({ profileId: profile.id, task: definition.task, parameters })}><Save className="h-4 w-4" aria-hidden="true" />{t("shell.actions.save")}</Button></div><AiParameterFields value={parameters} onChange={setParameters} t={t} embeddingOnly={definition.task === "embedding"} /></div>;
}

function supportsTask(profile: AiProfile, definition: { capabilities: AiCapability[] }): boolean {
  return Boolean(profile.modelId) && definition.capabilities.every((capability) => profile.capabilities.includes(capability));
}

function LanguageSelect({ value, onChange, t, interfaceLanguage }: { value: AiOutputLanguage; onChange: (value: AiOutputLanguage) => void; t: (key: MessageKey) => string; interfaceLanguage: LanguageCode }) {
  return <select aria-label={t("settings.ai.outputLanguage")} value={value} onChange={(event) => onChange(event.target.value as AiOutputLanguage)} className={selectClass}><option value="ui">{t("settings.ai.languages.interface")} ({t(`settings.language.languages.${interfaceLanguage}` as MessageKey)})</option>{appLanguageCodes.map((language) => <option key={language} value={language}>{t(`settings.language.languages.${language}` as MessageKey)}</option>)}</select>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1"><Label>{label}</Label>{children}</div>;
}

const selectClass = "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950";
