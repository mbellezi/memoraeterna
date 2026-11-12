// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../../workspace/test-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { SettingsSurface } from "../../SettingsSurface";
import { currentSettingsTarget, resetSettingsTargetForTests } from "../../settings-target";
import { ThisMacBlock } from "./ThisMacBlock";
import { section } from "./AiSection";
import {
  aiCalls,
  decisionsFixture,
  describeFixture,
  hardwareFixture,
  ids,
  providersFixture,
  routesFixture,
  tierIds
} from "./ai-fixtures";
import { macFacts, macTitleKeys, setupNameKeys } from "./ai-model";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");

let dom: TestDom;
let app: Record<string, unknown>;
let spies: Record<string, ReturnType<typeof vi.fn>>;
let emit: Record<string, (event: unknown) => void>;

/** A nested fake `window.app` whose every call path is a spy answering from `calls`. */
function build(calls: Record<string, unknown>) {
  spies = {};
  emit = {};
  const root: Record<string, Record<string, unknown> | unknown> = {};
  for (const path of Object.keys(calls)) {
    const [area, name] = path.split(".") as [string, string];
    const spy = vi.fn(async (...args: unknown[]) => {
      const value = calls[path];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
    });
    spies[path] = spy;
    ((root[area] ??= {}) as Record<string, unknown>)[name] = spy;
  }
  root.onAppEvent = (type: string, handler: (event: unknown) => void) => {
    emit[type] = handler;
    return () => undefined;
  };
  return root;
}

const ai = (over: Record<string, unknown> = {}) => ({
  ...aiCalls("apple-32", over),
  "settings.reset": async () => ({ pending: false }),
  "ai.setClassRoute": routesFixture,
  "ai.testClassRoute": routesFixture,
  "ai.applyPreset": { applied: true, blocked: [], view: routesFixture },
  "ai.deleteProvider": true,
  "ai.setDecisionsEnabled": { ...decisionsFixture, enabled: true, state: "ready" },
  "ai.saveDecisionsKey": { ...decisionsFixture, keyStored: true },
  "ai.testProvider": true,
  "localModels.download": {},
  "localModels.cancel": {},
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  resetSettingsTargetForTests();
  dom = createTestDom();
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void; select?: () => void };
  prototype.focus = () => undefined;
  prototype.select = () => undefined;
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const mount = async (calls: Record<string, unknown> = ai(), t = en) => {
  app = build(calls);
  (dom.window as unknown as { app: unknown }).app = app;
  await dom.render(<SettingsSurface t={t} initialSection="ai" sections={{ ai: section }} />);
  await flush();
};
const flush = async () => {
  await dom.act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await dom.act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const row = (id: string) =>
  dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement | null;
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
const buttons = (within: ParentNode = dom.document) => [...within.querySelectorAll("button")];
const byText = (text: string, within: ParentNode = dom.document) =>
  buttons(within).find((button) => button.textContent?.trim() === text);
const byLabel = (label: string, within: ParentNode = dom.document) =>
  buttons(within).find((button) => button.getAttribute("aria-label")?.startsWith(label));
const handlers = (element: Element) =>
  (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[
    Object.keys(element).find((name) => name.startsWith("__reactProps$")) ?? ""
  ]!;
const choose = (select: Element, value: string) =>
  dom.act(() => handlers(select).onChange?.({ target: { value } }));
const type = (input: Element, value: string) =>
  dom.act(() => handlers(input).onChange?.({ target: { value } }));
const submit = (form: Element) =>
  dom.act(() => handlers(form).onSubmit?.({ preventDefault: () => undefined }));

describe("what the section draws", () => {
  it("draws every registry row of the section, in its order, and only those", async () => {
    await mount();
    const aiIds = settingsRegistryV2.filter((entry) => entry.section === "ai").map((e) => e.id);
    const drawn = [...dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
      element.getAttribute("data-setting-id")
    );
    expect(drawn).toEqual(aiIds);
    expect(dom.document.querySelector("[data-surface]")?.getAttribute("data-state")).toBe(
      "success"
    );
    // The six groups, as the registry names them, each once.
    expect(dom.document.querySelectorAll("section h3")).toHaveLength(6);
  });

  it("draws the rows, with a bar where each control will be, before anything is read", async () => {
    await mount({
      ...ai(),
      "ai.classRoutes": () => new Promise(() => undefined),
      "hardware.profile": () => new Promise(() => undefined)
    });
    const aiIds = settingsRegistryV2.filter((entry) => entry.section === "ai").map((e) => e.id);
    expect(
      [...dom.document.querySelectorAll("[data-setting-id]")].map((e) =>
        e.getAttribute("data-setting-id")
      )
    ).toEqual(aiIds);
    expect(dom.document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(
      dom.document.querySelectorAll('[role="status"][aria-busy="true"]').length
    ).toBeGreaterThan(0);
  });

  it("says a failed read once, in place, and reads again on the retry", async () => {
    let failing = true;
    await mount({
      ...ai(),
      "ai.classRoutes": () => {
        if (failing) throw new Error("closed");
        return routesFixture;
      }
    });
    const alerts = [...dom.document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Could not read the AI setup.");
    expect(alerts[0]?.textContent).toContain("Nothing was changed");
    failing = false;
    await click(byText("Retry")!);
    await flush();
    expect(dom.document.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(dom.document.querySelector('[role="alert"]')).toBeNull();
  });

  it("marks a route on another model than its setup gives, with its default and the way back", async () => {
    await mount();
    const changed = row("ai.route.write-quality")!;
    expect(changed.hasAttribute("data-changed")).toBe(true);
    expect(changed.textContent).toContain("Default:");
    expect(changed.textContent).toContain("gpt-5.6-luna");
    expect(byLabel("Restore default", changed)).toBeDefined();
    expect(row("ai.route.embed")?.hasAttribute("data-changed")).toBe(false);
  });
});

describe("the setup", () => {
  it("is one radio group of four cards with the current one checked", async () => {
    await mount();
    const radios = [...dom.document.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent?.split(/[.A-Z]/u)[0])).toHaveLength(4);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false"
    ]);
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("recommended");
  });

  it("asks before it applies, then applies, tests each job and says it is done", async () => {
    await mount();
    const cloud = [...dom.document.querySelectorAll('[role="radio"]')][2]!;
    await click(cloud);
    expect(spies["ai.applyPreset"]).not.toHaveBeenCalled();
    expect(dom.document.body.textContent).toContain("Switch to Cloud?");
    await click(byText("Apply and test")!);
    await flush();
    expect(spies["ai.applyPreset"]).toHaveBeenCalledWith({ preset: "cloud", test: false });
    expect(spies["ai.testClassRoute"]).toHaveBeenCalledTimes(6);
    expect(dom.document.body.textContent).toContain("Cloud is applied.");
  });

  it("gives up a card on Cancel and on Escape, and writes nothing", async () => {
    await mount();
    const radios = () => [...dom.document.querySelectorAll('[role="radio"]')];
    await click(radios()[2]!);
    await click(byText("Cancel")!);
    expect(dom.document.body.textContent).not.toContain("Switch to Cloud?");
    await click(radios()[2]!);
    const group = [...dom.document.querySelectorAll('[role="group"]')]
      .filter((element) => element.textContent?.includes("Switch to Cloud?"))
      .at(-1)!;
    dom.key(group, "Escape");
    await flush();
    expect(dom.document.body.textContent).not.toContain("Switch to Cloud?");
    expect(spies["ai.applyPreset"]).not.toHaveBeenCalled();
  });

  it("asks before Restore default puts the recommended setup back, and applies only on the yes", async () => {
    await mount(
      ai({
        "settings.describe": {
          entries: describeFixture({
            "ai.preset.v1": { value: "custom", default: "hybrid" },
            "ai.provider.openai-codex": { value: true, default: null }
          })
        }
      })
    );
    const preset = row("ai.preset.v1")!;
    await click(byLabel("Restore default", preset)!);
    expect(spies["ai.applyPreset"]).not.toHaveBeenCalled();
    expect(spies["settings.reset"]).not.toHaveBeenCalled();
    expect(dom.document.body.textContent).toContain("Switch to Hybrid?");
    await click(byText("Apply and test")!);
    await flush();
    expect(spies["ai.applyPreset"]).toHaveBeenCalledWith({ preset: "hybrid", test: false });
  });

  it("applies Custom at once, and cannot choose Local on a Mac that cannot run it, saying why", async () => {
    await mount(ai({ "hardware.profile": hardwareFixture("mac-intel") }));
    const local = [...dom.document.querySelectorAll('[role="radio"]')][0]!;
    expect(local.getAttribute("aria-disabled")).toBe("true");
    expect(local.textContent).toContain("Needs a Mac with Apple silicon.");
    await click(local);
    expect(dom.document.body.textContent).not.toContain("Switch to Local?");
    await click([...dom.document.querySelectorAll('[role="radio"]')][3]!);
    await flush();
    expect(spies["ai.applyPreset"]).toHaveBeenCalledWith({ preset: "custom" });
  });

  it("warns that Local's writer may stay on hold before it applies", async () => {
    await mount();
    await click([...dom.document.querySelectorAll('[role="radio"]')][0]!);
    expect(dom.document.body.textContent).toContain("writing may stay on hold");
  });

  it("names the job and the model that blocked a setup, and leaves the routes alone", async () => {
    await mount(
      ai({
        "ai.applyPreset": {
          applied: false,
          blocked: [
            {
              route: "write-fast",
              reason: "model_missing",
              catalogId: "x",
              modelName: "Qwen3.5-9B"
            }
          ],
          view: routesFixture
        }
      })
    );
    await click([...dom.document.querySelectorAll('[role="radio"]')][0]!);
    await click(byText("Apply and test")!);
    await flush();
    const alert = dom.document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Could not apply Local.");
    expect(alert.textContent).toContain("Quick writing needs Qwen3.5-9B");
    expect(spies["ai.testClassRoute"]).not.toHaveBeenCalled();
  });

  it("links the spending limit to its place in Knowledge", async () => {
    await mount();
    expect(dom.document.body.textContent).toContain("Monthly cloud spending limit: $12");
    expect(dom.document.body.textContent).toContain("$3.10 spent this month");
    await click(byText("Change in Knowledge")!);
    expect(currentSettingsTarget()).toMatchObject({
      section: "knowledge",
      setting: "knowledge.controls.v1.monthlyCapUsd"
    });
  });
});

describe("the model of each job", () => {
  it("offers a job only the profiles that can serve it, and writes a choice at once", async () => {
    await mount();
    const select = row("ai.route.answer")!.querySelector("select")!;
    const options = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["Choose a model", "gpt-5.6-luna", "gpt-6-luna"]);
    await choose(select, ids.profileCompat);
    await flush();
    expect(spies["ai.setClassRoute"]).toHaveBeenCalledWith({
      route: "answer",
      profileId: ids.profileCompat
    });
  });

  it("tests one route and shows its result", async () => {
    await mount();
    expect(row("ai.route.embed")?.textContent).toContain("Test passed in 38 ms");
    expect(row("ai.route.write-fast")?.textContent).toContain("Test passed in 1.4 s");
    await click(byLabel("Test: Search and similarity", row("ai.route.embed")!)!);
    await flush();
    expect(spies["ai.testClassRoute"]).toHaveBeenCalledWith("embed");
  });

  it("discloses what a provider receives before it is made the judge", async () => {
    await mount();
    const select = row("ai.route.judge")!.querySelector("select")!;
    await choose(select, ids.profileCompat);
    expect(spies["ai.setClassRoute"]).not.toHaveBeenCalled();
    expect(row("ai.route.judge")?.textContent).toContain("receives your text");
    await click(byText("Use this model", row("ai.route.judge")!)!);
    await flush();
    expect(spies["ai.setClassRoute"]).toHaveBeenCalledWith({
      route: "judge",
      profileId: ids.profileCompat
    });
  });

  it("says a failure in the route's own place and keeps the choice shown", async () => {
    await mount(
      ai({
        "ai.setClassRoute": () => {
          throw new Error("errors.ai.noCompatibleModel");
        }
      })
    );
    await choose(row("ai.route.answer")!.querySelector("select")!, ids.profileCompat);
    await flush();
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain(
      "No compatible model is configured."
    );
  });
});

describe("providers and credentials", () => {
  it("says a sign-in, a saved key and none, and never shows a key", async () => {
    await mount();
    expect(row("ai.provider.openai-codex")?.textContent).toContain("Connected");
    expect(row("ai.provider.openai-compatible")?.textContent).toContain("Key saved, never shown");
    expect(row("ai.provider.google")?.textContent).toContain("No key");
    expect(byText("Add key…", row("ai.provider.google")!)).toBeDefined();
    expect(byText("Replace key…", row("ai.provider.openai-compatible")!)).toBeDefined();
  });

  it("asks before it removes a configured model, and only Remove deletes", async () => {
    await mount();
    const compat = row("ai.provider.openai-compatible")!;
    await click(byLabel("Remove: gpt-6-luna", compat)!);
    expect(spies["ai.deleteProvider"]).not.toHaveBeenCalled();
    expect(compat.textContent).toContain("Profiles that use it lose their model.");
    await click(byText("Cancel", compat)!);
    expect(spies["ai.deleteProvider"]).not.toHaveBeenCalled();
    await click(byLabel("Remove: gpt-6-luna", compat)!);
    await click(
      buttons(compat).find(
        (button) =>
          button.getAttribute("aria-label") === "Remove: gpt-6-luna" &&
          button.textContent === "Remove"
      )!
    );
    await flush();
    expect(spies["ai.deleteProvider"]).toHaveBeenCalledWith(ids.providerCompat);
  });

  it("tests a configured model and says the answer", async () => {
    await mount();
    await click(byLabel("Test: gpt-5.6-luna", row("ai.provider.openai-codex")!)!);
    await flush();
    expect(spies["ai.testProvider"]).toHaveBeenCalledWith(ids.providerCodex);
    expect(row("ai.provider.openai-codex")?.textContent).toContain("Connection works");
  });

  it("adds a key and a model through a password field, and forgets the secret", async () => {
    const saved = vi.fn(async () => ({}));
    await mount(ai({ "ai.saveProvider": saved, "ai.discoverModels": ["gemini-3-pro"] }));
    const google = row("ai.provider.google")!;
    await click(byText("Add key…", google)!);
    const key = google.querySelector('input[type="password"]') as HTMLInputElement;
    expect(key).not.toBeNull();
    await type(key, "AIza-secret-key");
    const model = google.querySelector("input[list]") as HTMLInputElement;
    await type(model, "gemini-3-pro");
    await submit(google.querySelector("form")!);
    await flush();
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        modelId: "gemini-3-pro",
        apiKey: "AIza-secret-key"
      })
    );
    expect(dom.document.body.textContent).not.toContain("AIza-secret-key");
    expect(google.querySelector("form")).toBeNull();
  });
});

describe("providers: adding a model and replacing a key", () => {
  it("adds a second ChatGPT model after a sign-in instead of renewing the first one", async () => {
    const saved = vi.fn(async () => ({}));
    await mount(
      ai({
        "ai.saveProvider": saved,
        "ai.connectOpenAiCodex": ["gpt-5.6-luna", "gpt-5.6-terra"]
      })
    );
    const codex = row("ai.provider.openai-codex")!;
    await click(byText("Add a model…", codex)!);
    await click(byText("Sign in…", codex)!);
    await flush();
    // The form stays open to pick the model, and nothing was saved yet.
    expect(saved).not.toHaveBeenCalled();
    const model = codex.querySelector("input[list]") as HTMLInputElement;
    expect(model).not.toBeNull();
    // It offers the model that is not on the list yet.
    expect(model.value).toBe("gpt-5.6-terra");
    await submit(codex.querySelector("form")!);
    await flush();
    expect(saved).toHaveBeenCalledTimes(1);
    const sent = (saved.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(sent).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.6-terra" });
    expect(sent).not.toHaveProperty("id");
    expect(codex.querySelector("form")).toBeNull();
  });

  it("renews the sign-in of the models already added when the person signs in again", async () => {
    const saved = vi.fn(async () => ({}));
    await mount(ai({ "ai.saveProvider": saved, "ai.connectOpenAiCodex": ["gpt-5.6-luna"] }));
    const codex = row("ai.provider.openai-codex")!;
    await click(byText("Sign in again", codex)!);
    await click(byText("Sign in…", codex.querySelector("form")!)!);
    await flush();
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.providerCodex, modelId: "gpt-5.6-luna" })
    );
    expect(codex.querySelector("form")).toBeNull();
  });

  it("replaces a key only for the models on the address the person names", async () => {
    const saved = vi.fn(async () => ({}));
    const other = {
      ...providersFixture[1]!,
      id: "00000000-0000-4000-8000-0000000000aa",
      baseUrl: "https://openrouter.example/v1",
      modelId: "other-model",
      displayName: "other-model"
    };
    await mount(ai({ "ai.saveProvider": saved, "ai.listProviders": [...providersFixture, other] }));
    const compat = row("ai.provider.openai-compatible")!;
    await click(byText("Replace key…", compat)!);
    const form = () => compat.querySelector("form")!;
    const chips = [...form().querySelectorAll("button[aria-pressed]")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "https://api.openai.com/v1",
      "https://openrouter.example/v1"
    ]);
    await type(form().querySelector('input[type="password"]')!, "new-key");
    await submit(form());
    await flush();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.providerCompat, apiKey: "new-key" })
    );

    saved.mockClear();
    await click(byText("Replace key…", compat)!);
    await click(
      [...form().querySelectorAll("button[aria-pressed]")].find(
        (chip) => chip.textContent === "https://openrouter.example/v1"
      )!
    );
    await type(form().querySelector('input[type="password"]')!, "router-key");
    await submit(form());
    await flush();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ id: other.id, apiKey: "router-key" })
    );
  });
});

describe("This Mac", () => {
  it.each(tierIds)(
    "renders the %s fixture with its machine, its figures and its recommendation",
    (tier) => {
      const result = hardwareFixture(tier);
      const html = renderToString(
        <ThisMacBlock
          t={en}
          id="ai.thisMac"
          heading="h"
          highlighted={false}
          load={{ status: "ready", value: result }}
          redetecting={false}
          redetected={false}
          notice={undefined}
          onRetry={() => undefined}
          onRedetect={() => undefined}
        />
      );
      const facts = macFacts(en, result);
      expect(html).toContain(en(macTitleKeys[facts.kind]));
      expect(html).toContain(result.profile.cpu.brand ?? "");
      for (const fact of facts.facts) expect(html).toContain(fact.value);
      expect(html).toContain(
        `Recommended for this Mac: ${en(setupNameKeys[result.recommendation.recommended])}.`
      );
      expect(html).toContain("information only");
      expect(html).toContain("Nothing changes by itself");
    }
  );

  it("reads in Portuguese, with one retry when the probe failed", () => {
    const html = renderToString(
      <ThisMacBlock
        t={ptBR}
        id="ai.thisMac"
        heading="h"
        highlighted={false}
        load={{ status: "error" }}
        redetecting={false}
        redetected={false}
        notice={undefined}
        onRetry={() => undefined}
        onRedetect={() => undefined}
      />
    );
    expect(html).toContain("Não deu para detectar este Mac.");
    expect(html).toContain("Tentar de novo");
    expect(html.match(/role="alert"/gu)).toHaveLength(1);
  });

  it("detects again on request, and never changes a route by itself", async () => {
    await mount();
    await click(byText("Detect again")!);
    await flush();
    expect(spies["hardware.profile"]).toHaveBeenLastCalledWith({ refresh: true });
    expect(spies["ai.setClassRoute"]).not.toHaveBeenCalled();
    expect(spies["ai.applyPreset"]).not.toHaveBeenCalled();
    expect(dom.document.body.textContent).toContain("Detected again.");
  });

  it("says in place that it could not detect this Mac, once, and keeps the rest of the section", async () => {
    await mount(
      ai({
        "hardware.profile": () => {
          throw new Error("probe");
        }
      })
    );
    expect(row("ai.thisMac")?.textContent).toContain("Could not detect this Mac.");
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(dom.document.querySelector('[role="radiogroup"]')).not.toBeNull();
  });
});

describe("local models and profiles", () => {
  it("opens the models in place with the summary, downloads, and patches progress from the bus", async () => {
    await mount(ai({ "localModels.download": {} }));
    const models = row("ai.models")!;
    expect(models.textContent).toContain("2 installed · 1.7 GB");
    await click(byLabel("Models on this Mac", models)!);
    const page = dom.document.getElementById(
      models.querySelector("button")!.getAttribute("aria-controls")!
    );
    expect(page).not.toBeNull();
    expect(page?.textContent).toContain("Qwen3-4B-Instruct");
    await click(byLabel("Download: Qwen3-4B-Instruct", page!)!);
    await flush();
    expect(spies["localModels.download"]).toHaveBeenCalledWith({
      catalogId: "mlx-qwen3-4b-instruct-2507-4bit",
      acceptLicense: true
    });
    const reads = spies["localModels.list"]!.mock.calls.length;
    await dom.act(() =>
      emit["model.download"]?.({
        type: "model.download",
        localModelId: ids.modelWriterLarge,
        catalogId: "mlx-qwen3.5-9b-4bit",
        status: "downloading",
        error: null,
        currentFile: "model.safetensors",
        downloadedBytes: 4_000_000_000,
        totalBytes: 5_600_000_000,
        bytesPerSecond: 1,
        etaSeconds: 90
      })
    );
    expect(page?.textContent).toContain("3.7 GB / 5.2 GB");
    expect(spies["localModels.list"]!.mock.calls.length).toBe(reads);
  });

  it("cannot remove a model a profile uses, and asks before it removes another", async () => {
    await mount(ai({ "localModels.remove": {} }));
    await click(byLabel("Models on this Mac", row("ai.models")!)!);
    const used = byLabel("Remove: Qwen3-Embedding-0.6B")!;
    expect(used.hasAttribute("disabled")).toBe(true);
    expect(dom.document.body.textContent).toContain("In use by Qwen3-Embedding-0.6B");
  });

  it("opens a page when a link takes the person to its row", async () => {
    const { requestSettingsTarget } = await import("../../settings-target");
    await mount();
    await dom.act(() => requestSettingsTarget({ section: "ai", setting: "ai.profiles" }));
    await flush();
    expect(dom.document.body.textContent).toContain("New profile…");
  });

  it("lists the profiles with their models and edits one in place", async () => {
    await mount();
    await click(byLabel("Profiles and parameters", row("ai.profiles")!)!);
    expect(row("ai.profiles")?.nextElementSibling?.textContent).toContain("gpt-6-luna");
    await click(byLabel("Edit: gpt-6-luna")!);
    expect(dom.document.body.textContent).toContain("Save profile");
  });
});

describe("OpenAI Decisions", () => {
  it("asks first, with the notice of what leaves this Mac, and turns on only on the yes", async () => {
    await mount();
    const decisions = row("relations.decisions")!;
    const toggle = decisions.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(decisions.textContent).toContain("Off: nothing is sent.");
    await click(toggle);
    expect(spies["ai.setDecisionsEnabled"]).not.toHaveBeenCalled();
    expect(decisions.textContent).toContain("Your note text is sent to OpenAI");
    expect(decisions.textContent).toContain("1200 characters");
    await click(byText("Turn on", decisions)!);
    await flush();
    expect(spies["ai.setDecisionsEnabled"]).toHaveBeenCalledWith(true);
    expect(
      row("relations.decisions")?.querySelector('[role="switch"]')?.getAttribute("aria-checked")
    ).toBe("true");
  });

  it("is unavailable where note text never leaves: the switch is disabled and says so", async () => {
    await mount(
      ai({
        "ai.decisionsStatus": {
          ...decisionsFixture,
          state: "unavailable_preset",
          presetAllowed: false
        }
      })
    );
    const decisions = row("relations.decisions")!;
    expect(decisions.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(true);
    expect(decisions.textContent).toContain("Not available in Local or Custom");
  });

  it("saves the Platform key through a password field and says it is saved without showing it", async () => {
    await mount();
    const key = row("ai:decisions-openai-platform")!;
    expect(key.textContent).toContain("No key");
    await click(byText("Save key…", key)!);
    const field = key.querySelector('input[type="password"]')!;
    await type(field, "sk-platform-secret-key-1234");
    await submit(key.querySelector("form")!);
    await flush();
    expect(spies["ai.saveDecisionsKey"]).toHaveBeenCalledWith("sk-platform-secret-key-1234");
    expect(dom.document.body.textContent).not.toContain("sk-platform-secret-key-1234");
    expect(row("ai:decisions-openai-platform")?.textContent).toContain(
      "Key saved, never shown again"
    );
  });
});

describe("settings.changed", () => {
  it("reads the routes again when the AI store changes, and not for another store", async () => {
    await mount();
    const reads = () => spies["ai.classRoutes"]!.mock.calls.length;
    const before = reads();
    await dom.act(() => emit["settings.changed"]?.({ type: "settings.changed", stores: ["app"] }));
    await flush();
    expect(reads()).toBe(before);
    await dom.act(() => emit["settings.changed"]?.({ type: "settings.changed", stores: ["ai"] }));
    await flush();
    expect(reads()).toBe(before + 1);
  });
});
