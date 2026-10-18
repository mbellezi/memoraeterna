import {
  createAiConfigRepository,
  operationRouteKey,
  workloadClassRouteKey,
  type Queryable
} from "@app/db";
import { aiClassIds, generativeDecideOperations } from "@app/domain";

import {
  embedOperations,
  f3Operations,
  legacyOperations,
  rankerOperations,
  resolveRoute,
  type RouteMappingFacts
} from "../ai-route-mapping.js";

/**
 * Which calls of the product can reach a real remote provider through a profile's routes (F3 T62,
 * the soak's safety check). A soak must call no real provider, and a profile cloned from the owner's
 * DEV profile can still point at one. The check resolves, with the product's own route chain, every
 * call the product makes: each legacy operation as a caller that states its class, the generative
 * decide operations, the F3 operations, the ranker and embedding operations, and the five class
 * routes. A stored route the chain never chooses (the legacy task routes a preset leaves behind) is
 * reported apart: nothing the product calls reaches it. The default profile serves a task that no
 * route names, so a real remote default profile is reported on its own.
 */

export interface RemoteReach {
  /** Calls that resolve to a real remote profile, grouped by profile: `profile (provider): calls`. */
  reachable: string[];
  /** The default profile when it is a real remote one (a task with no route would use it). */
  defaultProfile: { id: string; name: string; provider: string } | null;
  /** Stored routes to a real remote profile that no call of the product resolves to. */
  residual: string[];
}

interface Probe {
  call: string;
  keys: string[];
  task: string;
}

/** Every call of the product, with the route keys it resolves. */
export function productProbes(): Probe[] {
  const classed = (operation: string, className: string, task: string): Probe => ({
    call: operation,
    keys: [operationRouteKey(operation), workloadClassRouteKey(className), task],
    task
  });
  return [
    ...legacyOperations.map((entry) => classed(entry.operation, entry.class, entry.task)),
    ...generativeDecideOperations.map((operation) => classed(operation, "decide", "reranking")),
    ...f3Operations.map((operation) => classed(operation, "write-fast", "structured-output")),
    ...rankerOperations.map((operation) => ({
      call: operation,
      keys: [workloadClassRouteKey("decide")],
      task: workloadClassRouteKey("decide")
    })),
    ...embedOperations.map((operation) => ({
      call: operation,
      keys: [workloadClassRouteKey("embed"), "embedding"],
      task: "embedding"
    })),
    ...aiClassIds.map((className) => ({
      call: `class:${className}`,
      keys: [workloadClassRouteKey(className)],
      task: workloadClassRouteKey(className)
    }))
  ];
}

/**
 * The real remote reach of a profile's AI configuration. `allowedConfigIds` are provider
 * configurations that do not count: the soak's own fake providers.
 */
export async function findRealRemoteReach(
  db: Queryable,
  allowedConfigIds: readonly string[]
): Promise<RemoteReach> {
  const config = createAiConfigRepository(db);
  const [profiles, routes, profileTasks, providers] = await Promise.all([
    config.listProfiles(),
    config.listTaskRoutes(),
    config.listProfileTasks(),
    config.listProviders()
  ]);
  const facts: RouteMappingFacts = {
    profiles: profiles.map((profile) => ({
      id: profile.id,
      status: profile.status,
      isDefault: profile.isDefault,
      modelId: profile.modelId,
      capabilities: profile.capabilities,
      providerConfigId: profile.providerConfigId,
      localModelId: profile.localModelId
    })),
    routes,
    profileTasks
  };
  const allowed = new Set(allowedConfigIds);
  const providerOf = new Map(providers.map((provider) => [provider.id, provider]));
  const profileOf = new Map(profiles.map((profile) => [profile.id, profile]));
  /** The real remote provider a profile serves, or null (a local model, or one of the fakes). */
  const realProvider = (profileId: string) => {
    const configId = profileOf.get(profileId)?.providerConfigId;
    return configId && !allowed.has(configId) ? (providerOf.get(configId) ?? null) : null;
  };
  const label = (profileId: string) => {
    const provider = realProvider(profileId);
    return `${profileOf.get(profileId)?.name ?? profileId} (${provider?.provider ?? "?"})`;
  };

  const calls = new Map<string, string[]>();
  const chosen = new Set<string>();
  for (const probe of productProbes()) {
    const resolved = resolveRoute(facts, probe.keys, probe.task);
    if (!resolved) continue;
    chosen.add(resolved.key);
    if (realProvider(resolved.profileId))
      calls.set(label(resolved.profileId), [
        ...(calls.get(label(resolved.profileId)) ?? []),
        probe.call
      ]);
  }
  const reachable = [...calls].map(([profile, names]) => {
    const shown = names.slice(0, 6).join(", ");
    return `${profile}: ${shown}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`;
  });

  const defaultProfile = profiles.find(
    (profile) => profile.isDefault && profile.status === "active"
  );
  const defaultReal = defaultProfile && realProvider(defaultProfile.id);
  return {
    reachable,
    defaultProfile:
      defaultProfile && defaultReal
        ? { id: defaultProfile.id, name: defaultProfile.name, provider: defaultReal.provider }
        : null,
    residual: routes
      .filter((route) => !chosen.has(route.task) && realProvider(route.profileId))
      .map((route) => `${route.task} -> ${label(route.profileId)}`)
      .toSorted()
  };
}

/** Why a profile may not run a soak, in one sentence; null when no real provider is reachable. */
export function realRemoteProblem(reach: RemoteReach): string | null {
  const parts = [
    ...reach.reachable,
    ...(reach.defaultProfile
      ? [`the default profile ${reach.defaultProfile.name} (${reach.defaultProfile.provider})`]
      : [])
  ];
  return parts.length === 0
    ? null
    : `This profile still reaches a real remote provider (${parts.join("; ")}). ` +
        "Apply the Local preset first (MEMORA_SOAK_SETUP=1): a soak never calls a real provider.";
}
