import { jobTaskPayload } from "../job-task-payload.js";
import {
  mkdir,
  rename,
  stat,
  lstat,
  readFile,
  open,
  link,
  unlink,
  realpath,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, sep, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { normalizeProjectionText } from "@app/integration-contracts";
import { z } from "zod";
const writePayloadSchema = z
  .object({
    action: z.literal("write"),
    vaultPath: z.string().min(1),
    relativePath: z.string().min(1),
    content: z.string().max(2000000),
    expectedHash: z.string().nullable().optional(),
    recoveryId: z.string().uuid().optional(),
    managedRoot: z.string().optional()
  })
  .strict();
const archivePayloadSchema = z
  .object({
    action: z.literal("archive"),
    vaultPath: z.string().min(1),
    relativePath: z.string().min(1),
    managedRoot: z.string().min(1),
    /** One folder per retire pass under `.memora-recovery/retired-wiki`. */
    stamp: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** The registered hash. Without it the bytes found are archived as they are (explicit user action). */
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
const payloadSchema = z.discriminatedUnion("action", [writePayloadSchema, archivePayloadSchema]);
export type ObsidianArchiveInput = Omit<z.infer<typeof archivePayloadSchema>, "action">;
export type ObsidianArchiveResult =
  { outcome: "archived"; archivedPath: string } | { outcome: "absent" };
const hash = (text: string) =>
  createHash("sha256").update(normalizeProjectionText(text)).digest("hex");
export async function safeVaultPath(vault: string, path: string): Promise<string> {
  const root = await realpath(vault),
    target = resolve(root, path);
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || !target.startsWith(`${root}${sep}`))
    throw new Error("unsafe_obsidian_path");
  // Include the vault itself and every existing ancestor: lexical containment alone is insufficient.
  let current = root;
  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("unsafe_obsidian_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
async function readOptional(path: string) {
  try {
    if ((await stat(path)).size > 2000000) throw new Error("obsidianWiki.errors.limit");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Reads a regular file without following a final symlink; `null` when it does not exist. */
export async function readRegularFile(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("unsafe_obsidian_symlink", { cause: error });
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("unsafe_obsidian_path");
    if (info.size > 2_000_000) throw new Error("obsidianWiki.errors.limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Moves one retired projection file into `<managedRoot>/.memora-recovery/retired-wiki/<stamp>/`,
 * keeping its path below the managed root. The copy is created exclusively. The original is then
 * moved out with an atomic rename and its actual bytes are compared with the copy (and with the
 * registered hash, when given): a late edit puts the file back and fails with a conflict, so an
 * edited file is never removed. Symlinks anywhere on either path are rejected.
 */
export async function archiveObsidianFile(
  input: ObsidianArchiveInput,
  /** Test seam: runs between the copy and the move, where a late edit would land. */
  hooks: { afterCopy?: () => Promise<void> } = {}
): Promise<ObsidianArchiveResult> {
  const rest = input.relativePath.slice(input.managedRoot.length + 1);
  if (!input.relativePath.startsWith(`${input.managedRoot}/`) || !rest)
    throw new Error("unsafe_obsidian_path");
  const source = await safeVaultPath(input.vaultPath, input.relativePath);
  const bytes = await readRegularFile(source);
  if (bytes === null) return { outcome: "absent" };
  if (input.expectedHash && hash(bytes.toString("utf8")) !== input.expectedHash)
    throw new Error("obsidianWiki.errors.conflict");
  const archivedPath = `${input.managedRoot}/.memora-recovery/retired-wiki/${input.stamp}/${rest}`;
  const destination = await safeVaultPath(input.vaultPath, archivedPath);
  const captured = `${destination}.captured`;
  await mkdir(dirname(destination), { recursive: true });
  await safeVaultPath(input.vaultPath, archivedPath);
  if (
    await lstat(captured).then(
      () => true,
      () => false
    )
  )
    throw new Error("obsidianWiki.errors.write");
  const copy = await open(destination, "wx", 0o600);
  try {
    await copy.writeFile(bytes);
    await copy.sync();
  } catch (error) {
    await copy.close();
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  await copy.close();
  await hooks.afterCopy?.();
  try {
    await rename(source, captured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent" };
    throw error;
  }
  const moved = await readFile(captured);
  if (!moved.equals(bytes)) {
    // The file changed between the read and the move: put the newer bytes back unless an editor recreated it.
    await link(captured, source).catch(() => undefined);
    throw new Error("obsidianWiki.errors.conflict");
  }
  await unlink(captured);
  return { outcome: "archived", archivedPath };
}
export async function runObsidianSync(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const input = payloadSchema.parse(jobTaskPayload(payload));
  if (input.action === "archive")
    return archiveObsidianFile({
      vaultPath: input.vaultPath,
      relativePath: input.relativePath,
      managedRoot: input.managedRoot,
      stamp: input.stamp,
      ...(input.expectedHash ? { expectedHash: input.expectedHash } : {})
    });
  if (Buffer.byteLength(input.content, "utf8") > 2_000_000)
    throw new Error("obsidianWiki.errors.limit");
  const targetPath = await safeVaultPath(input.vaultPath, input.relativePath);
  if (input.managedRoot && !input.relativePath.startsWith(`${input.managedRoot}/`))
    throw new Error("unsafe_obsidian_path");
  await mkdir(dirname(targetPath), { recursive: true });
  await safeVaultPath(input.vaultPath, input.relativePath);
  const original = await readOptional(targetPath),
    expected = input.expectedHash;
  if (expected !== undefined && (original === null ? null : hash(original)) !== expected)
    throw new Error("obsidianWiki.errors.conflict");
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(input.content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  let backup: string | null = null;
  try {
    if (expected !== undefined) {
      const observed = await readOptional(targetPath);
      if ((observed === null ? null : hash(observed)) !== expected)
        throw new Error("obsidianWiki.errors.conflict");
      if (original !== null) {
        const recoveryRelative = `${input.managedRoot ?? dirname(input.relativePath)}/.memora-recovery/${input.recoveryId ?? randomUUID()}.before.md`;
        backup = await safeVaultPath(input.vaultPath, recoveryRelative);
        await mkdir(dirname(backup), { recursive: true });
        // Keep both immutable copies and the actual inode removed at promotion, including late editor writes.
        await writeFile(backup, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await writeFile(backup.replace(".before.md", ".after.md"), input.content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        });
        await rename(targetPath, `${backup}.captured`);
        const captured = await readFile(`${backup}.captured`, "utf8");
        if (hash(captured) !== expected) {
          await link(`${backup}.captured`, targetPath).catch(() => undefined);
          throw new Error("obsidianWiki.errors.conflict");
        }
      }
      // Exclusive promotion never replaces a file recreated by an editor during the gap.
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
      if (hash(await readFile(targetPath, "utf8")) !== hash(input.content))
        throw new Error("obsidianWiki.errors.conflict");
    } else {
      await rename(temporaryPath, targetPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (backup) await link(`${backup}.captured`, targetPath).catch(() => undefined);
    throw error;
  }
  return {
    relativePath: input.relativePath,
    mtimeMs: Math.trunc((await stat(targetPath)).mtimeMs)
  };
}
