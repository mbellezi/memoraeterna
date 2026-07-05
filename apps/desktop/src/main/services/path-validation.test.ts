import { describe, expect, it } from "vitest";
import { validateAbsolutePath, validateManagedRoot } from "./path-validation";

describe("path validation", () => {
  it("accepts absolute paths without traversal", () => {
    expect(validateAbsolutePath("/Users/name/Vault")).toEqual({ ok: true });
  });

  it("rejects relative, traversal, and null-byte paths", () => {
    expect(validateAbsolutePath("relative/path").ok).toBe(false);
    expect(validateAbsolutePath("/Users/name/../Vault").ok).toBe(false);
    expect(validateAbsolutePath("/Users/name/\0Vault").ok).toBe(false);
  });

  it("accepts managed roots that stay relative to the vault", () => {
    expect(validateManagedRoot("Memora")).toEqual({ ok: true });
    expect(validateManagedRoot("Knowledge/Memora")).toEqual({ ok: true });
  });

  it("rejects managed roots that escape the vault", () => {
    expect(validateManagedRoot("/Users/name/Memora").ok).toBe(false);
    expect(validateManagedRoot("../Memora").ok).toBe(false);
    expect(validateManagedRoot("").ok).toBe(false);
  });
});
