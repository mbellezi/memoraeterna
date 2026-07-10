import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { safeStorage } from "electron";

interface CredentialFile {
  version: 1;
  secrets: Record<string, string>;
}

export class CredentialService {
  private readonly path: string;

  public constructor(userDataPath: string) {
    this.path = join(userDataPath, "credentials", "ai-secrets.json");
  }

  public async save(secret: string, existingRef?: string | null): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("errors.ai.secureStorageUnavailable");
    const file = await this.read();
    const reference = existingRef ?? `ai:${randomUUID()}`;
    file.secrets[reference] = safeStorage.encryptString(secret).toString("base64");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    return reference;
  }

  public async get(reference: string): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("errors.ai.secureStorageUnavailable");
    const encrypted = (await this.read()).secrets[reference];
    if (!encrypted) throw new Error("errors.ai.missingCredential");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  private async read(): Promise<CredentialFile> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<CredentialFile>;
      if (value.version === 1 && value.secrets && typeof value.secrets === "object") {
        return { version: 1, secrets: value.secrets };
      }
    } catch {
      // A missing file is the expected first-use state.
    }
    return { version: 1, secrets: {} };
  }
}
