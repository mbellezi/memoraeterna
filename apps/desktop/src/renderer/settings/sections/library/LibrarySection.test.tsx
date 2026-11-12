import { mountSection, type Answers, type Harness } from "../general/test-kit";
import { afterEach, describe, expect, it } from "vitest";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { backupFailureKey, copiesUpdate, isAbsolutePath } from "./library-model";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const storage = (over: Record<string, unknown> = {}) => ({
  obsidianVaultPath: null,
  managedRoot: "Memora",
  obsidianSyncEnabled: false,
  obsidianSyncPaused: false,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: "2026-11-12T09:00:00.000Z",
  ...over
});
const plan = (id: string, name: string) => ({ id, name, requestedStages: ["a", "b", "c"] });
const base = (over: Answers = {}): Answers => ({
  "library.rows": { rows: [], total: 214 },
  "settings.get": storage(),
  "settings.getApp": { processingPresets: [] },
  ...over
});
const updates = (harness: Harness, path: string) =>
  harness.calls.filter((call) => call.path === path).map((call) => call.args[0]);

describe("the rules of the library section", () => {
  it("takes a full path and nothing else", () => {
    expect(isAbsolutePath("/Users/me/Documents/Copies")).toBe(true);
    expect(isAbsolutePath("  /Volumes/Disk/Memora ")).toBe(true);
    for (const bad of ["", "Documents", "~/Documents", "relative/path", "/a/../b", "/a\0b"])
      expect(isAbsolutePath(bad), bad).toBe(false);
  });

  it("turns the copy on only with a folder, keeps the folder when it goes off, and turns it on with a new folder", () => {
    const off = { enabled: false, folder: null };
    expect(copiesUpdate(off, { kind: "switch", on: true })).toEqual({ needsFolder: true });
    expect(copiesUpdate({ enabled: false, folder: "/a" }, { kind: "switch", on: true })).toEqual({
      update: { uploadCopiesEnabled: true }
    });
    expect(copiesUpdate({ enabled: true, folder: "/a" }, { kind: "switch", on: false })).toEqual({
      update: { uploadCopiesEnabled: false }
    });
    expect(copiesUpdate(off, { kind: "folder", path: " /b ", thenOn: true })).toEqual({
      update: { uploadCopiesFolderPath: "/b", uploadCopiesEnabled: true }
    });
    // A new folder for a copy that is off leaves it off; for one that is on, on.
    expect(copiesUpdate({ enabled: false, folder: "/a" }, { kind: "folder", path: "/b" })).toEqual({
      update: { uploadCopiesFolderPath: "/b" }
    });
    expect(copiesUpdate({ enabled: true, folder: "/a" }, { kind: "folder", path: "/b" })).toEqual({
      update: { uploadCopiesFolderPath: "/b", uploadCopiesEnabled: true }
    });
  });

  it("reads a backup failure as main's own key when it sent one", () => {
    expect(backupFailureKey(new Error("Error: errors.backup.insufficientDisk"))).toBe(
      "errors.backup.insufficientDisk"
    );
    expect(backupFailureKey(new Error("closed"))).toBe("settingsLibrary.backup.failed");
    expect(backupFailureKey("nope")).toBe("settingsLibrary.backup.failed");
  });
});

describe("Library, drawn from the registry", () => {
  it("renders every registry entry of the section and only those, in the registry's order", async () => {
    h = await mountSection({ section: "library", answers: base() });
    const shown = [...h.dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
      element.getAttribute("data-setting-id")
    );
    expect(shown).toEqual(
      settingsRegistryV2.filter((entry) => entry.section === "library").map((entry) => entry.id)
    );
    expect(shown).toEqual([
      "library.storage",
      "uploadCopies",
      "library.backup",
      "processingPresets"
    ]);
    expect(h.frame().getAttribute("data-state")).toBe("success");
  });

  it("says where the data is kept with the number of sources, and a failed count leaves only the count out", async () => {
    h = await mountSection({ section: "library", locale: "pt-BR", answers: base() });
    expect(h.row("library.storage")!.textContent).toContain("Banco local · 214 fontes");
    expect(h.row("library.storage")!.textContent).toContain("Arquivos guardados");
    await h.dispose();
    h = await mountSection({
      section: "library",
      answers: base({ "library.rows": () => Promise.reject(new Error("closed")) })
    });
    expect(h.row("library.storage")!.textContent).toContain("Local database");
    expect(h.row("library.storage")!.textContent).not.toContain("sources");
    expect(h.dom.document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  describe("the copy of uploaded files", () => {
    it("is one control: a switch with its word and the folder under it", async () => {
      h = await mountSection({
        section: "library",
        answers: base({ "settings.get": storage({ uploadCopiesFolderPath: "/Users/me/Copies" }) })
      });
      const row = h.row("uploadCopies")!;
      const toggle = row.querySelector('[role="switch"]')!;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(row.textContent).toContain("Off");
      expect(row.textContent).toContain("/Users/me/Copies");
      expect(row.textContent).toContain(
        "This folder starts receiving the copies once you turn this on."
      );
    });

    it("asks for the folder before it turns on, then saves the folder and the switch together", async () => {
      h = await mountSection({
        section: "library",
        answers: base({
          "settings.update": (update: unknown) => Promise.resolve(storage(update as object))
        })
      });
      await h.click(h.row("uploadCopies")!.querySelector('[role="switch"]'));
      expect(h.count("settings.update")).toBe(0);
      expect(h.row("uploadCopies")!.textContent).toContain(
        "Choose the folder first: the copies need somewhere to go."
      );
      const field = h.row("uploadCopies")!.querySelector("input")!;
      await h.type(field, "Documents/Copies");
      await h.click(h.button("Save", h.row("uploadCopies")!));
      // A path that is not full is refused here, with no call.
      expect(h.count("settings.update")).toBe(0);
      expect(h.row("uploadCopies")!.textContent).toContain("A full path starts with “/”");
      await h.type(field, "/Users/me/Copies");
      await h.click(h.button("Save", h.row("uploadCopies")!));
      expect(updates(h, "settings.update")).toEqual([
        { uploadCopiesFolderPath: "/Users/me/Copies", uploadCopiesEnabled: true }
      ]);
      expect(
        h.row("uploadCopies")!.querySelector('[role="switch"]')!.getAttribute("aria-checked")
      ).toBe("true");
      expect(h.row("uploadCopies")!.querySelector("input")).toBeNull();
    });

    it("turns off and keeps the folder, and says in one line when a save fails", async () => {
      h = await mountSection({
        section: "library",
        answers: base({
          "settings.get": storage({ uploadCopiesEnabled: true, uploadCopiesFolderPath: "/a" }),
          "settings.update": () => Promise.reject(new Error("errors.common.validationFailed"))
        })
      });
      await h.click(h.row("uploadCopies")!.querySelector('[role="switch"]'));
      expect(updates(h, "settings.update")).toEqual([{ uploadCopiesEnabled: false }]);
      expect(h.row("uploadCopies")!.textContent).toContain(
        "This could not be saved. Nothing was changed."
      );
      expect(
        h.row("uploadCopies")!.querySelector('[role="switch"]')!.getAttribute("aria-checked")
      ).toBe("true");
    });

    it("changes the folder in place and Escape leaves it as it was", async () => {
      h = await mountSection({
        section: "library",
        answers: base({ "settings.get": storage({ uploadCopiesFolderPath: "/a" }) })
      });
      await h.click(h.button("Change folder", h.row("uploadCopies")!));
      const field = h.row("uploadCopies")!.querySelector("input")!;
      expect(field.getAttribute("value")).toBe("/a");
      await h.press(field, "Escape");
      expect(h.row("uploadCopies")!.querySelector("input")).toBeNull();
      expect(h.count("settings.update")).toBe(0);
    });

    it("reads again after a settings.changed of the storage, and offers a retry when the first read fails", async () => {
      let fail = true;
      h = await mountSection({
        section: "library",
        answers: base({
          "settings.get": () =>
            fail ? Promise.reject(new Error("closed")) : Promise.resolve(storage())
        })
      });
      expect(h.row("uploadCopies")!.textContent).toContain("The copy folder could not be read.");
      fail = false;
      await h.click(h.button("Retry", h.row("uploadCopies")!));
      await h.settle();
      expect(h.row("uploadCopies")!.textContent).toContain("No folder chosen yet");
      const reads = h.count("settings.get");
      await h.emit("settings.changed", { stores: ["app"] });
      expect(h.count("settings.get")).toBe(reads);
      await h.emit("settings.changed", { stores: ["storage"] });
      expect(h.count("settings.get")).toBe(reads + 1);
    });
  });

  describe("the backup", () => {
    it("runs on request and says what it did, with where it saved", async () => {
      let finish: (value: unknown) => void = () => undefined;
      h = await mountSection({
        section: "library",
        answers: base({
          "backup.create": () => new Promise((resolve) => (finish = resolve))
        })
      });
      const press = h.button("Back up now", h.row("library.backup")!)!;
      await h.click(press);
      expect(h.row("library.backup")!.textContent).toContain("Backing up…");
      expect(h.button("Back up now", h.row("library.backup")!)?.disabled).toBe(true);
      await h.dom.act(() =>
        finish({
          path: "/Backups/Memora",
          createdAt: "2026-11-12T09:00:00.000Z",
          included: ["database"],
          verified: true
        })
      );
      await h.settle();
      const text = h.row("library.backup")!.textContent!;
      expect(text).toContain("Backup finished. A test restore passed.");
      expect(text).toContain("Saved in /Backups/Memora");
    });

    it("changes nothing when the folder choice is cancelled, and names why a backup failed", async () => {
      h = await mountSection({
        section: "library",
        answers: base({ "backup.create": () => Promise.resolve(null) })
      });
      await h.click(h.button("Back up now", h.row("library.backup")!));
      await h.settle();
      expect(h.row("library.backup")!.textContent).not.toContain("Backup finished");
      expect(h.row("library.backup")!.querySelector('[role="status"]')).toBeNull();
      h.answers["backup.create"] = () =>
        Promise.reject(new Error("Error: errors.backup.insufficientDisk"));
      await h.click(h.button("Back up now", h.row("library.backup")!));
      await h.settle();
      expect(h.row("library.backup")!.textContent).toContain("There is not enough free disk space");
      h.answers["backup.create"] = () => Promise.reject(new Error("closed"));
      await h.click(h.button("Back up now", h.row("library.backup")!));
      await h.settle();
      expect(h.row("library.backup")!.textContent).toContain("The backup could not be made.");
    });
  });

  describe("the saved import plans", () => {
    const withPlans = () =>
      base({
        "settings.getApp": {
          processingPresets: [plan("a", "Short articles"), plan("b", "Large books")]
        }
      });

    it("lists each plan with its step count, and says what to do when there are none", async () => {
      h = await mountSection({ section: "library", answers: withPlans() });
      const text = h.row("processingPresets")!.textContent!;
      expect(text).toContain("Short articles");
      expect(text).toContain("3 stages in this plan");
      await h.dispose();
      h = await mountSection({ section: "library", answers: base() });
      expect(h.row("processingPresets")!.textContent).toContain(
        "No saved import plans yet. Save one while importing."
      );
    });

    it("renames a plan in place and saves the whole list", async () => {
      h = await mountSection({
        section: "library",
        answers: {
          ...withPlans(),
          "settings.updateApp": (update: { processingPresets: unknown }) =>
            Promise.resolve({ processingPresets: update.processingPresets })
        }
      });
      await h.click(h.button("Rename", h.row("processingPresets")!.querySelectorAll("li")[0]));
      const field = h.row("processingPresets")!.querySelector("input")!;
      await h.type(field, "  Notes  ");
      await h.click(h.button("Save", h.row("processingPresets")!));
      expect(updates(h, "settings.updateApp")).toEqual([
        { processingPresets: [plan("a", "Notes"), plan("b", "Large books")] }
      ]);
      expect(h.row("processingPresets")!.textContent).toContain("Notes");
      expect(h.row("processingPresets")!.querySelector("input")).toBeNull();
    });

    it("asks before it deletes, naming the plan, and a failed save leaves the list as it was", async () => {
      h = await mountSection({
        section: "library",
        answers: { ...withPlans(), "settings.updateApp": () => Promise.reject(new Error("closed")) }
      });
      await h.click(h.button("Delete", h.row("processingPresets")!.querySelectorAll("li")[1]));
      expect(h.row("processingPresets")!.textContent).toContain("Delete “Large books”?");
      expect(h.count("settings.updateApp")).toBe(0);
      await h.click(h.button("Delete plan", h.row("processingPresets")!));
      await h.settle();
      expect(h.count("settings.updateApp")).toBe(1);
      expect(h.row("processingPresets")!.textContent).toContain(
        "This could not be saved. Nothing was changed."
      );
      expect(h.row("processingPresets")!.textContent).toContain("Large books");
    });

    it("cancels a delete without a call", async () => {
      h = await mountSection({ section: "library", answers: withPlans() });
      await h.click(h.button("Delete", h.row("processingPresets")!.querySelectorAll("li")[0]));
      await h.click(h.button("Cancel", h.row("processingPresets")!));
      expect(h.count("settings.updateApp")).toBe(0);
      expect(h.row("processingPresets")!.textContent).not.toContain("Delete “");
    });

    it("says in place that the plans could not be read, with a retry", async () => {
      let fail = true;
      h = await mountSection({
        section: "library",
        answers: base({
          "settings.getApp": () =>
            fail ? Promise.reject(new Error("closed")) : Promise.resolve({ processingPresets: [] })
        })
      });
      expect(h.row("processingPresets")!.textContent).toContain(
        "Your saved import plans could not be read."
      );
      fail = false;
      await h.click(h.button("Retry", h.row("processingPresets")!));
      await h.settle();
      expect(h.row("processingPresets")!.textContent).toContain("No saved import plans yet");
    });
  });

  it("reads nothing while Settings is hidden and reads again when it is shown", async () => {
    h = await mountSection({ section: "library", answers: base() });
    expect(h.count("library.rows")).toBe(1);
    await h.show(false);
    await h.emit("object.changed", { kinds: ["note"], overflow: true });
    expect(h.count("library.rows")).toBe(1);
    await h.show(true);
    expect(h.count("library.rows")).toBe(2);
  });
});
