import { useId, useMemo, useState } from "react";
import { normalizeAiModelParameters, supportsTask, type AiCapability } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type {
  AiConfigurableTask,
  AiModelParameterCapabilities,
  AiModelParameters,
  AiProfile,
  AiProfileTask,
  AiProviderConfig,
  LocalModelView
} from "../../../../shared/ipc";
import { AiParameterFields } from "../../../components/AiParameterFields";
import { Button } from "../../../components/ui/button";
import { InlineAction } from "../../InlineAction";
import type { AiSettingsController } from "./ai-controller";
import { AreaNotice, Field, NativeSelect, TextField } from "./ai-parts";

/** The tasks a profile can be configured for; which model serves which is `supportsTask`. */
const taskDefinitions: ReadonlyArray<{ task: AiConfigurableTask; label: MessageKey }> = [
  { task: "embedding", label: "settingsAi.profiles.task.embedding" },
  { task: "summarization", label: "settingsAi.profiles.task.summarization" },
  {
    task: "knowledge-graph-generation",
    label: "settingsAi.profiles.task.knowledge-graph-generation"
  },
  { task: "atomic-note-generation", label: "settingsAi.profiles.task.atomic-note-generation" },
  { task: "reranking", label: "settingsAi.profiles.task.reranking" },
  { task: "text-generation", label: "settingsAi.profiles.task.text-generation" },
  { task: "structured-output", label: "settingsAi.profiles.task.structured-output" }
];

interface ModelOption {
  value: string;
  label: string;
  modelId: string;
  runtime: "remote" | "gguf" | "mlx";
  providerConfigId?: string;
  localModelId?: string;
  capabilities: AiCapability[];
  parameterCapabilities: AiModelParameterCapabilities;
  defaultParameters: AiModelParameters;
}

type TaskParameters = Partial<Record<AiConfigurableTask, AiModelParameters>>;

const taskParametersOf = (profileId: string, tasks: readonly AiProfileTask[]): TaskParameters =>
  Object.fromEntries(
    tasks.filter((task) => task.profileId === profileId).map((task) => [task.task, task.parameters])
  ) as TaskParameters;

/** Every model a profile can take: the provider models and the installed local ones. */
export function modelOptionsOf(
  providers: readonly AiProviderConfig[],
  localModels: readonly LocalModelView[]
): ModelOption[] {
  return [
    ...providers.map((model) => ({
      value: `remote:${model.id}`,
      label: `${model.displayName} · ${model.modelId}`,
      modelId: model.modelId,
      runtime: "remote" as const,
      providerConfigId: model.id,
      capabilities: model.capabilities,
      parameterCapabilities: model.parameterCapabilities,
      defaultParameters: model.defaultParameters
    })),
    ...localModels
      .filter((model) => model.status === "ready")
      .map((model) => ({
        value: `local:${model.id}`,
        label: `${model.displayName} · ${model.runtime.toUpperCase()}`,
        modelId: model.modelId,
        runtime: model.runtime,
        localModelId: model.id,
        capabilities: model.capabilities,
        parameterCapabilities: model.parameterCapabilities,
        defaultParameters: model.defaultParameters
      }))
  ];
}

/**
 * The profiles, opened in place under "Profiles and parameters": each ties a model to the jobs it
 * serves, and a job can override the model's parameters. Rarely needed, so a profile is a line (its
 * name and model) with "Edit" and "Duplicate"; editing opens the model, the name and one disclosure
 * per job the model can do. Removing asks first, in the line. A new profile starts from a name and a
 * model.
 */
export function ProfilesPage({
  t,
  id,
  profiles,
  profileTasks,
  providers,
  localModels,
  controller,
  notice
}: {
  t: Translator;
  id: string;
  profiles: readonly AiProfile[];
  profileTasks: readonly AiProfileTask[];
  providers: readonly AiProviderConfig[];
  localModels: readonly LocalModelView[];
  controller: AiSettingsController;
  notice: string | undefined;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const options = useMemo(() => modelOptionsOf(providers, localModels), [providers, localModels]);
  const run = (action: () => Promise<unknown>) => controller.mutate("profiles", action);

  return (
    <div id={id} className="grid gap-3 border-b border-border pb-4 pt-1">
      <AreaNotice message={notice} />
      {profiles.length === 0 ? (
        <p className="m-0 text-sm text-secondary-foreground">{t("settingsAi.profiles.empty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 p-0">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="grid gap-2 border-t border-border py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-48">
                  <p
                    className="m-0 truncate text-sm font-medium text-foreground"
                    title={profile.name}
                  >
                    {profile.name}
                  </p>
                  <p
                    className="m-0 truncate text-xs text-muted-foreground"
                    title={profile.modelId ?? undefined}
                  >
                    {profile.modelId ?? t("settingsAi.profiles.selectModel")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    aria-expanded={editing === profile.id}
                    aria-label={`${editing === profile.id ? t("settingsAi.profiles.close") : t("settingsAi.profiles.edit")}: ${profile.name}`}
                    onClick={() => setEditing(editing === profile.id ? null : profile.id)}
                  >
                    {editing === profile.id
                      ? t("settingsAi.profiles.close")
                      : t("settingsAi.profiles.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${t("settingsAi.profiles.duplicate")}: ${profile.name}`}
                    onClick={() =>
                      void run(() =>
                        controller.app.ai.cloneProfile(profile.id, `${profile.name} 2`)
                      )
                    }
                  >
                    {t("settingsAi.profiles.duplicate")}
                  </Button>
                </div>
              </div>
              {editing === profile.id ? (
                <ProfileEditor
                  key={profile.id}
                  t={t}
                  profile={profile}
                  profileTasks={profileTasks}
                  options={options}
                  onSave={(update, tasks) =>
                    run(async () => {
                      await controller.app.ai.updateProfile({ id: profile.id, ...update });
                      await Promise.all(
                        tasks.map((task) => controller.app.ai.setProfileTask(task))
                      );
                    })
                  }
                  onRemove={async () => {
                    const ok = await run(() => controller.app.ai.deleteProfile(profile.id));
                    if (ok) setEditing(null);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <NewProfile
          t={t}
          options={options}
          first={profiles.length === 0}
          onCancel={() => setCreating(false)}
          onCreate={async (name, option) => {
            const ok = await run(async () => {
              const profile = await controller.app.ai.createProfile({
                name,
                isDefault: profiles.length === 0,
                outputLanguage: "ui"
              });
              await controller.app.ai.updateProfile({
                id: profile.id,
                modelId: option.modelId,
                capabilities: option.capabilities,
                runtime: option.runtime,
                ...(option.providerConfigId ? { providerConfigId: option.providerConfigId } : {}),
                ...(option.localModelId ? { localModelId: option.localModelId } : {})
              });
            });
            if (ok) setCreating(false);
          }}
        />
      ) : (
        <InlineAction size="sm" className="w-fit" onClick={() => setCreating(true)}>
          {t("settingsAi.profiles.new")}
        </InlineAction>
      )}
    </div>
  );
}

function NewProfile({
  t,
  options,
  first,
  onCancel,
  onCreate
}: {
  t: Translator;
  options: readonly ModelOption[];
  first: boolean;
  onCancel: () => void;
  onCreate: (name: string, option: ModelOption) => Promise<void>;
}) {
  const nameId = useId();
  const modelId = useId();
  const [name, setName] = useState("");
  const [selection, setSelection] = useState("");
  const chosen = options.find((option) => option.value === selection);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen && name.trim()) void onCreate(name.trim(), chosen);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="grid gap-3 rounded-lg border border-border bg-soft p-3"
    >
      <Field label={t("settingsAi.profiles.name")} htmlFor={nameId}>
        <TextField id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t("settingsAi.profiles.model")} htmlFor={modelId}>
        <NativeSelect
          id={modelId}
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
        >
          <option value="">{t("settingsAi.profiles.selectModel")}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!chosen || !name.trim()}>
          {first ? t("settingsAi.profiles.create") : t("settingsAi.profiles.create")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}

function ProfileEditor({
  t,
  profile,
  profileTasks,
  options,
  onSave,
  onRemove
}: {
  t: Translator;
  profile: AiProfile;
  profileTasks: readonly AiProfileTask[];
  options: readonly ModelOption[];
  onSave: (
    update: {
      name: string;
      modelId: string;
      runtime: "remote" | "gguf" | "mlx";
      capabilities: AiCapability[];
      providerConfigId?: string;
      localModelId?: string;
    },
    tasks: Array<{ profileId: string; task: AiConfigurableTask; parameters: AiModelParameters }>
  ) => Promise<boolean>;
  onRemove: () => Promise<void>;
}) {
  const nameId = useId();
  const modelId = useId();
  const [name, setName] = useState(profile.name);
  const existing = profile.providerConfigId
    ? `remote:${profile.providerConfigId}`
    : profile.localModelId
      ? `local:${profile.localModelId}`
      : "";
  const [selection, setSelection] = useState(existing);
  const [taskParameters, setTaskParameters] = useState<TaskParameters>(() =>
    taskParametersOf(profile.id, profileTasks)
  );
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const selected = options.find((option) => option.value === selection);
  const supported = selected
    ? taskDefinitions.filter((definition) => supportsTask(definition.task, selected.capabilities))
    : [];

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await onSave(
        {
          name,
          modelId: selected.modelId,
          runtime: selected.runtime,
          capabilities: selected.capabilities,
          ...(selected.providerConfigId ? { providerConfigId: selected.providerConfigId } : {}),
          ...(selected.localModelId ? { localModelId: selected.localModelId } : {})
        },
        supported.map((definition) => ({
          profileId: profile.id,
          task: definition.task,
          parameters: normalizeAiModelParameters(
            taskParameters[definition.task] ?? {},
            selected.parameterCapabilities
          )
        }))
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-soft p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("settingsAi.profiles.name")} htmlFor={nameId}>
          <TextField id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("settingsAi.profiles.model")} htmlFor={modelId}>
          <NativeSelect
            id={modelId}
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">{t("settingsAi.profiles.selectModel")}</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="grid gap-2">
        {supported.map((definition) => (
          <TaskEditor
            key={definition.task}
            t={t}
            label={t(definition.label)}
            task={definition.task}
            parameters={taskParameters[definition.task] ?? {}}
            parameterCapabilities={selected?.parameterCapabilities ?? {}}
            remote={selected?.runtime === "remote"}
            planningContext={selected?.runtime === "mlx"}
            inheritedContextWindow={selected?.defaultParameters.contextWindow}
            onChange={(parameters) =>
              setTaskParameters((current) => ({ ...current, [definition.task]: parameters }))
            }
          />
        ))}
      </div>

      {asking ? (
        <span role="group" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-foreground">{t("settingsAi.profiles.removeAsk")}</span>
          <Button
            aria-label={`${t("settingsAi.profiles.remove")}: ${profile.name}`}
            onClick={() => void onRemove()}
          >
            {t("settingsAi.profiles.remove")}
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            {t("shell.actions.cancel")}
          </Button>
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!selected || saving || !name.trim()}
            onClick={() => void save()}
          >
            {t("settingsAi.profiles.save")}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => setAsking(true)}>
            {t("settingsAi.profiles.remove")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskEditor({
  t,
  label,
  task,
  parameters,
  parameterCapabilities,
  remote,
  planningContext,
  inheritedContextWindow,
  onChange
}: {
  t: Translator;
  label: string;
  task: AiConfigurableTask;
  parameters: AiModelParameters;
  parameterCapabilities: AiModelParameterCapabilities;
  remote: boolean;
  planningContext: boolean;
  inheritedContextWindow: number | undefined;
  onChange: (parameters: AiModelParameters) => void;
}) {
  const [open, setOpen] = useState(false);
  const overrides = Object.keys(parameters).length;
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-surface p-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center justify-between gap-2 rounded-sm border-0 bg-transparent p-0 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {overrides > 0
            ? `${t("settingsAi.profiles.customize")} (${overrides})`
            : t("settingsAi.profiles.modelDefaults")}
        </span>
      </button>
      {open ? (
        <div className="grid gap-3">
          <AiParameterFields
            planningContext={planningContext}
            remote={remote}
            inheritedContextWindow={inheritedContextWindow}
            value={parameters}
            onChange={onChange}
            capabilities={parameterCapabilities}
            t={t}
            embeddingOnly={task === "embedding"}
          />
          <Button className="w-fit" disabled={overrides === 0} onClick={() => onChange({})}>
            {t("settingsAi.profiles.resetTask")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
