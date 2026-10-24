import { renderToString } from "react-dom/server";
import { createTranslator, supportedLanguageCodes, type LanguageCode } from "@app/i18n";
import { presetCatalogIds } from "@app/domain";
import { describe, expect, it } from "vitest";

import { OnboardingController, type OnboardingDeps } from "./onboarding-controller";
import {
  downloadEvent,
  macHardware,
  recordedApi,
  settle,
  smallMacHardware,
  windowsHardware,
  type RecordedOptions
} from "./onboarding-fixtures";
import { OnboardingView } from "./OnboardingView";

function make(options: RecordedOptions = {}, language: LanguageCode = "en") {
  const recorded = recordedApi(options);
  const deps: OnboardingDeps = {
    api: () => recorded.api,
    initial: () => ({ language, contentLanguage: language }),
    names: () => ({ profile: "Writer", codexProvider: "ChatGPT" })
  };
  const controller = new OnboardingController(deps);
  return { recorded, controller };
}

/** The page as text and markup, without the comments React puts between adjacent text nodes. */
const render = (controller: OnboardingController, dark = false) =>
  renderToString(
    <OnboardingView
      t={createTranslator(controller.getSnapshot().languages.language)}
      snapshot={controller.getSnapshot()}
      actions={controller}
      dark={dark}
      source={<div data-testid="import-form">the import form</div>}
    />
  ).replaceAll("<!-- -->", "");

async function atMode(options: RecordedOptions = {}, language: LanguageCode = "en") {
  const made = make(options, language);
  await made.controller.start();
  await made.controller.submitLanguages();
  await settle();
  return made;
}

describe("the first-run view", () => {
  it("says it is getting ready while the question is asked, with no way out yet", () => {
    const { controller } = make();
    const html = render(controller);
    expect(html).toContain("Getting ready");
    expect(html).not.toContain("Skip setup");
    expect(html).toContain('aria-label="Setup steps"');
  });

  it("marks the first of the three steps as the current one and offers to skip", async () => {
    const { controller } = make();
    await controller.start();
    const html = render(controller);
    expect(html).toContain("Which languages do you use?");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("Languages");
    expect(html).toContain("AI setup");
    expect(html).toContain("First source");
    expect(html).toContain("Skip setup");
    expect(html).toContain("sr-only");
    expect(html).toContain("Step 1 of 3: languages");
  });

  it("takes the theme class the shell takes", async () => {
    const { controller } = make();
    await controller.start();
    expect(render(controller, true)).toContain(
      "h-screen flex-col overflow-hidden bg-background text-foreground dark"
    );
    expect(render(controller, false)).not.toMatch(/text-foreground dark/);
  });

  it("names each language in itself and speaks the one that is chosen", async () => {
    const { controller } = make({}, "pt-BR");
    await controller.start();
    const html = render(controller);
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain("Quais idiomas você usa?");
    for (const name of ["English", "Português", "Italiano", "Français", "Español"])
      expect(html).toContain(name);
    controller.setLanguage("fr");
    expect(render(controller)).toContain('lang="fr"');
    expect(render(controller)).toContain("Quelles langues utilisez-vous");
  });

  it("shows a language that could not be saved as an alert and keeps the form", async () => {
    const { controller } = make({ failOnce: ["app:settings:app:update"] });
    await controller.start();
    await controller.submitLanguages();
    const html = render(controller);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The languages could not be saved");
    expect(html).toContain("Continue");
  });
});

describe("the AI step", () => {
  it("reads this computer first, and says so while it waits", async () => {
    const { controller } = await atMode({ hardware: "pending" });
    const html = render(controller);
    expect(html).toContain("Reading this computer");
    expect(html).toContain('role="status"');
    expect(html.match(/name="onboarding-setup"/g)).toHaveLength(3);
  });

  it("shows the card, the three setups with what they download and cost, and the recommendation", async () => {
    const { controller } = await atMode();
    const html = render(controller);
    expect(html).toContain("How should the AI work?");
    expect(html).toContain("This computer");
    expect(html).toContain("Apple M4 Max, 48 GB of memory");
    expect(html.match(/name="onboarding-setup"/g)).toHaveLength(3);
    expect(html).toContain("Recommended for this computer");
    expect(html).toContain("Downloads 1.2 GB");
    expect(html).toContain("No cost: it runs on this computer.");
    expect(html).toContain("About $0.39 a month with an API key");
    expect(html).toContain("About $0.45 a month with an API key");
    expect(html).toContain("A cloud model writes, so the text of your sources is sent");
  });

  it("asks for the writer first: the sign-in is there, and starting waits for it", async () => {
    const { controller } = await atMode();
    const html = render(controller);
    expect(html).toContain("Sign in to the writing model");
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("Sign in to the writing model to continue.");
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/
    );
    await controller.signInCodex();
    const after = render(controller);
    expect(after).toContain("Signed in");
    expect(after).not.toContain("to continue.");
    expect(after).not.toMatch(/<button[^>]*disabled[^>]*type="submit"/);
  });

  it("offers the API key form with a password field that is not filled in", async () => {
    const { controller } = await atMode();
    controller.setWriterMethod("key");
    const html = render(controller);
    expect(html).toContain('type="password"');
    expect(html).toContain("API key");
    expect(html).toContain("Google Gemini");
    expect(html).not.toContain("Sign in with ChatGPT");
  });

  it("leaves the writer out of Local, and says nothing leaves the computer", async () => {
    const { controller } = await atMode({ hardware: { ...macHardware, recommended: "local" } });
    const html = render(controller);
    expect(html).not.toContain("Sign in to the writing model");
    expect(html).toContain("Nothing leaves this computer.");
  });

  it("shows Local as unavailable off Apple silicon, in words, and refuses it with an alert", async () => {
    const { controller } = await atMode({ hardware: windowsHardware });
    let html = render(controller);
    expect(html).toContain("Local needs a Mac with Apple silicon.");
    expect(html).toContain("16 GB of memory");
    expect(html).not.toContain("Apple M4");
    expect(html).not.toContain('role="alert"');
    controller.selectPreset("local");
    html = render(controller);
    expect(html).toContain('role="alert"');
  });

  it("shows Local as unavailable where its writer does not fit, and says it is the memory", async () => {
    const { controller } = await atMode({ hardware: smallMacHardware });
    let html = render(controller);
    expect(html).toContain("Local needs more memory than this computer has.");
    expect(html).not.toContain("Local needs a Mac with Apple silicon.");
    controller.selectPreset("local");
    html = render(controller);
    expect(html).toContain('role="alert"');
    expect(controller.getSnapshot().mode.selected).toBe("hybrid");
  });

  it("tells the card could not read this computer, and keeps the setups to choose from", async () => {
    const { controller } = await atMode({ hardware: "error" });
    const html = render(controller);
    expect(html).toContain("This computer could not be read");
    expect(html).toContain("Try again");
    expect(html.match(/name="onboarding-setup"/g)).toHaveLength(3);
    expect(html).toContain("Download size not known");
  });

  it("says when the model list could not be read", async () => {
    const { controller } = await atMode({ models: "error" });
    expect(render(controller)).toContain("download sizes are not shown");
  });
});

describe("the setup", () => {
  async function running(options: RecordedOptions = {}) {
    const made = await atMode({ installs: "manual", ...options });
    await made.controller.signInCodex();
    made.controller.startSetup();
    await settle();
    return made;
  }

  it("shows each part with a glyph and a word, and the install with its progress", async () => {
    const { controller, recorded } = await running();
    recorded.emit(
      downloadEvent(presetCatalogIds.embedding, "downloading", {
        downloadedBytes: 300 * 1024 ** 2,
        totalBytes: 600 * 1024 ** 2,
        etaSeconds: 120
      })
    );
    const html = render(controller);
    expect(html).toContain("Setting things up");
    expect(html).toContain("Writing model");
    expect(html).toContain("Applying the setup");
    expect(html).toContain("In progress");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("300 MB of 600 MB · 2 min left");
    expect(html).toContain("Setting up the AI");
  });

  it("shows a failure as an alert with a retry and a way on, and the part that failed", async () => {
    const { controller, recorded } = await running();
    recorded.emit(
      downloadEvent(presetCatalogIds.embedding, "failed", {
        error: "errors.localModels.downloadHttp"
      })
    );
    await settle();
    const html = render(controller);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The model download failed.");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Try again");
    expect(html).toContain("Continue without it");
  });

  it("ends with the checks, a summary, and a way to the first source", async () => {
    const { controller, recorded } = await running({ failingTests: ["answer"] });
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    await settle();
    const html = render(controller);
    expect(html).toContain("Checks");
    expect(html).toContain("Works");
    expect(html).toContain("Failed");
    expect(html).toContain("1 check needs attention");
    expect(html).not.toContain("1 checks");
    expect(html).toContain("Continue");
    expect(html).not.toContain("Continue without it");
  });

  it("says relations wait for the ranker while it installs, and when it could not be installed", async () => {
    const { controller, recorded } = await running();
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    recorded.emit(downloadEvent(presetCatalogIds.rankerMlx, "downloading", { totalBytes: 600 }));
    await settle();
    expect(render(controller)).toContain("Relations wait for the ranker");
    recorded.emit(
      downloadEvent(presetCatalogIds.rankerMlx, "failed", {
        error: "errors.localModels.downloadHttp"
      })
    );
    expect(render(controller)).toContain("The ranker could not be installed");
  });

  it("puts the import form in the third step", async () => {
    const { controller, recorded } = await running();
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    await settle();
    controller.continueToSource();
    const html = render(controller);
    expect(html).toContain("Add your first source");
    expect(html).toContain("the import form");
    expect(html).toContain("Step 3 of 3: first source");
  });
});

describe("the copy, in every language", () => {
  it("has no missing message in any step of the flow", async () => {
    for (const language of supportedLanguageCodes) {
      const { controller, recorded } = await atMode(
        { installs: "manual", hardware: windowsHardware },
        language
      );
      const seen = [render(controller)];
      controller.selectPreset("local");
      seen.push(render(controller));
      controller.setWriterMethod("key");
      seen.push(render(controller));
      controller.setWriterMethod("codex");
      await controller.signInCodex();
      controller.startSetup();
      await settle();
      recorded.emit(
        downloadEvent(presetCatalogIds.embedding, "failed", {
          error: "errors.localModels.downloadHttp"
        })
      );
      await settle();
      seen.push(render(controller));
      recorded.emit(
        downloadEvent(presetCatalogIds.rankerGguf, "failed", { error: "errors.nothing" })
      );
      controller.continueToSource();
      seen.push(render(controller));
      for (const html of seen) expect(html, language).not.toContain("[[missing:");
    }
  });
});
