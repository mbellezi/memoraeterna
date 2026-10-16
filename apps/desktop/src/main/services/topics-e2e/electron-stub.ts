// The slice of Electron that the main-process services touch, for the zero-config end-to-end test
// (F2 T32), which runs under Node and never starts Electron. `safeStorage` encrypts with a key that
// lives only in this process (a scratch credential store cannot be read after the run), `dialog`
// answers like a user who picks the file the harness names, and the rest does nothing.
//
// `installElectronStub` makes `import ... from "electron"` resolve to this stub (Node module hooks),
// so call it before the first import of a service. Vitest mocks the module with `electronModule`.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";

export const electronStubKey = "__memoraTopicsE2eElectron";

export interface ElectronStubOptions {
  /** `app.getLocale()`: the desktop locale that decides the default content language. */
  locale?: string;
}

export interface ElectronStub {
  /** The named exports of the stubbed `electron` module. */
  module: Record<string, unknown>;
  /** The file the next open dialog returns, like a user choosing it; `null` cancels the dialog. */
  chooseFile(path: string | null): void;
  /** Open dialogs shown so far. */
  dialogCalls(): number;
}

export function createElectronStub(options: ElectronStubOptions = {}): ElectronStub {
  const key = randomBytes(32);
  let chosen: string | null = null;
  let dialogs = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string): Buffer => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (value: Buffer): string => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8"
      );
    }
  };
  const dialog = {
    showOpenDialog: async () => {
      dialogs += 1;
      const path = chosen;
      chosen = null;
      return { canceled: path === null, filePaths: path === null ? [] : [path] };
    }
  };
  const app = {
    isPackaged: false,
    getLocale: () => options.locale ?? "en",
    getPath: () => "",
    getName: () => "Memora Eterna"
  };
  return {
    module: {
      safeStorage,
      dialog,
      app,
      session: { defaultSession: { clearCache: async () => undefined } },
      shell: { openPath: async () => "", openExternal: async () => undefined },
      webContents: { getAllWebContents: () => [] }
    },
    chooseFile: (path) => {
      chosen = path;
    },
    dialogCalls: () => dialogs
  };
}

/** Source of the module `electron` resolves to: it re-exports the stub kept on `globalThis`. */
export function electronStubModuleSource(names: readonly string[]): string {
  return [
    `const stub = globalThis[${JSON.stringify(electronStubKey)}];`,
    ...names.map((name) => `export const ${name} = stub[${JSON.stringify(name)}];`),
    "export default stub;",
    ""
  ].join("\n");
}

/** Makes `electron` resolve to the stub until the returned function runs. */
export function installElectronStub(stub: ElectronStub): () => void {
  (globalThis as Record<string, unknown>)[electronStubKey] = stub.module;
  const url = `data:text/javascript,${encodeURIComponent(
    electronStubModuleSource(Object.keys(stub.module))
  )}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron" ? { url, shortCircuit: true } : next(specifier, context);
    }
  });
  return () => {
    hook.deregister();
    delete (globalThis as Record<string, unknown>)[electronStubKey];
  };
}

let shared: ElectronStub | null = null;

/** One stub for the whole process, for tests that mock the `electron` module with it. */
export function sharedElectronStub(): ElectronStub {
  shared ??= createElectronStub({ locale: "pt-BR" });
  return shared;
}
