import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { Tabs } from "./ui/tabs";
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
  const [addingProfile, setAddingProfile] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
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
  const [profileModel, setProfileModel] = useState("");
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
      setAddingModel(false);
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
    const selectedRemote = providers.find((model) => `remote:${model.id}` === profileModel && profilePrivacy !== "offline_only");
    const selectedLocal = localModels.find((model) => `local:${model.id}` === profileModel);
    if (!profileName || (!selectedRemote && !selectedLocal)) { onToast("errors.common.missingConfiguration", "error"); return; }
    await run(async () => {
      const profile = await window.app.ai.createProfile({
        name: profileName,
        isDefault: profiles.length === 0,
        privacyMode: profilePrivacy,
        outputLanguage: profileLanguage
      });
      const model = selectedRemote ?? selectedLocal!;
      await window.app.ai.updateProfile({ id: profile.id,
        modelId: model.modelId, capabilities: model.capabilities,
        ...(selectedRemote ? { providerConfigId: selectedRemote.id, runtime: "remote" as const }
          : { localModelId: selectedLocal!.id, runtime: selectedLocal!.runtime })
      });
      setSelectedProfileId(profile.id);
      setProfileName("");
      setAddingProfile(false);
    });
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const remoteEmbeddingModels = providers.filter((item) => item.capabilities.includes("embedding"));
  const remoteGenerationModels = providers.filter((item) => !item.capabilities.includes("embedding"));

  return (
    <section className="@container grid min-w-0 gap-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("settings.ai.title")}</h2>
      </div>

      <p className="text-sm text-slate-500">{t("sourceWorkspace.profileHint")}</p>
      <Tabs label={t("settings.ai.title")} value={activeScope} onChange={setActiveScope} items={[
        { id: "providers", label: t("settings.ai.sections.providers") },
        { id: "profiles", label: t("settings.ai.sections.profiles") },
        { id: "routing", label: t("settings.ai.sections.routing") }
      ]} actions={activeScope !== "routing" ? <Button type="button"
        className="h-8 gap-1 px-2 text-xs"
        aria-label={t(activeScope === "providers" ? "settings.ai.remoteModels" : "settings.ai.createProfile")}
        title={t(activeScope === "providers" ? "settings.ai.remoteModels" : "settings.ai.createProfile")}
        onClick={() => activeScope === "providers" ? setAddingModel(true) : setAddingProfile(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        <span className="hidden @4xl:inline">{t(activeScope === "providers" ? "settings.ai.remoteModels" : "settings.ai.createProfile")}</span>
      </Button> : null}>

      {activeScope === "providers" ? <>
        {addingModel ? <CreationDialog titleId="add-model-title" onClose={() => setAddingModel(false)}>
        <form className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900" onSubmit={saveProvider}>
          <h3 id="add-model-title" className="font-medium">{t("settings.ai.remoteModels")}</h3>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field label={t("settings.ai.provider")}><select value={provider} disabled={connectingOpenAiCodex} onChange={(event) => changeProvider(event.target.value as typeof provider)} className={selectClass}><option value="google">{t("settings.ai.google")}</option><option value="openai-compatible">{t("settings.ai.openAiCompatible")}</option><option value="openai-codex">{t("settings.ai.openAiCodex")}</option></select></Field>
            <Field label={t("settings.ai.modelPurpose")}><select value={modelPurpose} onChange={(event) => setModelPurpose(event.target.value as ModelPurpose)} className={selectClass}><option value="generation">{t("settings.ai.purposes.generation")}</option><option value="embedding" disabled={provider === "openai-codex"}>{t("settings.ai.purposes.embedding")}</option><option value="reranking">{t("settings.ai.purposes.reranking")}</option></select></Field>
            <Field label={t("settings.ai.displayName")}><Input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
            <Field label={t("settings.ai.baseUrl")}><Input type="url" disabled={provider === "openai-codex"} value={provider === "openai-codex" ? "https://chatgpt.com/backend-api/codex" : baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setAvailableModels([]); }} /></Field>
            <Field label={t("settings.ai.model")}><div className="grid gap-1"><div className="flex flex-col gap-2"><Input required list="remote-model-options" autoComplete="off" value={modelId} onChange={(event) => setModelId(event.target.value)} /><datalist id="remote-model-options">{availableModels.map((model) => <option key={model} value={model} />)}</datalist>{provider !== "openai-codex" ? <Button type="button" className="shrink-0 bg-white px-3 text-slate-800 dark:bg-slate-950 dark:text-slate-100" disabled={!apiKey.trim() || discoveringModels} onClick={() => void discoverModels()}>{discoveringModels ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.loadModels")}</Button> : null}</div>{provider === "openai-codex" ? <p className="text-xs text-slate-500">{t("settings.ai.oauth.modelSelectionHint")}</p> : null}</div></Field>
            {provider === "openai-codex" ? <Field label={t("settings.ai.oauth.authentication")}><div className="grid gap-1"><div className="flex items-center gap-2"><Button type="button" disabled={connectingOpenAiCodex} onClick={() => void connectOpenAiCodex()}>{connectingOpenAiCodex ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}{t("settings.ai.oauth.connect")}</Button>{openAiCodexConnected ? <span className="text-xs text-emerald-700 dark:text-emerald-300">{t("settings.ai.oauth.connected")}</span> : null}</div><p className="text-xs text-slate-500">{t("settings.ai.oauth.description")}</p></div></Field> : <Field label={t("settings.ai.apiKey")}><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></Field>}
          </div>
          <details><summary className="cursor-pointer text-sm font-medium">{t("sourceWorkspace.modelDefaults")}</summary><div className="mt-3"><AiParameterFields value={modelDefaults} onChange={setModelDefaults} capabilities={modelParameterCapabilities} t={t} embeddingOnly={modelPurpose === "embedding"} /></div></details>
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" onClick={() => setAddingModel(false)}>{t("shell.actions.cancel")}</Button><Button type="submit"><Save className="h-4 w-4" aria-hidden="true" />{t("settings.ai.saveModel")}</Button></div>
        </form>
        </CreationDialog> : null}

        <ModelGroup title={t("settings.ai.embeddingModels")} models={remoteEmbeddingModels} t={t} onSave={(model, defaults, displayName, nextModelId) => run(() => saveRemoteModel(model, defaults, displayName, nextModelId))} onDelete={(model) => run(() => window.app.ai.deleteProvider(model.id))} onReconnect={(model) => run(() => reconnectOpenAiCodexModel(model))} />
        <ModelGroup title={t("settings.ai.generationModels")} models={remoteGenerationModels} t={t} onSave={(model, defaults, displayName, nextModelId) => run(() => saveRemoteModel(model, defaults, displayName, nextModelId))} onDelete={(model) => run(() => window.app.ai.deleteProvider(model.id))} onReconnect={(model) => run(() => reconnectOpenAiCodexModel(model))} />
      </> : null}

      {activeScope === "profiles" ? <div className="grid min-w-0 gap-4">
        {addingProfile ? <CreationDialog titleId="create-profile-title" onClose={() => setAddingProfile(false)}>
        <form className="grid min-w-0 gap-4 p-4" onSubmit={(event) => { event.preventDefault(); void createProfile(); }}>
          <h3 id="create-profile-title" className="font-medium">{t("settings.ai.createProfile")}</h3>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Input aria-label={t("settings.ai.profileName")} value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={t("settings.ai.profileName")} />
          <select value={profilePrivacy} onChange={(event) => setProfilePrivacy(event.target.value as typeof profilePrivacy)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select>
          <LanguageSelect value={profileLanguage} onChange={setProfileLanguage} t={t} interfaceLanguage={interfaceLanguage} />
          <select aria-label={t("settings.ai.model")} value={profileModel} onChange={(event) => setProfileModel(event.target.value)} className={selectClass}><option value="">{t("settings.ai.selectModel")}</option>{providers.filter(() => profilePrivacy !== "offline_only").map((model) => <option key={model.id} value={`remote:${model.id}`}>{model.displayName}</option>)}{localModels.map((model) => <option key={model.id} value={`local:${model.id}`}>{model.displayName}</option>)}</select>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" onClick={() => setAddingProfile(false)}>{t("shell.actions.cancel")}</Button>
            <Button type="submit" disabled={!profileName.trim() || !profileModel}><Plus className="h-4 w-4" aria-hidden="true" />{t("settings.ai.createProfile")}</Button>
          </div>
        </form>
        </CreationDialog> : null}
        <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <div className="grid min-w-0 content-start gap-2 @xl:grid-cols-2 @5xl:grid-cols-1">
            {profiles.map((profile) => <div key={profile.id} className="flex min-w-0 items-stretch gap-2"><button type="button" onClick={() => setSelectedProfileId(profile.id)} className={profile.id === selectedProfileId ? "min-w-0 flex-1 rounded-lg border border-cyan-500 bg-cyan-50 px-3 py-2 text-left text-sm dark:bg-cyan-950" : "min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm dark:border-slate-800"}><span className="block truncate">{profile.name}</span><span className="block truncate text-xs text-slate-500">{profile.modelId ?? t("settings.ai.selectModel")}</span></button><Button type="button" aria-label={t("sourceWorkspace.duplicateProfile")} onClick={() => void run(() => window.app.ai.cloneProfile(profile.id, `${profile.name} 2`))}><Copy className="h-4 w-4" aria-hidden="true" /></Button></div>)}
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
      </Tabs>
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

function CreationDialog({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={dialogRef} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-xl bg-white p-0 text-slate-950 backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-slate-50">
    {children}
  </dialog>;
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
  onSave: (update: { name: string; privacyMode: "allow_remote" | "offline_only"; outputLanguage: AiOutputLanguage; providerConfigId?: string; localModelId?: string; modelId: string; runtime: "remote" | "gguf" | "mlx"; capabilities: AiCapability[] }, tasks: AiProfileTaskInput[]) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [name, setName] = useState(profile.name);
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
          name, privacyMode,
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
        <Input aria-label={t("settings.ai.profileName")} value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 basis-60" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" disabled={!selected || saving || !name.trim()} onClick={() => void saveProfile()}>
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
            {t("settings.ai.saveProfile")}
          </Button>
          <Button type="button" className="border-red-700 bg-red-700 hover:bg-red-800 dark:border-red-700 dark:bg-red-700 dark:hover:bg-red-800" disabled={saving} onClick={onRemove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t("settings.ai.removeProfile")}
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-3 @xl:grid-cols-2">
        <select value={privacyMode} onChange={(event) => setPrivacyMode(event.target.value as typeof privacyMode)} className={selectClass}><option value="allow_remote">{t("settings.ai.privacy.allowRemote")}</option><option value="offline_only">{t("settings.ai.privacy.offlineOnly")}</option></select>
        <LanguageSelect value={outputLanguage} onChange={setOutputLanguage} t={t} interfaceLanguage={interfaceLanguage} />
        <select aria-label={t("settings.ai.model")} value={selection} onChange={(event) => setSelection(event.target.value)} className="h-9 min-w-0 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 @xl:col-span-2"><option value="">{t("settings.ai.selectModel")}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
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
  const overrides = Object.keys(parameters).length;
  return <details className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{t(`settings.ai.tasks.${definition.task}` as MessageKey)}</span><span className="text-xs text-slate-500">{overrides ? t("sourceWorkspace.customizeTask") : t("sourceWorkspace.modelDefaults")}{overrides ? ` (${overrides})` : ""}</span></summary>
    <div className="mt-4 grid gap-3"><AiParameterFields value={parameters} onChange={onChange} capabilities={parameterCapabilities} t={t} embeddingOnly={definition.task === "embedding"} />
      <Button type="button" className="w-fit" disabled={!overrides} onClick={() => onChange({})}>{t("sourceWorkspace.resetTask")}</Button></div>
  </details>;
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
  return <div className="grid min-w-0 gap-1"><Label>{label}</Label>{children}</div>;
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

const selectClass = "h-9 min-w-0 w-full rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950";
