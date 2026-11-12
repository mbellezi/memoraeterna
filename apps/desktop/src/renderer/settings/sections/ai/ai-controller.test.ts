import { describe, expect, it, vi } from "vitest";

import type { AppEventType } from "../../../../shared/app-events";
import type { AiApplyPresetResult } from "../../../../shared/ipc";
import { AiSettingsController, type AiApi } from "./ai-controller";
import {
  budgetFixture,
  decisionsFixture,
  hardwareFixture,
  ids,
  localModelsFixture,
  profilesFixture,
  providersFixture,
  routesFixture
} from "./ai-fixtures";
import { routeOrder } from "./ai-model";

type Handler = (event: unknown) => void;

/** A fake `window.app` for the controller: every call is a spy that answers as the test sets it. */
function fake(over: Record<string, unknown> = {}) {
  const handlers = new Map<AppEventType, Handler>();
  const calls: string[] = [];
  const answer = <T>(path: string, value: T) =>
    vi.fn(async (..._args: unknown[]) => {
      calls.push(path);
      const configured = over[path];
      if (typeof configured === "function") return (configured as (...a: unknown[]) => T)(..._args);
      return (configured ?? value) as T;
    });
  const app = {
    ai: {
      classRoutes: answer("ai.classRoutes", routesFixture),
      listProfiles: answer("ai.listProfiles", profilesFixture),
      listProviders: answer("ai.listProviders", providersFixture),
      listProfileTasks: answer("ai.listProfileTasks", []),
      decisionsStatus: answer("ai.decisionsStatus", decisionsFixture),
      setDecisionsEnabled: answer("ai.setDecisionsEnabled", { ...decisionsFixture, enabled: true }),
      testDecisionsKey: answer("ai.testDecisionsKey", decisionsFixture),
      applyPreset: answer("ai.applyPreset", {
        applied: true,
        blocked: [],
        view: routesFixture
      } satisfies AiApplyPresetResult),
      testClassRoute: answer("ai.testClassRoute", routesFixture),
      setClassRoute: answer("ai.setClassRoute", routesFixture),
      deleteProvider: answer("ai.deleteProvider", true)
    },
    hardware: { profile: answer("hardware.profile", hardwareFixture("apple-32")) },
    localModels: {
      list: answer("localModels.list", localModelsFixture),
      hasRepositoryToken: answer("localModels.hasRepositoryToken", false)
    },
    budget: { snapshot: answer("budget.snapshot", budgetFixture) },
    onAppEvent: (type: AppEventType, handler: Handler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }
  };
  return { app: app as unknown as AiApi, raw: app, handlers, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(over: Record<string, unknown> = {}, refresh = vi.fn()) {
  const api = fake(over);
  const controller = new AiSettingsController(() => api.app, { refreshMarkers: refresh });
  const release = controller.retain();
  await settle();
  return { ...api, controller, release, refresh };
}

describe("reading the section", () => {
  it("reads the core, This Mac, Decisions, the local models and the budget once, on the bus and never on a timer", async () => {
    const { controller, raw, release } = await started();
    const snapshot = controller.getSnapshot();
    for (const key of ["core", "hardware", "decisions", "models", "budget"] as const)
      expect(snapshot[key].status, key).toBe("ready");
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(raw.ai.classRoutes).toHaveBeenCalledTimes(1);
    expect(raw.hardware.profile).toHaveBeenCalledTimes(1);
    release();
  });

  it("tells a failed part in its own place and keeps the others", async () => {
    const { controller } = await started({
      "hardware.profile": () => {
        throw new Error("probe");
      }
    });
    const snapshot = controller.getSnapshot();
    expect(snapshot.hardware.status).toBe("error");
    expect(snapshot.core.status).toBe("ready");
    expect(snapshot.decisions.status).toBe("ready");
  });

  it("keeps a value that was shown when a later read fails, and retries what failed", async () => {
    let failing = false;
    const { controller, raw } = await started({
      "ai.classRoutes": () => {
        if (failing) throw new Error("closed");
        return routesFixture;
      }
    });
    failing = true;
    await controller.loadCore();
    expect(controller.getSnapshot().core.status).toBe("ready");
    const first = fake({
      "ai.classRoutes": () => {
        throw new Error("closed");
      }
    });
    const broken = new AiSettingsController(() => first.app);
    broken.retain();
    await settle();
    expect(broken.getSnapshot().core.status).toBe("error");
    first.raw.ai.classRoutes.mockImplementation(async () => routesFixture);
    broken.retry();
    await settle();
    expect(broken.getSnapshot().core.status).toBe("ready");
    expect(raw.ai.classRoutes).toHaveBeenCalled();
  });

  it("reads the core again when the AI settings change and patches a download without reading the list", async () => {
    const { controller, raw, handlers } = await started();
    handlers.get("settings.changed")?.({ type: "settings.changed", stores: ["app"] });
    await settle();
    expect(raw.ai.classRoutes).toHaveBeenCalledTimes(1);
    handlers.get("settings.changed")?.({ type: "settings.changed", stores: ["ai"] });
    await settle();
    expect(raw.ai.classRoutes).toHaveBeenCalledTimes(2);
    const reads = raw.localModels.list.mock.calls.length;
    handlers.get("model.download")?.({
      type: "model.download",
      localModelId: ids.modelWriterLarge,
      catalogId: "x",
      status: "downloading",
      error: null,
      currentFile: "model.safetensors",
      downloadedBytes: 3_000_000_000,
      totalBytes: 5_600_000_000,
      bytesPerSecond: 1,
      etaSeconds: 30
    });
    const models = controller.getSnapshot().models;
    expect(models.status === "ready" && models.value.models.at(-1)?.download?.downloadedBytes).toBe(
      3_000_000_000
    );
    expect(raw.localModels.list.mock.calls.length).toBe(reads);
  });

  it("stops following the bus when the last holder lets go, and drops an answer that comes late", async () => {
    const { controller, handlers, release } = await started();
    release();
    expect(handlers.size).toBe(0);
    expect(controller.getSnapshot().core.status).toBe("loading");
  });
});

describe("choosing a setup", () => {
  it("asks first, then applies, tests each job in turn and ends done", async () => {
    const { controller, raw, refresh } = await started();
    controller.selectSetup("cloud");
    expect(controller.getSnapshot().setup).toEqual({ kind: "asking", setup: "cloud" });
    expect(raw.ai.applyPreset).not.toHaveBeenCalled();
    const seen: string[] = [];
    controller.subscribe(() => {
      const stage = controller.getSnapshot().setup;
      if (stage.kind === "working" && stage.phase === "testing" && stage.route)
        seen.push(stage.route);
    });
    await controller.confirmSetup();
    expect(raw.ai.applyPreset).toHaveBeenCalledWith({ preset: "cloud", test: false });
    expect(raw.ai.testClassRoute.mock.calls.map((call) => call[0])).toEqual(routeOrder);
    expect([...new Set(seen)]).toEqual([...routeOrder]);
    expect(controller.getSnapshot().setup).toEqual({ kind: "done", setup: "cloud" });
    expect(controller.getSnapshot().writing).toBe(false);
    expect(refresh).toHaveBeenCalled();
  });

  it("says what blocked a setup and tests nothing", async () => {
    const blocked: AiApplyPresetResult = {
      applied: false,
      blocked: [
        { route: "write-fast", reason: "model_missing", catalogId: "x", modelName: "Qwen3.5-9B" }
      ],
      view: routesFixture
    };
    const { controller, raw } = await started({ "ai.applyPreset": blocked });
    controller.selectSetup("local");
    await controller.confirmSetup();
    expect(controller.getSnapshot().setup).toMatchObject({ kind: "blocked", setup: "local" });
    expect(raw.ai.testClassRoute).not.toHaveBeenCalled();
    expect(controller.getSnapshot().writing).toBe(false);
  });

  it("lets a card be given up, applies Custom at once, and tells a failure in place", async () => {
    const { controller, raw } = await started();
    controller.selectSetup("hybrid");
    controller.cancelSetup();
    expect(controller.getSnapshot().setup.kind).toBe("idle");
    controller.selectSetup("custom");
    await settle();
    expect(raw.ai.applyPreset).toHaveBeenCalledWith({ preset: "custom" });
    const failing = await started({
      "ai.applyPreset": () => {
        throw new Error("errors.ai.noCompatibleModel");
      }
    });
    failing.controller.selectSetup("hybrid");
    await failing.controller.confirmSetup();
    expect(failing.controller.getSnapshot().setup.kind).toBe("idle");
    expect(failing.controller.getSnapshot().notices.setup).toBe("errors.ai.noCompatibleModel");
  });
});

describe("routes", () => {
  it("writes a choice at once and asks the markers to be read again", async () => {
    const { controller, raw, refresh } = await started();
    controller.chooseProfile("answer", ids.profileCompat);
    await settle();
    expect(raw.ai.setClassRoute).toHaveBeenCalledWith({
      route: "answer",
      profileId: ids.profileCompat
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("discloses a provider's model for the judge before it writes, and writes only on the yes", async () => {
    const { controller, raw } = await started();
    controller.chooseProfile("judge", ids.profileCompat);
    expect(controller.getSnapshot().pendingJudge).toBe(ids.profileCompat);
    expect(raw.ai.setClassRoute).not.toHaveBeenCalled();
    controller.cancelJudge();
    expect(controller.getSnapshot().pendingJudge).toBeNull();
    controller.chooseProfile("judge", ids.profileCompat);
    controller.confirmJudge();
    await settle();
    expect(raw.ai.setClassRoute).toHaveBeenCalledWith({
      route: "judge",
      profileId: ids.profileCompat
    });
  });

  it("shows a route as being tested while its call runs, and says a failed test's cause", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { controller } = await started({
      "ai.testClassRoute": () => new Promise((resolve) => (release = resolve))
    });
    const running = controller.testRoute("embed");
    expect(controller.getSnapshot().testing).toEqual(["embed"]);
    release(routesFixture);
    await running;
    expect(controller.getSnapshot().testing).toEqual([]);
    const bad = await started({
      "ai.testClassRoute": () => {
        throw new Error("errors.ai.providerUnavailable");
      }
    });
    await bad.controller.testRoute("answer");
    expect(bad.controller.getSnapshot().notices.routes).toBe("errors.ai.providerUnavailable");
  });
});

describe("writes of the pages", () => {
  it("reads what a write can change and asks the markers to be read again; a failure keeps what was shown", async () => {
    const { controller, raw, refresh } = await started();
    const before = raw.ai.classRoutes.mock.calls.length;
    expect(
      await controller.mutate("providers", () =>
        controller.app.ai.deleteProvider(ids.providerCodex)
      )
    ).toBe(true);
    expect(raw.ai.classRoutes.mock.calls.length).toBe(before + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    const ok = await controller.mutate("models", async () => {
      throw new Error("errors.localModels.notReady");
    });
    expect(ok).toBe(false);
    expect(controller.getSnapshot().notices.models).toBe("errors.localModels.notReady");
    expect(controller.getSnapshot().core.status).toBe("ready");
    await controller.mutate("models", async () => undefined);
    expect(controller.getSnapshot().notices.models).toBeUndefined();
  });
});

describe("OpenAI Decisions", () => {
  it("asks before it turns on, then shows the answer and what it came to", async () => {
    const { controller, raw } = await started();
    controller.askEnableDecisions();
    expect(controller.getSnapshot().decisionsAsking).toBe(true);
    expect(raw.ai.setDecisionsEnabled).not.toHaveBeenCalled();
    const ok = await controller.decisionsAction(
      (ai) => ai.setDecisionsEnabled(true),
      "settingsAi.decisions.turnedOn"
    );
    expect(ok).toBe(true);
    const snapshot = controller.getSnapshot();
    expect(snapshot.decisionsAsking).toBe(false);
    expect(snapshot.decisionsNote).toBe("settingsAi.decisions.turnedOn");
    expect(snapshot.decisions.status === "ready" && snapshot.decisions.value.enabled).toBe(true);
  });

  it("tests the saved key: valid, refused, or not reached", async () => {
    const { controller } = await started();
    expect(await controller.testDecisionsKey()).toEqual({
      ok: true,
      key: "settingsAi.decisions.key.testOk"
    });
    const refused = await started({
      "ai.testDecisionsKey": { ...decisionsFixture, keyInvalid: true }
    });
    expect((await refused.controller.testDecisionsKey()).ok).toBe(false);
    const offline = await started({
      "ai.testDecisionsKey": () => {
        throw new Error("errors.common.network");
      }
    });
    expect(await offline.controller.testDecisionsKey()).toEqual({
      ok: false,
      key: "errors.common.network"
    });
  });
});

describe("This Mac", () => {
  it("probes again on request and says so", async () => {
    const { controller, raw } = await started();
    await controller.redetect();
    expect(raw.hardware.profile).toHaveBeenLastCalledWith({ refresh: true });
    expect(controller.getSnapshot()).toMatchObject({ redetected: true, redetecting: false });
  });

  it("keeps the figures it had when the probe fails, and says it in the card", async () => {
    const { controller } = await started();
    const api = fake({
      "hardware.profile": (input?: unknown) => {
        if (input) throw new Error("probe");
        return hardwareFixture("apple-32");
      }
    });
    const mac = new AiSettingsController(() => api.app);
    mac.retain();
    await settle();
    await mac.redetect();
    expect(mac.getSnapshot().hardware.status).toBe("ready");
    expect(mac.getSnapshot().notices.hardware).toBe("settingsAi.thisMac.error");
    expect(controller.getSnapshot().redetected).toBe(false);
  });
});
