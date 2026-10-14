import { describe, expect, it } from "vitest";

import { createStableCallback } from "./stable-callback";

describe("stable callback", () => {
  it("keeps one identity while always calling the latest implementation", () => {
    const calls: string[] = [];
    const stable = createStableCallback((id: string) => calls.push(`first:${id}`));
    const identity = stable.call;

    identity("a");
    stable.update((id: string) => calls.push(`second:${id}`));
    identity("b");

    expect(stable.call).toBe(identity);
    expect(calls).toEqual(["first:a", "second:b"]);
  });

  it("returns the latest implementation's result", () => {
    const stable = createStableCallback((value: number) => value + 1);
    const identity = stable.call;
    stable.update((value: number) => value * 10);
    expect(identity(4)).toBe(40);
  });
});
