import { describe, expect, it } from "vitest";

import {
  createElectronStub,
  electronStubKey,
  electronStubModuleSource,
  installElectronStub
} from "./electron-stub.js";

describe("the Electron stub", () => {
  it("encrypts with a key that lives in the process and decrypts what it encrypted", () => {
    const { module } = createElectronStub();
    const storage = module.safeStorage as {
      isEncryptionAvailable(): boolean;
      encryptString(text: string): Buffer;
      decryptString(value: Buffer): string;
    };
    expect(storage.isEncryptionAvailable()).toBe(true);
    const secret = "sk-test-secret";
    const encrypted = storage.encryptString(secret);
    expect(encrypted.toString("utf8")).not.toContain(secret);
    expect(encrypted.toString("base64")).not.toContain(Buffer.from(secret).toString("base64"));
    expect(storage.decryptString(encrypted)).toBe(secret);
    // Another process (another stub) has another key and cannot read it.
    const other = createElectronStub().module.safeStorage as typeof storage;
    expect(() => other.decryptString(encrypted)).toThrow();
  });

  it("answers the open dialog with the file the harness chose, once", async () => {
    const stub = createElectronStub();
    const dialog = stub.module.dialog as {
      showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    stub.chooseFile("/papers/p.pdf");
    expect(await dialog.showOpenDialog()).toEqual({
      canceled: false,
      filePaths: ["/papers/p.pdf"]
    });
    expect(await dialog.showOpenDialog()).toEqual({ canceled: true, filePaths: [] });
    expect(stub.dialogCalls()).toBe(2);
  });

  it("reports the locale of the fresh profile", () => {
    const app = createElectronStub({ locale: "pt-BR" }).module.app as { getLocale(): string };
    expect(app.getLocale()).toBe("pt-BR");
  });

  it("makes `electron` resolve to the stub until it is uninstalled", async () => {
    const stub = createElectronStub({ locale: "fr" });
    const uninstall = installElectronStub(stub);
    try {
      expect((globalThis as Record<string, unknown>)[electronStubKey]).toBe(stub.module);
      const source = electronStubModuleSource(Object.keys(stub.module));
      expect(source).toContain('export const safeStorage = stub["safeStorage"];');
      expect(source).toContain("export default stub;");
    } finally {
      uninstall();
    }
    expect((globalThis as Record<string, unknown>)[electronStubKey]).toBeUndefined();
  });
});
