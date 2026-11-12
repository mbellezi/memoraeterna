import { mountSection, type Answers, type Harness } from "../general/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { describeFixture } from "../general/section-screen";
import { credentialNames, leaveRows, questionCount, type LeavesInput } from "./privacy-model";

let h: Harness | null = null;
// The test DOM has no sessionStorage; a map stands in for the window's.
const session = new Map<string, string>();
beforeEach(() => {
  session.clear();
  Object.defineProperty(globalThis.window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key)
    }
  });
});
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const test = { state: "passed", model: "m", ms: 1, at: null, error: null };
const route = (id: string, remote: boolean, name: string | null = "Profile") => ({
  id,
  profileId: name === null ? null : "0b2a4a7e-5f6e-4c8b-9a3b-1c2d3e4f5a61",
  profileName: name,
  modelId: "m",
  runtime: remote ? "remote" : "mlx",
  remote,
  test
});
const routes = (judgeRemote = true) => ({
  preset: "hybrid",
  presets: [],
  classes: [
    route("embed", false),
    route("decide", false),
    route("write-fast", true, "ChatGPT subscription"),
    route("write-quality", true, "ChatGPT subscription"),
    route("answer", true, "ChatGPT subscription")
  ],
  judge: {
    ...route("judge", judgeRemote, "ChatGPT subscription"),
    id: undefined,
    providerName: "ChatGPT subscription",
    routed: true,
    deciderMode: null
  }
});
const decisions = (over: Record<string, unknown> = {}) => ({
  state: "off",
  enabled: false,
  presetAllowed: true,
  keyStored: false,
  ...over
});
const base = (over: Answers = {}): Answers => ({
  "ai.classRoutes": routes(),
  "ai.decisionsStatus": decisions(),
  "ai.listProviders": [{ displayName: "ChatGPT subscription", secretConfigured: true }],
  "settings.getGoogleBooksKeyStatus": { configured: false },
  "questions.list": { items: [{}, {}, {}] },
  "monitoring.list": { rows: [], totals: { count: 1284 } },
  "settings.describe": describeFixture({ bookLookup: { value: "auto", default: "auto" } }),
  ...over
});

describe("what leaves this Mac, by job", () => {
  const input = (over: Partial<LeavesInput> = {}): LeavesInput => ({
    routes: routes() as unknown as LeavesInput["routes"],
    decisions: { enabled: false, state: "off" },
    bookLookup: "auto",
    ...over
  });

  it("says where each job runs and whether anything can leave", () => {
    const rows = leaveRows(input());
    expect(rows.map((row) => [row.job, row.where.kind, row.leaves])).toEqual([
      ["embed", "local", false],
      ["decide", "local", false],
      ["writeFast", "cloud", true],
      ["writeQuality", "cloud", true],
      ["answer", "cloud", true],
      ["judge", "cloud", true],
      ["decisions", "off", false],
      ["books", "internet", true]
    ]);
    expect(rows[2]?.where).toEqual({ kind: "cloud", name: "ChatGPT subscription" });
  });

  it("names every service a metadata lookup contacts: articles always go to Crossref", () => {
    const services = (bookLookup: string) => {
      const books = leaveRows(input({ bookLookup })).at(-1)!;
      return books.where.kind === "internet" ? books.where.services : null;
    };
    expect(services("auto")).toEqual(["openLibrary", "googleBooks", "crossref"]);
    expect(services("open-library")).toEqual(["openLibrary", "crossref"]);
    expect(services("google-books")).toEqual(["googleBooks", "crossref"]);
    expect(services("off")).toBeNull();
  });

  it("names a job with no model, turns OpenAI Decisions on when it is, and takes the book lookup as it is set", () => {
    const noModel = {
      classes: [route("embed", false, null)],
      judge: { ...routes().judge, profileId: null }
    } as unknown as LeavesInput["routes"];
    const rows = leaveRows(
      input({
        routes: noModel,
        decisions: { enabled: true, state: "ready" },
        bookLookup: "google-books"
      })
    );
    expect(rows[0]).toMatchObject({ job: "embed", where: { kind: "noModel" }, leaves: false });
    expect(rows[1]).toMatchObject({ job: "judge", where: { kind: "noModel" }, leaves: false });
    expect(rows[2]).toMatchObject({
      job: "decisions",
      where: { kind: "cloud", name: "OpenAI" },
      leaves: true
    });
    expect(rows[3]).toMatchObject({ job: "books", where: { kind: "internet", source: "google" } });
    const off = leaveRows(
      input({ bookLookup: "off", decisions: { enabled: true, state: "unavailable_preset" } })
    );
    expect(off.at(-2)).toMatchObject({ job: "decisions", where: { kind: "off" } });
    expect(off.at(-1)).toMatchObject({ job: "books", where: { kind: "off" }, leaves: false });
  });

  it("lists credential names, never values, and counts questions by the first page", () => {
    expect(
      credentialNames({
        providers: [
          { displayName: "A", secretConfigured: true },
          { displayName: "B", secretConfigured: false }
        ],
        decisionsKeyStored: true,
        decisionsName: "D",
        googleBooksKeyStored: true,
        googleBooksName: "G",
        repositoryTokenStored: true,
        repositoryTokenName: "H"
      })
    ).toEqual(["A", "D", "G", "H"]);
    expect(questionCount({ items: [1, 2] })).toEqual({ count: 2, more: false });
    expect(questionCount({ items: new Array(50).fill(0), next: "x" })).toEqual({
      count: 50,
      more: true
    });
  });
});

describe("Privacy, drawn from the registry", () => {
  it("renders every registry entry of the section and only those, in the registry's order", async () => {
    h = await mountSection({ section: "privacy", answers: base() });
    const shown = [...h.dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
      element.getAttribute("data-setting-id")
    );
    expect(shown).toEqual(
      settingsRegistryV2.filter((entry) => entry.section === "privacy").map((entry) => entry.id)
    );
    expect(h.frame().getAttribute("data-state")).toBe("success");
  });

  it("draws the table of what leaves, in the person's language, with nothing for the jobs that stay here", async () => {
    h = await mountSection({ section: "privacy", locale: "pt-BR", answers: base() });
    const table = h.row("privacy.summary")!.querySelector("table")!;
    const rows = [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.children].map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ["Busca e semelhança", "Neste Mac", "Nada"],
      ["Classificação", "Neste Mac", "Nada"],
      ["Escrita rápida", "Na nuvem · ChatGPT subscription", "Trechos das fontes e resumos"],
      ["Escrita cuidadosa", "Na nuvem · ChatGPT subscription", "Trechos das fontes"],
      ["Respostas", "Na nuvem · ChatGPT subscription", "Sua pergunta e as notas citadas"],
      ["Juiz generativo", "Na nuvem · ChatGPT subscription", "Notas e trechos comparados"],
      ["OpenAI Decisions", "Desligado", "Nada"],
      [
        "Dados de livros e artigos",
        "Na internet · Open\u00a0Library, Google\u00a0Books e Crossref",
        "ISBN, DOI, título e autores"
      ]
    ]);
    expect(table.querySelector("caption")?.textContent).toBe("O que sai deste Mac, por trabalho");
    expect(h.row("privacy.summary")!.textContent).toContain("ChatGPT subscription.");
  });

  it("says Crossref receives article lookups whichever book service is chosen", async () => {
    h = await mountSection({
      section: "privacy",
      answers: base({
        "settings.describe": describeFixture({
          bookLookup: { value: "open-library", default: "auto", changed: true }
        })
      })
    });
    const last = h.row("privacy.summary")!.querySelector("tbody tr:last-child")!.textContent!;
    expect(last).toContain("On the internet · Open\u00a0Library and Crossref");
    expect(last).not.toContain("Google Books");
  });

  it("lists a stored model repository token among the credentials, and says none only when none is", async () => {
    h = await mountSection({
      section: "privacy",
      answers: base({
        "ai.listProviders": [],
        "settings.describe": describeFixture({
          "local-models.repository-token-ref": { value: true, default: null, changed: true }
        })
      })
    });
    const summary = h.row("privacy.summary")!.textContent!;
    expect(summary).toContain("Hugging Face token");
    expect(summary).not.toContain("No credentials are kept");
    await h.dispose();
    h = await mountSection({ section: "privacy", answers: base({ "ai.listProviders": [] }) });
    expect(h.row("privacy.summary")!.textContent).toContain("No credentials are kept on this Mac.");
  });

  it("follows the book lookup of settings.describe, and an AI change reads the routes again", async () => {
    h = await mountSection({
      section: "privacy",
      answers: base({
        "settings.describe": describeFixture({
          bookLookup: { value: "off", default: "auto", changed: true }
        })
      })
    });
    expect(h.row("privacy.summary")!.querySelector("tbody tr:last-child")!.textContent).toContain(
      "Off"
    );
    const reads = h.count("ai.classRoutes");
    await h.emit("settings.changed", { stores: ["storage"] });
    expect(h.count("ai.classRoutes")).toBe(reads);
    await h.emit("settings.changed", { stores: ["ai"] });
    expect(h.count("ai.classRoutes")).toBe(reads + 1);
  });

  it("says in place that it could not be read, once, with one retry", async () => {
    let fail = true;
    h = await mountSection({
      section: "privacy",
      answers: base({
        "ai.classRoutes": () =>
          fail ? Promise.reject(new Error("closed")) : Promise.resolve(routes())
      })
    });
    const summary = h.row("privacy.summary")!;
    expect(summary.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(summary.textContent).toContain("What leaves this Mac could not be read.");
    expect(summary.textContent).toContain("Nothing was changed.");
    fail = false;
    await h.click(h.button("Retry", summary));
    await h.settle();
    expect(h.row("privacy.summary")!.querySelector("table")).not.toBeNull();
  });

  describe("what erases", () => {
    it("asks before it clears Recents, names what stays, and says how many left", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({ "viewHistory.clear": () => Promise.resolve(7) })
      });
      await h.click(h.button("Clear…"));
      expect(h.count("viewHistory.clear")).toBe(0);
      expect(h.text()).toContain("Pinned items stay.");
      await h.click(h.button("Clear Recents"));
      await h.settle();
      expect(h.count("viewHistory.clear")).toBe(1);
      expect(h.row("privacy.clearViewHistory")!.textContent).toContain(
        "7 items removed from Recents."
      );
      expect(h.text()).not.toContain("Clear Recents?");
    });

    it("cancels without a call, and keeps the dialog with one sentence when the call fails", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({ "viewHistory.clear": () => Promise.reject(new Error("closed")) })
      });
      await h.click(h.button("Clear…"));
      await h.click(h.button("Cancel"));
      expect(h.count("viewHistory.clear")).toBe(0);
      await h.click(h.button("Clear…"));
      await h.click(h.button("Clear Recents"));
      await h.settle();
      expect(h.text()).toContain("Recents could not be cleared. Nothing was changed.");
      expect(h.text()).toContain("Clear Recents?");
    });

    it("counts the saved questions, asks before it deletes them and says how many went", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({ "questions.clear": () => Promise.resolve({ deleted: 3 }) })
      });
      expect(h.row("privacy.clearQuestions")!.textContent).toContain("3 saved questions");
      await h.click(h.button("Delete questions…"));
      expect(h.text()).toContain("It cannot be undone.");
      expect(h.count("questions.clear")).toBe(0);
      await h.click(h.button("Delete questions"));
      await h.settle();
      expect(h.count("questions.clear")).toBe(1);
      const text = h.row("privacy.clearQuestions")!.textContent!;
      expect(text).toContain("3 questions deleted.");
      expect(text).toContain("No saved questions.");
      expect(h.button("Delete questions…")?.disabled).toBe(true);
    });

    it("says 'more than 50' for a long list, and follows a question being saved", async () => {
      let items = new Array(50).fill({});
      h = await mountSection({
        section: "privacy",
        answers: base({ "questions.list": () => Promise.resolve({ items, next: "x" }) })
      });
      expect(h.row("privacy.clearQuestions")!.textContent).toContain(
        "More than 50 saved questions"
      );
      items = [{}];
      const reads = h.count("questions.list");
      await h.emit("object.changed", { refs: [{ kind: "note", id: "n", change: "updated" }] });
      expect(h.count("questions.list")).toBe(reads);
      await h.emit("object.changed", { refs: [{ kind: "question", id: "q", change: "created" }] });
      expect(h.row("privacy.clearQuestions")!.textContent).toContain("1 saved question");
    });

    it("keeps the questions and says so when the delete fails", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({ "questions.clear": () => Promise.reject(new Error("closed")) })
      });
      await h.click(h.button("Delete questions…"));
      await h.click(h.button("Delete questions"));
      await h.settle();
      expect(h.text()).toContain("The questions could not be deleted. Nothing was changed.");
      expect(h.row("privacy.clearQuestions")!.textContent).toContain("3 saved questions");
    });
  });

  describe("the AI call log", () => {
    it("says how many calls it keeps and what each holds, and points to Advanced", async () => {
      h = await mountSection({ section: "privacy", locale: "pt-BR", answers: base() });
      const text = h.row("privacy.callLog")!.textContent!;
      expect(text).toContain("guarda 1.284 chamadas neste Mac");
      expect(text).toContain("prompts e respostas inteiros só com a captura completa");
      expect(h.button("Ver e apagar em Avançado")).toBeDefined();
    });

    it("says full capture is on when it is, and an empty log is empty", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({
          "settings.describe": describeFixture({
            debugFullCapture: { value: true, default: false, changed: true }
          }),
          "monitoring.list": { rows: [], totals: { count: 0 } }
        })
      });
      const text = h.row("privacy.callLog")!.textContent!;
      expect(text).toContain("The AI call log is empty.");
      expect(text).toContain("Full capture is on");
    });
  });

  describe("reset everything", () => {
    it("says it cannot be undone and points at the backup, asks first, and cancel changes nothing", async () => {
      h = await mountSection({ section: "privacy", answers: base() });
      expect(h.row("privacy.reset")!.textContent).toContain(
        "This cannot be undone. Make a backup first"
      );
      await h.click(h.button("Reset everything…"));
      expect(h.text()).toContain("Reset everything?");
      expect(h.count("settings.resetLibrary")).toBe(0);
      await h.click(h.button("Cancel"));
      expect(h.count("settings.resetLibrary")).toBe(0);
      expect(h.text()).not.toContain("Reset everything?");
    });

    it("resets, then reloads the app to start from the empty library", async () => {
      const reload = vi.fn();
      h = await mountSection({
        section: "privacy",
        answers: base({
          "settings.resetLibrary": () =>
            Promise.resolve({
              deletedSources: 1,
              deletedAtomicNotes: 2,
              deletedFiles: 3,
              failedFiles: 0
            })
        })
      });
      Object.defineProperty(h.dom.window, "location", { value: { reload }, configurable: true });
      await h.click(h.button("Reset everything…"));
      await h.click(h.button("Reset everything"));
      await h.settle();
      expect(h.count("settings.resetLibrary")).toBe(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads when some files stayed too, and says so when Privacy is shown after the reload", async () => {
      const reload = vi.fn();
      h = await mountSection({
        section: "privacy",
        answers: base({
          "settings.resetLibrary": () =>
            Promise.resolve({
              deletedSources: 1,
              deletedAtomicNotes: 2,
              deletedFiles: 3,
              failedFiles: 2
            })
        })
      });
      Object.defineProperty(h.dom.window, "location", { value: { reload }, configurable: true });
      await h.click(h.button("Reset everything…"));
      await h.click(h.button("Reset everything"));
      await h.settle();
      expect(reload).toHaveBeenCalledTimes(1);
      await h.dispose();
      h = await mountSection({ section: "privacy", answers: base() });
      expect(h.row("privacy.reset")!.textContent).toContain(
        "some stored files could not be removed"
      );
      expect(h.button("Reload Memora")).toBeUndefined();
    });

    it("keeps the dialog and says what failed when the reset fails", async () => {
      h = await mountSection({
        section: "privacy",
        answers: base({ "settings.resetLibrary": () => Promise.reject(new Error("closed")) })
      });
      await h.click(h.button("Reset everything…"));
      await h.click(h.button("Reset everything"));
      await h.settle();
      expect(h.text()).toContain("The reset could not be finished.");
      expect(h.count("settings.resetLibrary")).toBe(1);
    });
  });
});
