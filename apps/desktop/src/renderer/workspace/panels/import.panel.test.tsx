// The DOM globals must exist before anything loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import type { LeaveGuard } from "../panel-guards";
import { Component } from "./import.panel";

// The wizard and the native dialog are not what is tested: the panel's guard is. The stubs expose
// what the panel gives them.
let wizard: {
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (id: string) => void;
  metadataEnrichmentEnabled?: boolean;
  editing?: unknown;
} = {};
vi.mock("../../components/ImportView", () => ({
  ImportView: (props: typeof wizard) => {
    wizard = props;
    return <div data-testid="wizard" />;
  }
}));
vi.mock("../../components/note-page/NoteLeaveDialog", () => ({
  NoteLeaveDialog: (props: { onKeepEditing: () => void; onDiscard: () => void }) => (
    <div role="alertdialog">
      <button id="keep" onClick={props.onKeepEditing} />
      <button id="discard" onClick={props.onDiscard} />
    </div>
  )
}));

const en = createTranslator("en");
let dom: TestDom;
let guard: LeaveGuard | null;
const onOpen = vi.fn();

beforeEach(async () => {
  guard = null;
  wizard = {};
  onOpen.mockReset();
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    settings: { getApp: async () => ({ metadataEnrichmentEnabled: true }) },
    knowledge: { getSourceDetail: async () => null }
  };
  await dom.render(
    <Component
      t={en}
      address="memora://import"
      mode="full"
      active
      onState={() => undefined}
      onPlace={() => undefined}
      onOpen={onOpen}
      onLeaveGuard={(next) => {
        guard = next;
      }}
    />
  );
  await dom.act(async () => undefined);
});
afterEach(async () => {
  await dom.dispose();
});

const dialog = () => dom.document.querySelector('[role="alertdialog"]');
const press = (id: string) =>
  dom.act(
    () =>
      void dom.document
        .getElementById(id)
        ?.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  );

describe("the advanced import panel's leave guard", () => {
  it("registers a guard, and lets a clean wizard go at once", () => {
    expect(guard).not.toBeNull();
    const go = vi.fn();
    guard?.(go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("asks before an entered form is dropped, and keeps it on Keep working", async () => {
    await dom.act(() => wizard.onDirtyChange?.(true));
    const go = vi.fn();
    await dom.act(() => guard?.(go));
    expect(go).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    await press("keep");
    expect(go).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("lets the move go once the person discards", async () => {
    await dom.act(() => wizard.onDirtyChange?.(true));
    const go = vi.fn();
    await dom.act(() => guard?.(go));
    await press("discard");
    expect(go).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("never asks about the move a save makes, and is clean again after it", async () => {
    await dom.act(() => wizard.onDirtyChange?.(true));
    await dom.act(() => wizard.onSaved?.("00000000-0000-4000-8000-000000000042"));
    expect(onOpen).toHaveBeenCalledWith("memora://source/00000000-0000-4000-8000-000000000042", {
      replace: true
    });
    const go = vi.fn();
    guard?.(go);
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe("the advanced import panel's first read", () => {
  // The shared setup already mounted a healthy new import: start again on a fresh DOM.
  const setApp = async (app: unknown) => {
    await dom.dispose();
    dom = createTestDom();
    (dom.window as unknown as { app: unknown }).app = app;
  };
  const mountAt = async (address: string) => {
    await dom.render(
      <Component
        t={en}
        address={address}
        mode="full"
        active
        onState={() => undefined}
        onPlace={() => undefined}
        onOpen={onOpen}
      />
    );
    await dom.act(async () => undefined);
  };
  const failing = async () => {
    throw new Error("settings could not be read");
  };

  it("opens a new import with the metadata lookup off when the settings cannot be read", async () => {
    wizard = {};
    await setApp({
      settings: { getApp: failing },
      knowledge: { getSourceDetail: async () => null }
    });
    await mountAt("memora://import");
    expect(dom.document.querySelector('[data-testid="wizard"]')).not.toBeNull();
    expect(wizard.metadataEnrichmentEnabled).toBe(false);
    expect(dom.document.body.textContent).not.toContain("could not be opened");
  });

  it("tells a source that cannot be opened for editing only at the edit address", async () => {
    wizard = {};
    await setApp({
      settings: { getApp: failing },
      knowledge: { getSourceDetail: async () => null }
    });
    await mountAt("memora://import?source=00000000-0000-4000-8000-000000000042");
    expect(dom.document.querySelector('[data-testid="wizard"]')).toBeNull();
    expect(dom.document.body.textContent).toContain("This source could not be opened for editing.");
    expect(dom.document.body.textContent).toContain("Retry");
  });
});
