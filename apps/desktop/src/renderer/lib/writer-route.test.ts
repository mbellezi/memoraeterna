import { describe, expect, it } from "vitest";

import {
  isWriterRouteReady,
  loadWriterRouteReady,
  writerRouteTasks,
  type WriterRouteClient,
  type WriterRouteInputs
} from "./writer-route";

const providerProfile = "00000000-0000-4000-8000-000000000001";
const otherProfile = "00000000-0000-4000-8000-000000000002";
const localModel = "00000000-0000-4000-8000-0000000000a1";

function inputs(overrides: Partial<WriterRouteInputs> = {}): WriterRouteInputs {
  return {
    profiles: [
      {
        id: providerProfile,
        isDefault: true,
        status: "active",
        providerConfigId: "00000000-0000-4000-8000-0000000000b1",
        localModelId: null
      }
    ],
    profileTasks: writerRouteTasks.map((task) => ({ profileId: providerProfile, task })),
    routes: [],
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
        providerConfigId: "00000000-0000-4000-8000-0000000000b2",
        localModelId: null
      }
    ];
    // The route targets a profile that does not configure the task: the default is not used instead.
    expect(
      isWriterRouteReady(
        inputs({ profiles, routes: [{ task: "atomic-note-generation", profileId: otherProfile }] })
      )
    ).toBe(false);
    expect(
      isWriterRouteReady(
        inputs({
          profiles,
          routes: [{ task: "atomic-note-generation", profileId: otherProfile }],
          profileTasks: [
            ...inputs().profileTasks,
            { profileId: otherProfile, task: "atomic-note-generation" }
          ]
        })
      )
    ).toBe(true);
  });

  it("requires an active profile with a provider or a ready local model", () => {
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

  it("treats a failed lookup as not ready", async () => {
    const base = inputs();
    const client: WriterRouteClient = {
      listProfiles: async () =>
        base.profiles.map(
          (profile) =>
            ({
              ...profile,
              name: "Profile",
              description: null,
              privacyMode: "allow_remote",
              outputLanguage: "ui",
              modelId: "model",
              runtime: "remote",
              capabilities: []
            }) as Awaited<ReturnType<WriterRouteClient["listProfiles"]>>[number]
        ),
      listProfileTasks: async () => base.profileTasks.map((task) => ({ ...task, parameters: {} })),
      listTaskRoutes: async () => [],
      listLocalModels: async () => []
    };
    expect(await loadWriterRouteReady(client)).toBe(true);
    expect(
      await loadWriterRouteReady({
        ...client,
        listTaskRoutes: async () => {
          throw new Error("offline");
        }
      })
    ).toBe(false);
  });
});
