import { describe, expect, it, vi } from "vitest";

import { keymap } from "../keymap";
import { defaultWorkspace, reduce } from "../state";
import { showImportPanelActions, showSourceActions } from "./add-navigation";
import { AddFlow, addModeStorageKey } from "./add-flow";
import { descriptorFromFile, titleFromFileName } from "./add-descriptor";
import {
  addMenuEntries,
  addMoreEntry,
  defaultMode,
  effectiveMode,
  importModes,
  modeCopy,
  planOfMode
} from "./add-model";
import { addMenuState } from "./AddMenu";
import { dropOverlayState } from "./DropOverlay";

const profile = "00000000-0000-4000-8000-0000000000a1";
const provider = "00000000-0000-4000-8000-0000000000b1";
const sourceId = "00000000-0000-4000-8000-000000000042";
const token = "8f2f9a3e-6a64-4c24-9b4a-0c2f5b6f3b11";
const draft = (values: Record<string, unknown> = {}) => ({
  sourceType: "GenericDocument" as const,
  values,
  provenance: {},
  warnings: []
});

function fakeApi(options: { writer?: boolean; readFails?: boolean } = {}) {
  const tasks = ["summarization", "atomic-note-generation", "knowledge-graph-generation"];
  const api = {
    ai: {
      listProfiles: vi.fn(async () => {
        if (options.readFails) throw new Error("offline");
        return options.writer
          ? [
              {
                id: profile,
                isDefault: true,
                status: "active",
                providerConfigId: provider,
                localModelId: null,
                modelId: "writer",
                capabilities: [
                  "summarization",
                  "atomic-note-generation",
                  "knowledge-graph-generation",
                  "structured-output"
                ]
              }
            ]
          : [];
      }),
      listProfileTasks: vi.fn(async () =>
        options.writer ? tasks.map((task) => ({ profileId: profile, task })) : []
      ),
      listTaskRoutes: vi.fn(async () => []),
      listProviders: vi.fn(async () => [{ id: provider, secretConfigured: true }])
    },
    localModels: { statuses: vi.fn(async () => []) },
    ingestion: {
      extractFileMetadata: vi.fn(async () => ({
        fileToken: token,
        fileName: "aula-05.pdf",
        mimeType: "application/pdf",
        draft: draft({ title: "Aula 05" })
      })),
      prepareDroppedFiles: vi.fn(async (files: readonly { name: string }[]) =>
        files.map((file) => ({
          status: "ready" as const,
          fileToken: token,
          name: file.name,
          size: 10,
          kind: "pdf" as const,
          mimeType: "application/pdf",
          draft: draft()
        }))
      ),
      importFile: vi.fn(async (input: unknown) => ({ sourceItemId: sourceId, input }))
    }
  };
  return api;
}

function flowOver(api: ReturnType<typeof fakeApi>, storage: Storage | null = null) {
  const openSource = vi.fn();
  const openImportPanel = vi.fn();
  const flow = new AddFlow({
    api: () => api as never,
    openSource,
    openImportPanel,
    storage
  });
  return { flow, openSource, openImportPanel };
}

describe("the Add menu model", () => {
  it("lists the file picker first with Cmd-N, then a link and a note, and the panel last", () => {
    expect(addMenuEntries.map((entry) => entry.id)).toEqual(["file", "link", "note"]);
    expect(addMenuEntries[0]).toMatchObject({ action: "pickFile", shortcut: "⌘N" });
    expect(addMenuEntries[1]?.action).toBe("openImportPanel");
    expect(addMoreEntry).toEqual({ id: "more", action: "openImportPanel" });
  });

  it("is the shortcut the keymap gives Cmd-N", () => {
    expect(
      keymap({ key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })
    ).toEqual({ type: "newImport" });
  });

  it("offers three modes, mapped to the F4 presets, defaulting to the writer's readiness", () => {
    expect(importModes).toEqual(["secondBrain", "searchable", "storeOnly"]);
    expect(planOfMode("secondBrain").preset).toBe("full_knowledge");
    expect(planOfMode("searchable").preset).toBe("search_ready");
    expect(planOfMode("storeOnly").preset).toBe("import_only");
    expect(defaultMode({ status: "ready", writer: true })).toBe("secondBrain");
    expect(defaultMode({ status: "ready", writer: false })).toBe("searchable");
    expect(defaultMode({ status: "loading" })).toBe("searchable");
    expect(defaultMode({ status: "error" })).toBe("searchable");
    expect(effectiveMode("storeOnly", { status: "ready", writer: true })).toBe("storeOnly");
  });

  it("says why Segundo cérebro is or is not recommended", () => {
    expect(modeCopy("secondBrain", { status: "ready", writer: true }).hint).toBe(
      "addFlow.modes.secondBrain.hintRecommended"
    );
    expect(modeCopy("secondBrain", { status: "ready", writer: false }).hint).toBe(
      "addFlow.modes.secondBrain.hintNeedsModel"
    );
    expect(modeCopy("secondBrain", { status: "loading" }).hint).toBe(
      "addFlow.modes.secondBrain.hint"
    );
  });

  it("reports the surfaces' four states", () => {
    const idle = { busy: null, failure: null };
    expect(addMenuState({ ...idle, readiness: { status: "loading" } })).toBe("loading");
    expect(addMenuState({ ...idle, readiness: { status: "error" } })).toBe("error");
    expect(addMenuState({ ...idle, readiness: { status: "ready", writer: false } })).toBe("empty");
    expect(addMenuState({ ...idle, readiness: { status: "ready", writer: true } })).toBe("success");
    expect(
      addMenuState({
        busy: { name: null, waiting: 0 },
        failure: null,
        readiness: { status: "ready", writer: true }
      })
    ).toBe("loading");
    expect(dropOverlayState({ status: "ready", writer: false })).toBe("empty");
  });
});

describe("the descriptor of a quick add", () => {
  it("takes the file's own title and creators, else the file name", () => {
    const withMeta = descriptorFromFile({
      fileName: "aula-05.pdf",
      mimeType: "application/pdf",
      draft: draft({ title: "Aula 05", creators: [{ name: "R. Andrade", role: "author" }] })
    });
    expect(withMeta).toMatchObject({ type: "GenericDocument", title: "Aula 05" });
    expect(withMeta.creators).toHaveLength(1);
    expect(
      descriptorFromFile({
        fileName: "notas-de-campo.md",
        mimeType: "text/markdown",
        draft: draft()
      }).title
    ).toBe("notas-de-campo");
    expect(titleFromFileName("a.b.pdf")).toBe("a.b");
  });

  it("never refuses the file over a field the schema does not take", () => {
    const descriptor = descriptorFromFile({
      fileName: "x.pdf",
      mimeType: "application/pdf",
      draft: draft({ creators: [{ nome: "sem role" }], language: "x" })
    });
    expect(descriptor.title).toBe("x");
    expect(descriptor.creators).toEqual([]);
  });
});

describe("the Add flow", () => {
  it("opens the file picker, imports with the mode's plan and pushes the Source", async () => {
    const api = fakeApi({ writer: true });
    const { flow, openSource } = flowOver(api);
    await flow.pickFile();
    expect(api.ingestion.extractFileMetadata).toHaveBeenCalledTimes(1);
    const input = api.ingestion.importFile.mock.calls[0]![0] as never as {
      fileToken: string;
      processingPlan: { preset: string };
      descriptor: { title: string };
    };
    expect(input.fileToken).toBe(token);
    expect(input.processingPlan.preset).toBe("full_knowledge");
    expect(input.descriptor.title).toBe("Aula 05");
    expect(openSource).toHaveBeenCalledWith(sourceId);
    expect(flow.getSnapshot().busy).toBeNull();
    expect(flow.getSnapshot().failure).toBeNull();
  });

  it("steps the default down to searchable when no model can write", async () => {
    const api = fakeApi({ writer: false });
    const { flow } = flowOver(api);
    await flow.pickFile();
    expect(
      (
        api.ingestion.importFile.mock.calls[0]![0] as never as {
          processingPlan: { preset: string };
        }
      ).processingPlan.preset
    ).toBe("search_ready");
  });

  it("uses the mode the person chose, and remembers it", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    } as Storage;
    const api = fakeApi({ writer: true });
    const { flow } = flowOver(api, storage);
    flow.chooseMode("storeOnly");
    await flow.pickFile();
    expect(
      (
        api.ingestion.importFile.mock.calls[0]![0] as never as {
          processingPlan: { preset: string };
        }
      ).processingPlan.preset
    ).toBe("import_only");
    expect(store.get(addModeStorageKey)).toBe("storeOnly");
    expect(flowOver(fakeApi(), storage).flow.getSnapshot().chosen).toBe("storeOnly");
  });

  it("says nothing when the picker is canceled", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.extractFileMetadata.mockResolvedValueOnce(null as never);
    const { flow, openSource } = flowOver(api);
    await flow.pickFile();
    expect(openSource).not.toHaveBeenCalled();
    expect(api.ingestion.importFile).not.toHaveBeenCalled();
    expect(flow.getSnapshot().failure).toBeNull();
  });

  it("tells an unreadable file in place, never throws, and opens nothing", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.extractFileMetadata.mockRejectedValueOnce(new Error("errors.ingestion.noText"));
    const { flow, openSource } = flowOver(api);
    await expect(flow.pickFile()).resolves.toBeUndefined();
    expect(openSource).not.toHaveBeenCalled();
    // The reason main gives is kept, not flattened into the generic sentence.
    expect(flow.getSnapshot().failure).toEqual({
      reason: "noText",
      name: null,
      more: 0,
      saved: false
    });
    flow.dismissFailure();
    expect(flow.getSnapshot().failure).toBeNull();
  });

  it("falls back to the generic sentence only for an error with no reason of its own", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.extractFileMetadata.mockRejectedValueOnce(new Error("kaboom"));
    const { flow } = flowOver(api);
    await flow.pickFile();
    expect(flow.getSnapshot().failure).toMatchObject({ reason: "generic", name: null });
  });

  it("names the file when the import fails after the picker returned it", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.importFile.mockRejectedValueOnce(new Error("errors.common.validationFailed"));
    const { flow } = flowOver(api);
    await flow.pickFile();
    expect(flow.getSnapshot().failure).toMatchObject({ reason: "unreadable", name: "aula-05.pdf" });
  });

  it("imports a drop at once: the first Source opens, the others wait their turn", async () => {
    const api = fakeApi({ writer: true });
    const { flow, openSource } = flowOver(api);
    await flow.importDropped([{ name: "a.pdf" }, { name: "b.md" }, { name: "c.txt" }]);
    expect(api.ingestion.prepareDroppedFiles).toHaveBeenCalledTimes(3);
    expect(api.ingestion.importFile).toHaveBeenCalledTimes(3);
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().busy).toBeNull();
  });

  it("tells a refused file by name and still imports the rest", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.prepareDroppedFiles.mockImplementationOnce((async () => [
      { status: "refused", name: "pacote.zip", reason: "unsupported" }
    ]) as never);
    const { flow, openSource } = flowOver(api);
    await flow.importDropped([{ name: "pacote.zip" }, { name: "b.md" }]);
    expect(api.ingestion.importFile).toHaveBeenCalledTimes(1);
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().failure).toEqual({
      reason: "unsupported",
      name: "pacote.zip",
      more: 0,
      saved: true
    });
  });

  it("imports files dropped while the picker's file is still being read, once it is done", async () => {
    const api = fakeApi({ writer: true });
    let release: (value: unknown) => void = () => undefined;
    api.ingestion.extractFileMetadata.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never
    );
    const { flow, openSource } = flowOver(api);
    const picking = flow.pickFile();
    await vi.waitFor(() => expect(api.ingestion.extractFileMetadata).toHaveBeenCalledTimes(1));
    await flow.importDropped([{ name: "notas.md" }]);
    // It waits: the caption counts it and nothing has been prepared yet.
    expect(flow.getSnapshot().busy?.waiting).toBe(1);
    expect(api.ingestion.prepareDroppedFiles).not.toHaveBeenCalled();
    release({
      fileToken: token,
      fileName: "aula-05.pdf",
      mimeType: "application/pdf",
      draft: draft({ title: "Aula 05" })
    });
    await picking;
    expect(api.ingestion.prepareDroppedFiles).toHaveBeenCalledTimes(1);
    expect(api.ingestion.importFile).toHaveBeenCalledTimes(2);
    // The picked file opened; the dropped one waited its turn.
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().busy).toBeNull();
  });

  it("imports files dropped while an earlier drop runs, then ends the run", async () => {
    const api = fakeApi({ writer: true });
    let release: () => void = () => undefined;
    api.ingestion.importFile.mockImplementationOnce((async (input: unknown) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { sourceItemId: sourceId, input };
    }) as never);
    const { flow } = flowOver(api);
    const first = flow.importDropped([{ name: "a.pdf" }]);
    await vi.waitFor(() => expect(api.ingestion.importFile).toHaveBeenCalledTimes(1));
    await flow.importDropped([{ name: "b.md" }]);
    release();
    await first;
    expect(api.ingestion.importFile).toHaveBeenCalledTimes(2);
    expect(flow.getSnapshot().busy).toBeNull();
  });

  it("tells the first failure of a run, counts the others, and says what was kept", async () => {
    const api = fakeApi({ writer: true });
    const refused = (name: string) => ({ status: "refused", name, reason: "unsupported" }) as const;
    api.ingestion.prepareDroppedFiles
      .mockImplementationOnce((async () => [refused("a.zip")]) as never)
      .mockImplementationOnce((async () => [refused("b.zip")]) as never);
    const { flow } = flowOver(api);
    await flow.importDropped([{ name: "a.zip" }, { name: "b.zip" }, { name: "c.md" }]);
    expect(flow.getSnapshot().failure).toEqual({
      reason: "unsupported",
      name: "a.zip",
      more: 1,
      saved: true
    });
  });

  it("holds the notice back until the run ends, so its retry finds the flow free", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.prepareDroppedFiles.mockImplementationOnce((async () => [
      { status: "refused", name: "a.zip", reason: "unsupported" }
    ]) as never);
    let release: () => void = () => undefined;
    api.ingestion.importFile.mockImplementationOnce((async (input: unknown) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { sourceItemId: sourceId, input };
    }) as never);
    const { flow } = flowOver(api);
    const run = flow.importDropped([{ name: "a.zip" }, { name: "b.md" }]);
    await vi.waitFor(() => expect(api.ingestion.importFile).toHaveBeenCalledTimes(1));
    expect(flow.getSnapshot().failure).toBeNull();
    release();
    await run;
    expect(flow.getSnapshot().failure).not.toBeNull();
    await flow.pickFile();
    expect(api.ingestion.extractFileMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed read of the mode as an error and falls back to a safe default", async () => {
    const api = fakeApi({ readFails: true });
    const { flow } = flowOver(api);
    await flow.ensureReadiness();
    expect(flow.getSnapshot().readiness).toEqual({ status: "error" });
    expect(flow.getSnapshot().mode).toBe("searchable");
    await flow.pickFile();
    expect(api.ingestion.importFile).toHaveBeenCalledTimes(1);
  });

  it("opens the advanced panel and clears a notice that was showing", async () => {
    const api = fakeApi({ writer: true });
    api.ingestion.extractFileMetadata.mockRejectedValueOnce(new Error("kaboom"));
    const { flow, openImportPanel } = flowOver(api);
    await flow.pickFile();
    expect(flow.getSnapshot().failure).not.toBeNull();
    flow.openImportPanel();
    expect(openImportPanel).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().failure).toBeNull();
  });
});

describe("what the workspace does for Adicionar", () => {
  const run = (actions: ReturnType<typeof showSourceActions>) =>
    actions.reduce((state, action) => reduce(state, action), defaultWorkspace("2026-11-12"));

  it("pushes the new Source onto Explore's stack and shows Explore", () => {
    const state = run(showSourceActions(sourceId));
    expect(state.destination).toBe("explore");
    const stack = state.stacks.explore;
    expect(stack.panels).toHaveLength(1);
    expect(stack.panels[0]?.history).toEqual([`memora://source/${sourceId}`]);
    expect(stack.focus).toBe(0);
  });

  it("opens the import panel on Explore's stack", () => {
    const state = run(showImportPanelActions(-1));
    expect(state.destination).toBe("explore");
    expect(state.stacks.explore.panels[0]?.history).toEqual(["memora://import"]);
  });
});
