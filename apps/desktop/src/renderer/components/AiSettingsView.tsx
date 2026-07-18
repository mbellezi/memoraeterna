import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Bot, Copy, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, Route, Save, ServerCog, TestTubeDiagonal, Trash2, Users } from "lucide-react";
import { normalizeAiModelParameters, type AiCapability } from "@app/domain";
import type { LanguageCode, MessageKey } from "@app/i18n";
import {
  appLanguageCodes,
  type AiConfigurableTask,
  type AiModelParameterCapabilities,
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
import type { ToastTone } from "./ui/toast";

interface AiSettingsViewProps {
  t: (key: MessageKey) => string;
  interfaceLanguage?: LanguageCode;
  onToast?: (message: MessageKey, tone: ToastTone) => void;
}

type ModelPurpose = "generation" | "embedding" | "reranking";
type AiSettingsScope = "providers" | "profiles" | "routing";
type ModelOption = {
  value: string;
  label: string;
  modelId: string;
  runtime: "remote" | "gguf" | "mlx";
  providerConfigId?: string;
  localModelId?: string;
  capabilities: AiCapability[];
  parameterCapabilities: AiModelParameterCapabilities;
};

type ProfileTaskParameters = Partial<Record<AiConfigurableTask, AiModelParameters>>;

const taskDefinitions: Array<{ task: AiConfigurableTask; capabilities: AiCapability[] }> = [
  { task: "embedding", capabilities: ["embedding"] },
  { task: "summarization", capabilities: ["summarization"] },
  { task: "knowledge-graph-generation", capabilities: ["structured-output"] },
  { task: "atomic-note-generation", capabilities: ["atomic-note-generation", "structured-output"] },
  { task: "reranking", capabilities: ["reranking"] },
  { task: "text-generation", capabilities: ["text-generation"] },
  { task: "structured-output", capabilities: ["structured-output"] }
];

const purposeCapabilities: Record<ModelPurpose, AiCapability[]> = {
  generation: ["text-generation", "structured-output", "summarization", "knowledge-graph-generation", "atomic-note-generation", "reranking", "requires-network", "requires-api-key"],
  embedding: ["embedding", "requires-network", "requires-api-key"],
  reranking: ["reranking", "requires-network", "requires-api-key"]
};

export function AiSettingsView({ t, interfaceLanguage = "en", onToast = () => undefined }: AiSettingsViewProps) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [profileTasks, setProfileTasks] = useState<AiProfileTask[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [localModels, setLocalModels] = useState<LocalModelView[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [provider, setProvider] = useState<"google" | "openai-compatible" | "openai-codex">("google");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelPurpose, setModelPurpose] = useState<ModelPurpose>("generation");
  const [modelDefaults, setModelDefaults] = useState<AiModelParameters>({});
  const [modelParameterCapabilities, setModelParameterCapabilities] = useState<AiModelParameterCapabilities>({});
  const [apiKey, setApiKey] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [connectingOpenAiCodex, setConnectingOpenAiCodex] = useState(false);
  const [openAiCodexConnected, setOpenAiCodexConnected] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profilePrivacy, setProfilePrivacy] = useState<"allow_remote" | "offline_only">("allow_remote");
  const [profileLanguage, setProfileLanguage] = useState<AiOutputLanguage>("ui");
  const [activeScope, setActiveScope] = useState<AiSettingsScope>("providers");

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

  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) onToast("errors.common.unknown", "error");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!modelId.trim()) {
      setModelParameterCapabilities({});
      return;
    }
    let active = true;
    const capabilities = purposeCapabilities[modelPurpose].filter((capability) =>
      provider !== "openai-codex" || capability !== "requires-api-key");
    void window.app.ai.getParameterCapabilities({
      provider,
      modelId: modelId.trim(),
      capabilities,
      ...(validUrl(baseUrl) ? { baseUrl } : {})
    }).then((next) => {
      if (!active) return;
      setModelParameterCapabilities(next);
      setModelDefaults((current) => normalizeAiModelParameters(current, next));
    }).catch(() => {
      if (active) setModelParameterCapabilities({});
    });
    return () => { active = false; };
  }, [baseUrl, modelId, modelPurpose, provider]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
      onToast("shell.toasts.settingsSaved", "success");
      return true;
    } catch (error) {
      onToast(readErrorMessageKey(error, "errors.common.validationFailed"), "error");
      return false;
    }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await window.app.ai.saveProvider({
        provider,
        displayName,
        modelId,
        capabilities: purposeCapabilities[modelPurpose].filter((capability) =>
          provider !== "openai-codex" || capability !== "requires-api-key"),
        defaultParameters: normalizeAiModelParameters(modelDefaults, modelParameterCapabilities),
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {})
      });
      setDisplayName("");
      setModelId("");
      setApiKey("");
      setAvailableModels([]);
      setOpenAiCodexConnected(false);
      setModelDefaults({});
    });
  }

  async function discoverModels() {
    setDiscoveringModels(true);
    try {
      const models = await window.app.ai.discoverModels({
        provider,
        apiKey,
        ...(baseUrl ? { baseUrl } : {})
      });
      setAvailableModels(models);
      setModelId((current) => current || models[0] || "");
    } catch (error) {
      onToast(readErrorMessageKey(error, "errors.common.validationFailed"), "error");
    } finally {
      setDiscoveringModels(false);
    }
  }

  async function connectOpenAiCodex() {
    setConnectingOpenAiCodex(true);
    try {
      const models = await window.app.ai.connectOpenAiCodex();
      setAvailableModels(models);
      setModelId((current) => current || models[0] || "");
      setOpenAiCodexConnected(true);
    } catch (error) {
      setOpenAiCodexConnected(false);
      onToast(readErrorMessageKey(error, "errors.ai.oauthLoginFailed"), "error");
    } finally {
      setConnectingOpenAiCodex(false);
    }
  }

  function changeProvider(nextProvider: typeof provider) {
    if (provider === "openai-codex" && nextProvider !== "openai-codex" && openAiCodexConnected) {
      void window.app.ai.disconnectOpenAiCodex();
    }
    setProvider(nextProvider);
    setAvailableModels([]);
    setModelId("");
    setOpenAiCodexConnected(false);
    if (nextProvider === "openai-codex") {
      setBaseUrl("");
      setApiKey("");
      if (modelPurpose === "embedding") setModelPurpose("generation");
    }
  }

  async function createProfile() {
    if (!profileName) { onToast("errors.common.missingConfiguration", "error"); return; }
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
    <section className="grid gap-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("settings.ai.title")}</h2>
      </div>

      <div className="grid gap-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-900 sm:grid-cols-3" role="tablist" aria-label={t("settings.ai.title")}>
        {([
          { id: "providers", icon: ServerCog },
          { id: "profiles", icon: Users },
          { id: "routing", icon: Route }
        ] as const).map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeScope === id}
            className={activeScope === id
              ? "flex min-h-14 items-center gap-3 rounded-lg bg-white px-4 text-left text-slate-950 shadow-sm dark:bg-slate-800 dark:text-white"
              : "flex min-h-14 items-center gap-3 rounded-lg px-4 text-left text-slate-600 transition hover:bg-white/60 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-white"}
            onClick={() => setActiveScope(id)}
          >
            <Icon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
            <span>
              <span className="block text-sm font-semibold">{t(`settings.ai.sections.${id}` as MessageKey)}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t(`settings.ai.sections.${id}Description` as MessageKey)}</span>
            </span>
          </button>
        ))}
      </div>

      {activeScope === "providers" ? <>
        <form className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900" onSubmit={saveProvider}>
          <h3 className="font-medium">{t("settings.ai.remoteModels")}</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={t("settings.ai.provider")}><select value={provider} disabled={connectingOpenAiCodex} onChange={(event) => changeProvider(event.target.value as typeof provider)} className={selectClass}><option value="google">{t("settings.ai.google")}</option><option value="openai-compatible">{t("settings.ai.openAiCompatible")}</option><option value="openai-codex">{t("settings.ai.openAiCodex")}</option></select></Field>
            <Field label={t("settings.ai.modelPurpose")}><select value={modelPurpose} onChange={(event) => setModelPurpose(event.target.value as ModelPurpose)} className={selectClass}><option value="generation">{t("settings.ai.purposes.generation")}</option><option value="embedding" disabled={provider === "openai-codex"}>{t("settings.ai.purposes.embedding")}</option><option value="reranking">{t("settings.ai.purposes.reranking")}</option></select></Field>
            <Field label={t("settings.ai.displayName")}><Input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
            <Field label={t("settings.ai.baseUrl")}><Input type="url" disabled={provider === "openai-codex"} value={provider === "openai-codex" ? "https://chatgpt.com/backend-api/codex" : baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setAvailableModels([]); }} /></Field>
            <Field label={t("settings.ai.model")}><div className="grid gap-1"><div className="flex gap-2"><Input required list="remote-model-options" autoComplete="off" value={modelId} onChange={(event) => setModelId(event.target.value)} /><datalist id="remote-model-options">{availableModels.map((model) => <option key={model} value={model} />)}</datalist>{provider !== "openai-codex" ? <Button type="button" className="shrink-0 bg-white px-3 text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={!apiKey.trim() || discoveringModels} onClick={() => void discoverModels()}>{discoveringModels ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.loadModels")}</Button> : null}</div>{provider === "openai-codex" ? <p className="text-xs text-slate-500">{t("settings.ai.oauth.modelSelectionHint")}</p> : null}</div></Field>
            {provider === "openai-codex" ? <Field label={t("settings.ai.oauth.authentication")}><div className="grid gap-1"><div className="flex items-center gap-2"><Button type="button" disabled={connectingOpenAiCodex} onClick={() => void connectOpenAiCodex()}>{connectingOpenAiCodex ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.oauth.connect")}</Button>{openAiCodexConnected ? <span className="text-xs text-emerald-700 dark:text-emerald-300">{t("settings.ai.oauth.connected")}</span> : null}</div><p className="text-xs text-slate-500">{t("settings.ai.oauth.description")}</p></div></Field> : <Field label={t("settings.ai.apiKey")}><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></Field>}
          </div>
          <AiParameterFields value={modelDefaults} onChange={setModelDefaults} capabilities={modelParameterCapabilities} t={t} embeddingOnly={modelPurpose === "embedding"} />
          <div className="flex justify-end"><Button type="submit"><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveModel")}</Button></div>
        </form>

        <ModelGroup title={t("settings.ai.embeddingModels")} models={remoteEmbeddingModels} t={t} onSave={(model, defaults, displayName, nextModelId) => run(() => saveRemoteModel(model, defaults, displayName, nextModelId))} onDelete={(model) => run(() => window.app.ai.deleteProvider(model.id))} onReconnect={(model) => run(() => reconnectOpenAiCodexModel(model))} />
        <ModelGroup title={t("settings.ai.generationModels")} models={remoteGenerationModels} t={t} onSave={(model, defaults, displayName, nextModelId) => run(() => saveRemoteModel(model, defaults, displayName, nextModelId))} onDelete={(model) => run(() => window.app.ai.deleteProvider(model.id))} onReconnect={(model) => run(() => reconnectOpenAiCodexModel(model))} />
      </> : null}

      {activeScope === "profiles" ? <div className="grid gap-4">
        <h3 className="font-medium">{t("settings.ai.profiles")}</h3>
        <div className="grid gap-3 md:grid-cols-4">
          <Input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={t("settings.ai.profileName")} />
          <select value={profilePrivacy} onChange={(event) => setProfilePrivacy(event.target.value as typeof profilePrivacy)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select>
          <LanguageSelect value={profileLanguage} onChange={setProfileLanguage} t={t} interfaceLanguage={interfaceLanguage} />
          <Button type="button" onClick={() => void createProfile()}><Plus className="h-4 w-4" aria-hidden="true" />{t("settings.ai.createProfile")}</Button>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.28fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            {profiles.map((profile) => <button key={profile.id} type="button" onClick={() => setSelectedProfileId(profile.id)} className={profile.id === selectedProfileId ? "flex items-center justify-between rounded-md border border-cyan-500 bg-cyan-50 px-3 py-2 text-left text-sm dark:bg-cyan-950" : "flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm dark:border-slate-800"}><span>{profile.name}{profile.isDefault ? ` · ${t("settings.ai.defaultProfile")}` : ""}</span><Copy className="h-4 w-4" aria-hidden="true" onClick={(event) => { event.stopPropagation(); void run(() => window.app.ai.cloneProfile(profile.id, `${profile.name} 2`)); }} /></button>)}
          </div>
          {selectedProfile ? (
            <ProfileEditor
              key={selectedProfile.id}
              profile={selectedProfile}
              profileTasks={profileTasks}
              providers={providers}
              localModels={localModels}
              t={t}
              interfaceLanguage={interfaceLanguage}
              onSave={(update, tasks) => run(async () => {
                await window.app.ai.updateProfile({ id: selectedProfile.id, ...update });
                await Promise.all(tasks.map((task) => window.app.ai.setProfileTask(task)));
              })}
              onRemove={() => {
                if (!window.confirm(t("settings.ai.removeProfileConfirmation"))) return;
                void run(async () => {
                  await window.app.ai.deleteProfile(selectedProfile.id);
                  setSelectedProfileId("");
                });
              }}
            />
          ) : <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.noProfiles")}</p>}
        </div>
      </div> : null}

      {activeScope === "routing" ? <div className="grid gap-3">
        <h3 className="font-medium">{t("settings.ai.taskRouting")}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.taskRoutingDescription")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          {taskDefinitions.map(({ task }) => {
            const definition = taskDefinitions.find((candidate) => candidate.task === task)!;
            const eligibleProfiles = profiles.filter((profile) => supportsTask(profile, definition));
            return <Field key={task} label={t(`settings.ai.tasks.${task}` as MessageKey)}><select value={routes[task] ?? ""} disabled={eligibleProfiles.length === 0} onChange={(event) => void run(() => window.app.ai.setTaskRoute({ task, profileId: event.target.value }))} className={selectClass}><option value="">{t("settings.ai.selectProfile")}</option>{eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>;
          })}
        </div>
      </div> : null}
    </section>
  );

  function saveRemoteModel(
    model: AiProviderConfig,
    defaultParameters: AiModelParameters,
    displayName = model.displayName,
    nextModelId = model.modelId
  ) {
    return window.app.ai.saveProvider({
      id: model.id,
      provider: model.provider,
      displayName,
      baseUrl: model.baseUrl,
      modelId: nextModelId,
      capabilities: model.capabilities,
      defaultParameters
    });
  }

  async function reconnectOpenAiCodexModel(model: AiProviderConfig) {
    await window.app.ai.connectOpenAiCodex();
    await saveRemoteModel(model, model.defaultParameters);
  }
}

function ModelGroup({ title, models, t, onSave, onDelete, onReconnect }: { title: string; models: AiProviderConfig[]; t: (key: MessageKey) => string; onSave: (model: AiProviderConfig, defaults: AiModelParameters, displayName?: string, modelId?: string) => Promise<boolean>; onDelete: (model: AiProviderConfig) => Promise<boolean>; onReconnect: (model: AiProviderConfig) => Promise<unknown> }) {
  return <div className="grid gap-3"><h3 className="font-medium">{title}</h3>{models.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.ai.noModels")}</p> : models.map((model) => <RemoteModelCard key={model.id} model={model} t={t} onSave={onSave} onDelete={onDelete} onReconnect={onReconnect} />)}</div>;
}

function RemoteModelCard({ model, t, onSave, onDelete, onReconnect }: { model: AiProviderConfig; t: (key: MessageKey) => string; onSave: (model: AiProviderConfig, defaults: AiModelParameters, displayName?: string, modelId?: string) => Promise<boolean>; onDelete: (model: AiProviderConfig) => Promise<boolean>; onReconnect: (model: AiProviderConfig) => Promise<unknown> }) {
  const [defaults, setDefaults] = useState(model.defaultParameters);
  const [parameterCapabilities, setParameterCapabilities] = useState(model.parameterCapabilities);
  const [testStatus, setTestStatus] = useState<MessageKey | null>(null);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(model.displayName);
  const [editModelId, setEditModelId] = useState(model.modelId);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const embeddingOnly = model.capabilities.includes("embedding");
  const modelOptionsId = `remote-model-options-${model.id}`;
  useEffect(() => {
    setDefaults(model.defaultParameters);
    setParameterCapabilities(model.parameterCapabilities);
    setEditDisplayName(model.displayName);
    setEditModelId(model.modelId);
  }, [model.defaultParameters, model.displayName, model.modelId, model.parameterCapabilities]);

  useEffect(() => {
    if (!editing || !editModelId.trim()) return;
    let active = true;
    void window.app.ai.getParameterCapabilities({
      provider: model.provider,
      modelId: editModelId.trim(),
      baseUrl: model.baseUrl,
      capabilities: model.capabilities
    }).then((next) => {
      if (!active) return;
      setParameterCapabilities(next);
      setDefaults((current) => normalizeAiModelParameters(current, next));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [editModelId, editing, model.baseUrl, model.capabilities, model.provider]);

  async function testProvider() {
    setTesting(true);
    setTestStatus("shell.states.loading");
    setTestStatus(await resolveProviderTestStatus(() => window.app.ai.testProvider(model.id)));
    setTesting(false);
  }

  async function loadModelOptions() {
    setLoadingModels(true);
    try {
      setModelOptions(await window.app.ai.listModels(model.id));
    } catch (error) {
      setTestStatus(readErrorMessageKey(error, "errors.ai.connectionFailed"));
    } finally {
      setLoadingModels(false);
    }
  }

  function beginEdit() {
    setEditing(true);
    setEditDisplayName(model.displayName);
    setEditModelId(model.modelId);
    setParameterCapabilities(model.parameterCapabilities);
    void loadModelOptions();
  }

  function cancelEdit() {
    setEditing(false);
    setDefaults(model.defaultParameters);
    setParameterCapabilities(model.parameterCapabilities);
  }

  async function saveEdit() {
    const saved = await onSave(model, normalizeAiModelParameters(defaults, parameterCapabilities), editDisplayName.trim(), editModelId.trim());
    if (saved) setEditing(false);
  }

  async function deleteModel() {
    if (!window.confirm(t("settings.ai.deleteModelConfirmation"))) return;
    setDeleting(true);
    await onDelete(model);
    setDeleting(false);
  }

  return (
    <article className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{model.displayName}</p>
          <p className="text-xs text-slate-500">{model.modelId} · {model.provider}</p>
          {testStatus ? <p className={testStatus === "settings.ai.connectionOk" ? "mt-1 text-xs text-emerald-700 dark:text-emerald-300" : testStatus === "shell.states.loading" ? "mt-1 text-xs text-slate-500" : "mt-1 text-xs text-rose-700 dark:text-rose-300"} role="status">{t(testStatus)}</p> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {model.provider === "openai-codex" ? <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" onClick={() => void onReconnect(model)}><LogIn className="h-4 w-4" aria-hidden="true" />{t("settings.ai.oauth.reconnect")}</Button> : null}
          <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={testing} onClick={() => void testProvider()}>{testing ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <TestTubeDiagonal className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.test")}</Button>
          <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={editing} onClick={beginEdit}><Pencil className="h-4 w-4" aria-hidden="true" />{t("settings.ai.editModel")}</Button>
          <Button type="button" className="border-red-700 bg-red-700 hover:bg-red-800 dark:border-red-700 dark:bg-red-700 dark:hover:bg-red-800" disabled={deleting} onClick={() => void deleteModel()}>{deleting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.deleteModel")}</Button>
        </div>
      </div>
      {editing ? (
        <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950 md:grid-cols-2">
          <Field label={t("settings.ai.displayName")}><Input required value={editDisplayName} onChange={(event) => setEditDisplayName(event.target.value)} /></Field>
          <Field label={t("settings.ai.model")}>
            <div className="flex gap-2">
              <Input required list={modelOptionsId} autoComplete="off" value={editModelId} onChange={(event) => setEditModelId(event.target.value)} />
              <datalist id={modelOptionsId}>{modelOptions.map((modelId) => <option key={modelId} value={modelId} />)}</datalist>
              <Button type="button" className="shrink-0 bg-white px-3 text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={loadingModels} onClick={() => void loadModelOptions()}>{loadingModels ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.loadModels")}</Button>
            </div>
          </Field>
        </div>
      ) : null}
      <AiParameterFields value={defaults} onChange={setDefaults} capabilities={parameterCapabilities} t={t} embeddingOnly={embeddingOnly} />
      <div className="flex justify-end gap-2">
        {editing ? <Button type="button" className="bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100" onClick={cancelEdit}>{t("shell.actions.cancel")}</Button> : null}
        <Button type="button" disabled={editing && (!editDisplayName.trim() || !editModelId.trim())} onClick={() => void (editing ? saveEdit() : onSave(model, normalizeAiModelParameters(defaults, parameterCapabilities)))}><Save className="h-4 w-4" aria-hidden="true" />{t(editing ? "settings.ai.saveModelChanges" : "settings.ai.saveDefaults")}</Button>
      </div>
    </article>
  );
}

export function ProfileEditor({ profile, profileTasks, providers, localModels, t, interfaceLanguage, onSave, onRemove }: {
  profile: AiProfile;
  profileTasks: AiProfileTask[];
  providers: AiProviderConfig[];
  localModels: LocalModelView[];
  t: (key: MessageKey) => string;
  interfaceLanguage: LanguageCode;
  onSave: (update: { privacyMode: "allow_remote" | "offline_only"; outputLanguage: AiOutputLanguage; providerConfigId?: string; localModelId?: string; modelId: string; runtime: "remote" | "gguf" | "mlx"; capabilities: AiCapability[] }, tasks: AiProfileTaskInput[]) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [privacyMode, setPrivacyMode] = useState(profile.privacyMode as "allow_remote" | "offline_only");
  const [outputLanguage, setOutputLanguage] = useState(profile.outputLanguage);
  const [saving, setSaving] = useState(false);
  const options = useMemo<ModelOption[]>(() => [
    ...providers.filter(() => privacyMode !== "offline_only").map((model) => ({ value: `remote:${model.id}`, label: `${model.displayName} · ${model.modelId}`, modelId: model.modelId, runtime: "remote" as const, providerConfigId: model.id, capabilities: model.capabilities, parameterCapabilities: model.parameterCapabilities })),
    ...localModels.map((model) => ({ value: `local:${model.id}`, label: `${model.displayName} · ${model.runtime.toUpperCase()}`, modelId: model.modelId, runtime: model.runtime, localModelId: model.id, capabilities: model.capabilities, parameterCapabilities: model.parameterCapabilities }))
  ], [localModels, privacyMode, providers]);
  const existingValue = profile.providerConfigId ? `remote:${profile.providerConfigId}` : profile.localModelId ? `local:${profile.localModelId}` : "";
  const [selection, setSelection] = useState(existingValue);
  const [taskParameters, setTaskParameters] = useState<ProfileTaskParameters>(() => profileTaskParameters(profile.id, profileTasks));
  useEffect(() => {
    setPrivacyMode(profile.privacyMode as typeof privacyMode);
    setOutputLanguage(profile.outputLanguage);
    setSelection(existingValue);
    setTaskParameters(profileTaskParameters(profile.id, profileTasks));
  }, [existingValue, profile.id, profile.outputLanguage, profile.privacyMode, profileTasks]);
  const selected = options.find((option) => option.value === selection);

  const supportedTasks = selected
    ? taskDefinitions.filter((definition) => definition.capabilities.every((capability) => selected.capabilities.includes(capability)))
    : [];

  async function saveProfile() {
    if (!selected) return;
    setSaving(true);
    try {
      await onSave(
        {
          privacyMode,
          outputLanguage,
          modelId: selected.modelId,
          runtime: selected.runtime,
          capabilities: selected.capabilities,
          ...(selected.providerConfigId ? { providerConfigId: selected.providerConfigId } : {}),
          ...(selected.localModelId ? { localModelId: selected.localModelId } : {})
        },
        supportedTasks.map((definition) => ({
          profileId: profile.id,
          task: definition.task,
          parameters: normalizeAiModelParameters(taskParameters[definition.task] ?? {}, selected.parameterCapabilities)
        }))
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
        <p className="min-w-0 truncate font-semibold">{profile.name}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" disabled={!selected || saving} onClick={() => void saveProfile()}>
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
            {t("settings.ai.saveProfile")}
          </Button>
          <Button type="button" className="border-red-700 bg-red-700 hover:bg-red-800 dark:border-red-700 dark:bg-red-700 dark:hover:bg-red-800" disabled={saving} onClick={onRemove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t("settings.ai.removeProfile")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.5fr]">
        <select value={privacyMode} onChange={(event) => setPrivacyMode(event.target.value as typeof privacyMode)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select>
        <LanguageSelect value={outputLanguage} onChange={setOutputLanguage} t={t} interfaceLanguage={interfaceLanguage} />
        <select aria-label={t("settings.ai.model")} value={selection} onChange={(event) => setSelection(event.target.value)} className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 sm:col-span-2 xl:col-span-1"><option value="">{t("settings.ai.selectModel")}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      </div>

      <div className="grid gap-2">
        {supportedTasks.map((definition) => (
          <ProfileTaskEditor
            key={`${profile.id}:${definition.task}`}
            definition={definition}
            parameters={taskParameters[definition.task] ?? {}}
            parameterCapabilities={selected?.parameterCapabilities ?? {}}
            t={t}
            onChange={(parameters) => setTaskParameters((current) => ({ ...current, [definition.task]: parameters }))}
          />
        ))}
      </div>
    </div>
  );
}

function ProfileTaskEditor({ definition, parameters, parameterCapabilities, t, onChange }: { definition: { task: AiConfigurableTask; capabilities: AiCapability[] }; parameters: AiModelParameters; parameterCapabilities: AiModelParameterCapabilities; t: (key: MessageKey) => string; onChange: (parameters: AiModelParameters) => void }) {
  return <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950 md:grid-cols-[minmax(10rem,0.32fr)_minmax(0,1fr)] md:items-start"><Label className="pt-2">{t(`settings.ai.tasks.${definition.task}` as MessageKey)}</Label><AiParameterFields value={parameters} onChange={onChange} capabilities={parameterCapabilities} t={t} embeddingOnly={definition.task === "embedding"} /></div>;
}

function supportsTask(profile: AiProfile, definition: { capabilities: AiCapability[] }): boolean {
  return Boolean(profile.modelId) && definition.capabilities.every((capability) => profile.capabilities.includes(capability));
}

function profileTaskParameters(profileId: string, profileTasks: AiProfileTask[]): ProfileTaskParameters {
  return Object.fromEntries(profileTasks
    .filter((task) => task.profileId === profileId)
    .map((task) => [task.task, task.parameters])) as ProfileTaskParameters;
}

function validUrl(value: string): boolean {
  if (!value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function LanguageSelect({ value, onChange, t, interfaceLanguage }: { value: AiOutputLanguage; onChange: (value: AiOutputLanguage) => void; t: (key: MessageKey) => string; interfaceLanguage: LanguageCode }) {
  return <select aria-label={t("settings.ai.outputLanguage")} value={value} onChange={(event) => onChange(event.target.value as AiOutputLanguage)} className={selectClass}><option value="ui">{t("settings.ai.languages.interface")} ({t(`settings.language.languages.${interfaceLanguage}` as MessageKey)})</option>{appLanguageCodes.map((language) => <option key={language} value={language}>{t(`settings.language.languages.${language}` as MessageKey)}</option>)}</select>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1"><Label>{label}</Label>{children}</div>;
}

function readErrorMessageKey(error: unknown, fallback: MessageKey): MessageKey {
  const match = error instanceof Error ? error.message.match(/errors\.[a-zA-Z0-9_.-]+/) : null;
  return match?.[0] as MessageKey | undefined ?? fallback;
}

export async function resolveProviderTestStatus(action: () => Promise<unknown>): Promise<MessageKey> {
  try {
    await action();
    return "settings.ai.connectionOk";
  } catch (error) {
    return readErrorMessageKey(error, "errors.ai.connectionFailed");
  }
}

const selectClass = "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950";
