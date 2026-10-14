import { describe, expect, it, vi } from "vitest";

import {
  isSilentRefresh,
  showsLoadError,
  syncModalDialog,
  type LoadOutcome,
  type ModalDialog
} from "./hidden-view";

const loaded = (overrides: Partial<LoadOutcome> = {}): LoadOutcome => ({
  key: "list",
  ok: true,
  hasData: true,
  ...overrides
});

describe("refreshing a view that was hidden", () => {
  it("is silent only when the key is unchanged and the previous load succeeded", () => {
    expect(isSilentRefresh(true, loaded(), "list")).toBe(true);
    // Never hidden, never loaded, or changed while hidden: a normal load with a loading state.
    expect(isSilentRefresh(false, loaded(), "list")).toBe(false);
    expect(isSilentRefresh(true, null, "list")).toBe(false);
    expect(isSilentRefresh(true, loaded(), "other")).toBe(false);
    // A load that failed before leaves nothing valid to keep showing.
    expect(isSilentRefresh(true, loaded({ ok: false, hasData: false }), "list")).toBe(false);
  });

  it("shows every failure of a normal load", () => {
    expect(showsLoadError({ silent: false, previous: loaded(), key: "list" })).toBe(true);
    expect(showsLoadError({ silent: false, previous: null, key: "list" })).toBe(true);
  });

  it("lets a silent failure pass only while there is previous data of the same key to keep", () => {
    expect(showsLoadError({ silent: true, previous: loaded(), key: "list" })).toBe(false);
    // No data to keep (an empty result would read as "nothing here"), a failed previous load, or a
    // key that changed: the error must surface so it can be retried.
    expect(
      showsLoadError({ silent: true, previous: loaded({ hasData: false }), key: "list" })
    ).toBe(true);
    expect(showsLoadError({ silent: true, previous: loaded({ ok: false }), key: "list" })).toBe(
      true
    );
    expect(showsLoadError({ silent: true, previous: loaded(), key: "other" })).toBe(true);
    expect(showsLoadError({ silent: true, previous: null, key: "list" })).toBe(true);
  });
});

describe("modal dialogs of a hidden view", () => {
  function fakeDialog(open = false) {
    const dialog = {
      open,
      showModal: vi.fn(() => {
        dialog.open = true;
      }),
      close: vi.fn(() => {
        dialog.open = false;
      })
    };
    return dialog satisfies ModalDialog;
  }

  it("closes an open modal when the view is hidden and opens it again when shown", () => {
    const dialog = fakeDialog();
    syncModalDialog(dialog, true);
    expect(dialog.open).toBe(true);
    syncModalDialog(dialog, false);
    expect(dialog.open).toBe(false);
    syncModalDialog(dialog, true);
    expect(dialog.showModal).toHaveBeenCalledTimes(2);
  });

  it("never opens a modal twice or closes one that is closed", () => {
    const open = fakeDialog(true);
    syncModalDialog(open, true);
    expect(open.showModal).not.toHaveBeenCalled();
    const closed = fakeDialog(false);
    syncModalDialog(closed, false);
    expect(closed.close).not.toHaveBeenCalled();
    expect(() => syncModalDialog(null, true)).not.toThrow();
  });
});
