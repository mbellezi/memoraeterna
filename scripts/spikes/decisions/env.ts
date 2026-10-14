/**
 * Reads the OpenAI Platform key for the Decisions spike from the gitignored `.env`.
 *
 * The key is parsed line by line (no dotenv dependency, no other variable is read), kept only in
 * the caller's memory, and never printed, logged, persisted or exported through `process.env`.
 * `redactSecrets` scrubs any text that may echo it (provider errors, debug output).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
export const apiKeyVariable = "OPENAPI_KEY";

export function parseApiKey(contents: string): string | null {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${apiKeyVariable}\\s*=\\s*(.*)$`);
  const text = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trimStart().startsWith("#")) continue;
    const match = pattern.exec(rawLine);
    if (!match) continue;
    let value = match[1]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function readApiKey(envPath = join(repositoryRoot, ".env")): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(envPath, "utf8");
  } catch {
    throw new Error(`Cannot read the environment file for ${apiKeyVariable}`);
  }
  const key = parseApiKey(contents);
  if (key === null) throw new Error(`${apiKeyVariable} is not set in the environment file`);
  if (/\s/.test(key)) throw new Error(`${apiKeyVariable} is malformed`);
  return key;
}

/** Replaces known secrets and anything that looks like an API key or bearer token. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
}
