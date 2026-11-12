import { describe, expect, it } from "vitest";

import { guardTestsFor } from "./guard-tests.mjs";

const sandbox = "scripts/lib/verify-sandbox-preload.test.ts";

describe("guardTestsFor", () => {
  it("names the sandbox preload test for every file the bundled preload reads", () => {
    for (const file of [
      "apps/desktop/src/preload/index.ts",
      "apps/desktop/src/shared/app-events.ts",
      "apps/desktop/electron.vite.config.ts",
      "packages/domain/src/object-address.ts",
      "scripts/verify-sandbox-preload.mjs"
    ]) {
      expect(guardTestsFor([file]), file).toEqual([sandbox]);
    }
  });

  it("names nothing for files outside the preload's reach and lists a test once", () => {
    expect(guardTestsFor(["apps/desktop/src/renderer/App.tsx", "docs/plan.md"])).toEqual([]);
    expect(
      guardTestsFor(["apps/desktop/src/preload/index.ts", "apps/desktop/src/shared/ipc.ts"])
    ).toEqual([sandbox]);
  });
});
