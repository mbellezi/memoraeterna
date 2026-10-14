import { useEffect, useState } from "react";
import { supportsTask } from "@app/domain";
import type {
  AiConfigurableTask,
  AiProfile,
  AiProfileTask,
  AiProviderConfig,
  AiTaskRoute,
  LocalModelStatusEntry
} from "../../shared/ipc";

/** Generative tasks that full knowledge processing needs; embeddings are a separate route. */
export const writerRouteTasks = [
  "summarization",
  "atomic-note-generation",
  "knowledge-graph-generation"
] as const satisfies readonly AiConfigurableTask[];

export interface WriterRouteInputs {
  profiles: readonly Pick<
    AiProfile,
    "id" | "isDefault" | "status" | "providerConfigId" | "localModelId" | "modelId" | "capabilities"
  >[];
  profileTasks: readonly Pick<AiProfileTask, "profileId" | "task">[];
  routes: readonly AiTaskRoute[];
  providers: readonly Pick<AiProviderConfig, "id" | "secretConfigured">[];
  localModels: readonly Pick<LocalModelStatusEntry, "id" | "status">[];
}

/**
 * Mirrors the main-process route resolution: the task route first, then the default profile. The
 * profile must be active, configure the task, declare the capabilities that serve it (the shared
 * `supportsTask` rule) and reach a model that can run: a provider with a stored secret or a ready
 * local model. Task rows outlive a model change, so a row alone never proves the profile can serve
 * the task.
 */
export function isWriterRouteReady({
  profiles,
  profileTasks,
  routes,
  providers,
  localModels
}: WriterRouteInputs): boolean {
  const defaultProfile = profiles.find((profile) => profile.isDefault);
  return writerRouteTasks.every((task) => {
    const routedProfileId = routes.find((route) => route.task === task)?.profileId;
    const profile = routedProfileId
      ? profiles.find((candidate) => candidate.id === routedProfileId)
      : defaultProfile;
    if (!profile || profile.status !== "active" || profile.modelId === null) return false;
    if (!supportsTask(task, profile.capabilities)) return false;
    const hasModel =
      (profile.providerConfigId !== null &&
        providers.some(
          (provider) => provider.id === profile.providerConfigId && provider.secretConfigured
        )) ||
      (profile.localModelId !== null &&
        localModels.some((model) => model.id === profile.localModelId && model.status === "ready"));
    return (
      hasModel &&
      profileTasks.some((entry) => entry.profileId === profile.id && entry.task === task)
    );
  });
}

export interface WriterRouteClient {
  listProfiles: () => Promise<AiProfile[]>;
  listProfileTasks: () => Promise<AiProfileTask[]>;
  listTaskRoutes: () => Promise<AiTaskRoute[]>;
  listProviders: () => Promise<AiProviderConfig[]>;
  /** Read-only: it must not synchronize the model catalog. */
  listLocalModelStatuses: () => Promise<LocalModelStatusEntry[]>;
}

/** Unknown or failing route state is never treated as ready: imports fall back to searchable. */
export async function loadWriterRouteReady(client: WriterRouteClient): Promise<boolean> {
  try {
    const [profiles, profileTasks, routes, providers] = await Promise.all([
      client.listProfiles(),
      client.listProfileTasks(),
      client.listTaskRoutes(),
      client.listProviders()
    ]);
    const usesLocalModel = profiles.some((profile) => profile.localModelId !== null);
    const localModels = usesLocalModel ? await client.listLocalModelStatuses() : [];
    return isWriterRouteReady({ profiles, profileTasks, routes, providers, localModels });
  } catch {
    return false;
  }
}

/** `null` while loading; refreshed whenever `active` becomes true so settings changes are seen. */
export function useWriterRouteReady(active = true): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void loadWriterRouteReady({
      listProfiles: () => window.app.ai.listProfiles(),
      listProfileTasks: () => window.app.ai.listProfileTasks(),
      listTaskRoutes: () => window.app.ai.listTaskRoutes(),
      listProviders: () => window.app.ai.listProviders(),
      listLocalModelStatuses: () => window.app.localModels.statuses()
    }).then((value) => {
      if (live) setReady(value);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return ready;
}
