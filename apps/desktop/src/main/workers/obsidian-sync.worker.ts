import { jobTaskPayload } from "../job-task-payload.js";
import { mkdir, rename, stat, lstat, readFile, open, link, unlink, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { normalizeProjectionText } from "@app/integration-contracts";
import { z } from "zod";
const payloadSchema = z.object({
    action: z.literal("write"), vaultPath: z.string().min(1), relativePath: z.string().min(1),
    content: z.string().max(2000000), expectedHash: z.string().nullable().optional(),
    recoveryId: z.string().uuid().optional(), managedRoot: z.string().optional()
}).strict();
const hash = (text: string) => createHash("sha256").update(normalizeProjectionText(text)).digest("hex");
export async function safeVaultPath(vault: string, path: string): Promise<string> {
    const root = await realpath(vault), target = resolve(root, path);
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || !target.startsWith(`${root}${sep}`))
        throw new Error("unsafe_obsidian_path");
    // Include the vault itself and every existing ancestor: lexical containment alone is insufficient.
    let current = root;
    for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try {
            if ((await lstat(current)).isSymbolicLink())
                throw new Error("unsafe_obsidian_symlink");
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
    }
    return target;
}
async function readOptional(path: string) { try {
    if ((await stat(path)).size > 2000000)
        throw new Error("obsidianWiki.errors.limit");
    return await readFile(path, "utf8");
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
    throw error;
} }
export async function runObsidianSync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = payloadSchema.parse(jobTaskPayload(payload));
    if(Buffer.byteLength(input.content,'utf8')>2_000_000)throw new Error('obsidianWiki.errors.limit');
    const targetPath = await safeVaultPath(input.vaultPath, input.relativePath);
    if (input.managedRoot && !input.relativePath.startsWith(`${input.managedRoot}/`))
        throw new Error("unsafe_obsidian_path");
    await mkdir(dirname(targetPath), { recursive: true });
    await safeVaultPath(input.vaultPath, input.relativePath);
    const original = await readOptional(targetPath), expected = input.expectedHash;
    if (expected !== undefined && (original === null ? null : hash(original)) !== expected)
        throw new Error("obsidianWiki.errors.conflict");
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
        await file.writeFile(input.content, "utf8");
        await file.sync();
    }
    finally {
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
                await writeFile(backup.replace(".before.md", ".after.md"), input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
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
        }
        else {
            await rename(temporaryPath, targetPath);
        }
    }
    catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        if (backup)
            await link(`${backup}.captured`, targetPath).catch(() => undefined);
        throw error;
    }
    return { relativePath: input.relativePath, mtimeMs: Math.trunc((await stat(targetPath)).mtimeMs) };
}
