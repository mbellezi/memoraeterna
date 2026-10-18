import { describe, expect, it, vi } from "vitest";

import { isWebGLAvailable } from "./webgl";

describe("the WebGL probe", () => {
  it("is true when a WebGL 2 or a WebGL context can be made, and releases it", () => {
    const loseContext = vi.fn();
    const context = { getExtension: () => ({ loseContext }) };
    expect(
      isWebGLAvailable(() => ({ getContext: (type) => (type === "webgl2" ? context : null) }))
    ).toBe(true);
    expect(loseContext).toHaveBeenCalledOnce();
    expect(isWebGLAvailable(() => ({ getContext: (type) => (type === "webgl" ? {} : null) }))).toBe(
      true
    );
  });

  it("is false when no context can be made, or the window cannot make a canvas at all", () => {
    expect(isWebGLAvailable(() => ({ getContext: () => null }))).toBe(false);
    expect(
      isWebGLAvailable(() => {
        throw new Error("no canvas");
      })
    ).toBe(false);
    expect(
      isWebGLAvailable(() => ({
        getContext: () => {
          throw new Error("blocked");
        }
      }))
    ).toBe(false);
    // Without a document (a test, a server render) there is nothing to draw on.
    expect(isWebGLAvailable()).toBe(false);
  });
});
