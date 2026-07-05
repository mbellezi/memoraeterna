import { describe, expect, it } from "vitest";

import { resolvePostgresSidecarPaths } from "./paths.js";

describe("resolvePostgresSidecarPaths", () => {
  it("uses an explicit sidecar root when configured", () => {
    expect(
      resolvePostgresSidecarPaths({
        env: {
          MEMORA_POSTGRES_SIDECAR_ROOT: "/tmp/postgres"
        }
      })
    ).toMatchObject({
      rootDir: "/tmp/postgres",
      binDir: "/tmp/postgres/bin"
    });
  });

  it("uses dev vendor path when resourcesPath is not provided", () => {
    expect(
      resolvePostgresSidecarPaths({
        cwd: "/repo",
        platform: "darwin",
        arch: "arm64",
        env: {}
      }).rootDir
    ).toBe("/repo/vendor/sidecars/postgres/darwin-arm64/postgresql-18.4");
  });

  it("uses production resources path when provided", () => {
    expect(
      resolvePostgresSidecarPaths({
        resourcesPath: "/Applications/Memora.app/Contents/Resources",
        platform: "darwin",
        arch: "arm64",
        env: {}
      }).binDir
    ).toBe("/Applications/Memora.app/Contents/Resources/sidecars/postgres/darwin-arm64/postgresql-18.4/bin");
  });
});
