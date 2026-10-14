import { useEffect, useState } from "react";
import type {
  AiConfigurableTask,
  AiProfile,
  AiProfileTask,
  AiTaskRoute,
  LocalModelView
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
    "id" | "isDefault" | "status" | "providerConfigId" | "localModelId"
  >[];
  profileTasks: readonly Pick<AiProfileTask, "profileId" | "task">[];
  routes: readonly AiTaskRoute[];
  localModels: readonly Pick<LocalModelView, "id" | "status">[];
}

/**
 * Mirrors the main-process route resolution: the task route first, then the default profile; the
 * profile must be active, have a usable provider or ready local model, and configure the task.
 */
export function isWriterRouteReady({
  profiles,
  profileTasks,
  routes,
  localModels
}: WriterRouteInputs): boolean {
  const defaultProfile = profiles.find((profile) => profile.isDefault);
  return writerRouteTasks.every((task) => {
    const routedProfileId = routes.find((route) => route.task === task)?.profileId;
    const profile = routedProfileId
      ? profiles.find((candidate) => candidate.id === routedProfileId)
      : defaultProfile;
    if (!profile || profile.status !== "active") return false;
    const hasModel =
      profile.providerConfigId !== null ||
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
  listLocalModels: () => Promise<LocalModelView[]>;
}

/** Unknown or failing route state is never treated as ready: imports fall back to searchable. */
export async function loadWriterRouteReady(client: WriterRouteClient): Promise<boolean> {
  try {
    const [profiles, profileTasks, routes, localModels] = await Promise.all([
      client.listProfiles(),
      client.listProfileTasks(),
      client.listTaskRoutes(),
      client.listLocalModels()
    ]);
    return isWriterRouteReady({ profiles, profileTasks, routes, localModels });
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
      listLocalModels: () => window.app.localModels.list()
    }).then((value) => {
      if (live) setReady(value);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return ready;
}
