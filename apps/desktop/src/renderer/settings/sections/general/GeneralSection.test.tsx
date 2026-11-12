import { mountSection, type Harness } from "./test-kit";
import { afterEach, describe, expect, it } from "vitest";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { describeFixture } from "./section-screen";
import { languageName, languageOptions } from "./general-model";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ids = (harness: Harness) =>
  [...harness.dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
    element.getAttribute("data-setting-id")
  );

describe("General, drawn from the registry", () => {
  it("renders every registry entry of the section and only those, in the registry's order", async () => {
    h = await mountSection({ section: "general" });
    expect(h.frame().getAttribute("data-surface")).toBe("settings");
    expect(h.frame().getAttribute("data-state")).toBe("success");
    const expected = settingsRegistryV2
      .filter((entry) => entry.section === "general")
      .map((entry) => entry.id);
    expect(ids(h)).toEqual(expected);
    expect(expected).toEqual(["themeMode", "contentLanguage", "language"]);
  });

  it("has no density, open-in or reduced-motion row (S13)", async () => {
    h = await mountSection({ section: "general", locale: "pt-BR" });
    for (const word of ["Densidade", "Abrir em", "Reduzir animações"])
      expect(h.text()).not.toContain(word);
    expect(ids(h).some((id) => /density|openIn|motion/iu.test(id ?? ""))).toBe(false);
  });

  it("shows the theme as three choices with the saved one pressed, in the person's language", async () => {
    h = await mountSection({
      section: "general",
      locale: "pt-BR",
      answers: {
        "settings.describe": describeFixture({
          themeMode: { value: "dark", default: "system", changed: true }
        })
      }
    });
    const group = h.row("themeMode")!.querySelector('[role="group"][aria-label="Tema"]')!;
    const items = [...group.querySelectorAll("button")];
    expect(items.map((item) => item.textContent)).toEqual(["Sistema", "Claro", "Escuro"]);
    expect(items.map((item) => item.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "true"
    ]);
    expect(h.row("themeMode")!.textContent).toContain("Padrão:");
  });

  it("saves a theme through main and keeps it on screen at once", async () => {
    h = await mountSection({
      section: "general",
      answers: { "settings.updateApp": (update: unknown) => Promise.resolve(update) }
    });
    await h.click(h.button("Dark", h.row("themeMode")!));
    expect(
      h.calls.filter((call) => call.path === "settings.updateApp").map((call) => call.args[0])
    ).toEqual([{ themeMode: "dark" }]);
    expect(h.button("Dark", h.row("themeMode")!)?.getAttribute("aria-pressed")).toBe("true");
  });

  it("puts the saved value back and says so in one line when a save fails", async () => {
    h = await mountSection({
      section: "general",
      answers: { "settings.updateApp": () => Promise.reject(new Error("closed")) }
    });
    await h.click(h.button("Light", h.row("themeMode")!));
    await h.settle();
    expect(h.button("System", h.row("themeMode")!)?.getAttribute("aria-pressed")).toBe("true");
    expect(h.row("themeMode")!.textContent).toContain(
      "This could not be saved. Nothing was changed."
    );
  });

  it("lists the five languages by their own names and saves the notes language", async () => {
    expect(languageOptions().map((option) => option.label)).toEqual([
      "English",
      "Português (Brasil)",
      "Italiano",
      "Français",
      "Español"
    ]);
    expect(languageName("pt-BR")).toBe("Português (Brasil)");
    h = await mountSection({
      section: "general",
      answers: {
        "settings.updateApp": (update: unknown) => Promise.resolve(update)
      }
    });
    const select = h.row("contentLanguage")!.querySelector("select")!;
    await h.dom.act(
      () =>
        void (
          Object.entries(select).find(([name]) =>
            name.startsWith("__reactProps$")
          )![1] as unknown as {
            onChange: (event: unknown) => void;
          }
        ).onChange({ target: { value: "es" } })
    );
    expect(
      h.calls.filter((call) => call.path === "settings.updateApp").map((call) => call.args[0])
    ).toEqual([{ contentLanguage: "es" }]);
  });

  it("names the macOS language as the default of both languages, and points the changed notes language at Knowledge", async () => {
    h = await mountSection({
      section: "general",
      locale: "pt-BR",
      answers: {
        "settings.describe": describeFixture({
          contentLanguage: { value: "en", default: "pt-BR", changed: true },
          language: { value: "pt-BR", default: "pt-BR" }
        })
      }
    });
    const notes = h.row("contentLanguage")!;
    expect(notes.textContent).toContain("Padrão:igual ao macOS: Português (Brasil)");
    expect(notes.textContent).toContain("Conhecimento › Conexões");
    // The app language is at its default: no marker, no pointer.
    expect(h.row("language")!.hasAttribute("data-changed")).toBe(false);
    expect(h.row("language")!.textContent).not.toContain("Conhecimento");
  });

  it("reads again nothing of its own: the values come from settings.describe alone", async () => {
    h = await mountSection({ section: "general" });
    expect(h.calls.map((call) => call.path)).toEqual(["settings.describe"]);
  });
});
