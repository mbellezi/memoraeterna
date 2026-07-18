import { describe, expect, it } from "vitest";

import { addToast, maxVisibleToasts, removeToast, type ToastItem } from "./toast";

function toast(id: number): ToastItem {
  return { id, text: `Toast ${id}`, tone: "info" };
}

describe("toast stack", () => {
  it("appends toasts and keeps only the newest ones up to the cap", () => {
    let toasts: ToastItem[] = [];
    for (let id = 1; id <= maxVisibleToasts + 2; id += 1) {
      toasts = addToast(toasts, toast(id));
    }
    expect(toasts).toHaveLength(maxVisibleToasts);
    expect(toasts[0]?.id).toBe(3);
    expect(toasts.at(-1)?.id).toBe(maxVisibleToasts + 2);
  });

  it("removes a toast by id and ignores unknown ids", () => {
    const toasts = [toast(1), toast(2)];
    expect(removeToast(toasts, 1).map((item) => item.id)).toEqual([2]);
    expect(removeToast(toasts, 99)).toHaveLength(2);
  });
});
