import { describe, expect, it, vi } from "vitest";
import { supportsTask, type AiCapability } from "@app/domain";

import {
  isWriterRouteReady,
  loadWriterRouteReady,
  writerRouteTasks,
  type WriterRouteClient,
  type WriterRouteInputs
} from "./writer-route";

const providerProfile = "00000000-0000-4000-8000-000000000001";
const otherProfile = "00000000-0000-4000-8000-000000000002";
const provider = "00000000-0000-4000-8000-0000000000b1";
const otherProvider = "00000000-0000-4000-8000-0000000000b2";
const localModel = "00000000-0000-4000-8000-0000000000a1";

const writerCapabilities: AiCapability[] = [
  "summarization",
  "atomic-note-generation",
  "structured-output"
];

function inputs(overrides: Partial<WriterRouteInputs> = {}): WriterRouteInputs {
  return {
    profiles: [
      {
        id: providerProfile,
        isDefault: true,
        status: "active",
        providerConfigId: provider,
        localModelId: null,
        modelId: "model",
        capabilities: writerCapabilities
      }
    ],
    profileTasks: writerRouteTasks.map((task) => ({ profileId: providerProfile, task })),
    routes: [],
    providers: [{ id: provider, secretConfigured: true }],
    localModels: [],
    ...overrides
  };
}

describe("writer route readiness", () => {
  it("is ready through the default profile when it configures every writer task", () => {
    expect(isWriterRouteReady(inputs())).toBe(true);
  });

  it("is not ready without a profile or without a configured writer task", () => {
    expect(isWriterRouteReady(inputs({ profiles: [], profileTasks: [] }))).toBe(false);
    expect(
      isWriterRouteReady(
        inputs({ profileTasks: [{ profileId: providerProfile, task: "summarization" }] })
      )
    ).toBe(false);
  });

  it("prefers the task route over the default profile and never falls back silently", () => {
    const profiles = [
      ...inputs().profiles,
      {
        id: otherProfile,
        isDefault: false,
        status: "active",
        providerConfigId: otherProvider,
        localModelId: null,
        modelId: "other",
        capabilities: writerCapabilities
      }
    ];
    const providers = [...inputs().providers, { id: otherProvider, secretConfigured: true }];
    // The route targets a profile that does not configure the task: the default is not used instead.
    expect(
      isWriterRouteReady(
        inputs({
          profiles,
          providers,
          routes: [{ task: "atomic-note-generation", profileId: otherProfile }]
        })
      )
    ).toBe(false);
    expect(
      isWriterRouteReady(
        inputs({
          profiles,
          providers,
          routes: [{ task: "atomic-note-generation", profileId: otherProfile }],
          profileTasks: [
            ...inputs().profileTasks,
            { profileId: otherProfile, task: "atomic-note-generation" }
          ]
        })
      )
    ).toBe(true);
  });

  it("requires an active profile with a usable provider or a ready local model", () => {
    const profile = inputs().profiles[0]!;
    expect(isWriterRouteReady(inputs({ profiles: [{ ...profile, status: "disabled" }] }))).toBe(
      false
    );
    expect(isWriterRouteReady(inputs({ profiles: [{ ...profile, providerConfigId: null }] }))).toBe(
      false
    );
    const local = { ...profile, providerConfigId: null, localModelId: localModel };
    expect(
      isWriterRouteReady(
        inputs({ profiles: [local], localModels: [{ id: localModel, status: "downloading" }] })
      )
    ).toBe(false);
    expect(
      isWriterRouteReady(
        inputs({ profiles: [local], localModels: [{ id: localModel, status: "ready" }] })
      )
    ).toBe(true);
  });

  it("is not ready when the provider has no stored secret or no longer exists", () => {
    expect(
      isWriterRouteReady(inputs({ providers: [{ id: provider, secretConfigured: false }] }))
    ).toBe(false);
    expect(isWriterRouteReady(inputs({ providers: [] }))).toBe(false);
    expect(
      isWriterRouteReady(inputs({ providers: [{ id: otherProvider, secretConfigured: true }] }))
    ).toBe(false);
  });

  it("is not ready when the profile capabilities do not serve a writer task, whatever its rows say", () => {
    const profile = inputs().profiles[0]!;
    // Task rows survive a switch to another model, so every row is present here.
    expect(isWriterRouteReady(inputs({ profiles: [{ ...profile, capabilities: [] }] }))).toBe(
      false
    );
    expect(
      isWriterRouteReady(
        inputs({ profiles: [{ ...profile, capabilities: ["text-generation", "embedding"] }] })
      )
    ).toBe(false);
    expect(
      isWriterRouteReady(
        inputs({ profiles: [{ ...profile, capabilities: ["summarization", "structured-output"] }] })
      )
    ).toBe(false);
    expect(isWriterRouteReady(inputs({ profiles: [{ ...profile, modelId: null }] }))).toBe(false);
  });

  it("agrees with the shared routing rule for every combination of capabilities", () => {
    const profile = inputs().profiles[0]!;
    const pool: AiCapability[] = [
      "summarization",
      "atomic-note-generation",
      "structured-output",
      "text-generation",
      "embedding"
    ];
    for (let mask = 0; mask < 1 << pool.length; mask += 1) {
      const capabilities = pool.filter((_, index) => (mask >> index) & 1);
      expect(isWriterRouteReady(inputs({ profiles: [{ ...profile, capabilities }] }))).toBe(
        writerRouteTasks.every((task) => supportsTask(task, capabilities))
      );
    }
  });
});

describe("writer route loading", () => {
  function client(overrides: Partial<WriterRouteClient> = {}) {
    const base = inputs();
    const calls = { statuses: 0 };
    const value: WriterRouteClient = {
      listProfiles: async () =>
        base.profiles.map(
          (profile) =>
            ({
              ...profile,
              name: "Profile",
              description: null,
              privacyMode: "allow_remote",
              outputLanguage: "ui",
              runtime: "remote"
            }) as Awaited<ReturnType<WriterRouteClient["listProfiles"]>>[number]
        ),
      listProfileTasks: async () => base.profileTasks.map((task) => ({ ...task, parameters: {} })),
      listTaskRoutes: async () => [],
      listProviders: async () =>
        base.providers.map(
          (entry) =>
            ({ ...entry, status: "configured" }) as Awaited<
              ReturnType<WriterRouteClient["listProviders"]>
            >[number]
        ),
      listLocalModelStatuses: async () => {
        calls.statuses += 1;
        return [];
      },
      ...overrides
    };
    return { value, calls };
  }

  it("treats a failed lookup as not ready", async () => {
    const { value } = client();
    expect(await loadWriterRouteReady(value)).toBe(true);
    expect(
      await loadWriterRouteReady({
        ...value,
        listTaskRoutes: async () => {
          throw new Error("offline");
        }
      })
    ).toBe(false);
    expect(
      await loadWriterRouteReady({
        ...value,
        listProviders: async () => {
          throw new Error("offline");
        }
      })
    ).toBe(false);
  });

  it("does not ask for local model status unless a profile uses a local model", async () => {
    const { value, calls } = client();
    await loadWriterRouteReady(value);
    expect(calls.statuses).toBe(0);
  });

  it("reads local readiness through the read-only status call", async () => {
    const base = inputs();
    const localProfile = {
      ...base.profiles[0]!,
      providerConfigId: null,
      localModelId: localModel,
      name: "Local",
      description: null,
      privacyMode: "offline_only",
      outputLanguage: "ui",
      runtime: "mlx"
    } as Awaited<ReturnType<WriterRouteClient["listProfiles"]>>[number];
    const statuses = vi.fn(async () => [{ id: localModel, status: "ready" as const }]);
    const { value } = client({
      listProfiles: async () => [localProfile],
      listLocalModelStatuses: statuses
    });
    expect(await loadWriterRouteReady(value)).toBe(true);
    expect(statuses).toHaveBeenCalledTimes(1);

    const notReady = vi.fn(async () => [{ id: localModel, status: "downloading" as const }]);
    expect(await loadWriterRouteReady({ ...value, listLocalModelStatuses: notReady })).toBe(false);
  });
});
