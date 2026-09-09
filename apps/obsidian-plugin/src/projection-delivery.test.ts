import { describe, expect, it } from 'vitest';
import { parseObsidianMarkdown, serializeManagedFrontmatter, type ObsidianEditOperation, type ObsidianEditReceipt } from '@app/integration-contracts';
import { ObsidianOperationQueue, type QueueState } from './operation-queue.js';
import { applyQueuedReceipt, assertConfirmedLocal, isKnownProjection, queuedPlacement, rebaseQueuedContent } from './projection-delivery.js';

const targetId = crypto.randomUUID(), vaultId = crypto.randomUUID();
const text = (body: string, version = 1) => serializeManagedFrontmatter({ memoraId: targetId, memoraType: 'source_item', memoraManaged: true, memoraSyncVersion: version, memoraContentHash: 'a'.repeat(64) }) + '\n' + body;
const edit = (body = 'Initial', path = 'Memora/a.md'): ObsidianEditOperation => ({ version: 1, operationId: crypto.randomUUID(), vaultId, binding: 'a'.repeat(64), targetId, targetType: 'source_item', kind: 'edit', relativePath: path, baseRevision: 'r1', baseVersion: 1, baseHash: 'a'.repeat(64), content: text(body), occurredAt: new Date().toISOString() });
const result = (op: ObsidianEditOperation, content = text(parseObsidianMarkdown(op.content)!.bodyMarkdown, op.baseVersion + 1)): ObsidianEditReceipt => ({ operationId: op.operationId, targetId, status: 'synced', revision: 'r' + (op.baseVersion + 1), syncVersion: op.baseVersion + 1, contentHash: 'a'.repeat(64), projection: 'pending', reason: null, comparison: null, content });
const host = (files: Map<string, string>) => ({
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, expected: string, content: string) => { if (files.get(path) !== expected) return false; files.set(path, content); return true; }
});

describe('Obsidian receipt placement and confirmation', () => {
    it.each([{ deleted: false, dirtyMove: false }, { deleted: true, dirtyMove: false }, { deleted: false, dirtyMove: true }, { deleted: true, dirtyMove: true }])('replays edit → move → move after restart: %j', async ({ deleted, dirtyMove }) => {
        const finalBody = dirtyMove ? 'Second human edit' : 'Human edit';
        const a = edit('Human edit'), b = { ...edit(finalBody, 'Memora/b.md'), kind: 'move' as const, previousRelativePath: a.relativePath }, c = { ...edit(finalBody, 'Memora/c.md'), kind: 'move' as const, previousRelativePath: b.relativePath };
        let disk: QueueState = { version: 1, operations: [] };
        const initial = new ObsidianOperationQueue(disk, async () => {});
        for (const op of [a, b, c]) await initial.enqueue(op);
        if (deleted) await initial.enqueue({ ...edit(finalBody, c.relativePath), kind: 'delete' });
        disk = structuredClone(initial.state);
        const queue = new ObsidianOperationQueue(disk, async () => {}), files = new Map(deleted ? [] : [[c.relativePath, c.content]]), io = host(files);
        let registeredPath = a.relativePath, version = 1, canonical = 'Initial', tombstone = '', base = text('Initial');
        const sent: string[] = [], acknowledged: string[] = [];
        await queue.flush(async op => {
            sent.push(op.kind);
            expect(op.baseVersion).toBe(version);
            expect(op.kind === 'move' ? op.previousRelativePath : op.relativePath).toBe(registeredPath);
            if (op.kind === 'edit') canonical = parseObsidianMarkdown(op.content)!.bodyMarkdown;
            if (op.kind === 'move') {
                expect(files.has(registeredPath)).toBe(false);
                expect(parseObsidianMarkdown(op.content)!.bodyMarkdown).toBe(canonical);
                registeredPath = op.relativePath;
            }
            const receipt = result(op);
            if (op.kind === 'delete') { tombstone = op.content; return { ...receipt, content: op.content, status: 'deleted', projection: 'tombstoned' }; }
            version++;
            return receipt;
        }, (op, receipt, observed) => { base = receipt.content; return applyQueuedReceipt(queue.state.operations, op, receipt, observed, io); }, async id => { acknowledged.push(id); }, () => base);
        expect(sent).toEqual(['edit', ...(dirtyMove ? ['edit'] : []), 'move', 'move', ...(deleted ? ['delete'] : [])]);
        expect(queue.state.operations).toHaveLength(0);
        expect(registeredPath).toBe(c.relativePath);
        expect(acknowledged).toHaveLength(dirtyMove ? 4 : 3);
        expect(files.has(a.relativePath)).toBe(false);
        expect(files.has(b.relativePath)).toBe(false);
        expect(deleted ? tombstone : files.get(c.relativePath)).toContain(finalBody);
        if (!deleted) expect(parseObsidianMarkdown(files.get(c.relativePath)!)!.frontmatter.memoraSyncVersion).toBe(dirtyMove ? 5 : 4);
    });

    it('does not use an unrelated move or a missing scan as deletion evidence', async () => {
        const a = edit(), wrong = { ...edit('Initial', 'Memora/c.md'), kind: 'move' as const, previousRelativePath: 'Memora/wrong.md' };
        const rows = [{ operation: a }, { operation: wrong }];
        expect(queuedPlacement(rows, a).relativePath).toBe(a.relativePath);
        expect(await applyQueuedReceipt(rows, a, result(a), a.content, host(new Map()))).toBe(false);
        const proper = { ...wrong, previousRelativePath: a.relativePath };
        expect(await applyQueuedReceipt([{ operation: a }, { operation: proper }], a, result(a), a.content, host(new Map([[proper.relativePath, text('Unknown newer edit')]])))).toBe(false);
    });

    it('rejects a removed or changed file before replacing a conflict, preserving queued deletion', async () => {
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {}), a = edit(), deletion = { ...edit(), kind: 'delete' as const };
        await queue.enqueue(a); await queue.enqueue(deletion);
        expect(() => assertConfirmedLocal(null, a.content)).toThrow('newer_local_buffer');
        expect(() => assertConfirmedLocal(text('New draft'), a.content)).toThrow('newer_local_buffer');
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([a.operationId, deletion.operationId]);
        await queue.resolve(a.operationId, { ...a, operationId: crypto.randomUUID() }, a.content);
        expect(queue.state.operations.at(-1)!.operation.operationId).toBe(deletion.operationId);
    });

    it('captures a byte-identical duplicate at another path, while suppressing its real projection echo', () => {
        const a = edit(), registered = { relativePath: a.relativePath, content: a.content };
        expect(isKnownProjection('Memora/a 1.md', a.content, registered)).toBe(false);
        expect(isKnownProjection(a.relativePath, a.content, registered)).toBe(true);
    });
});

describe('desktop resolution replay boundary', () => {
    it.each([false, true])('supersedes only the confirmed snapshots; newer edit=%s', async newer => {
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {}), a = edit('Conflict A'), b = edit('Compared B'), d = edit('Later D');
        await queue.enqueue(a); await queue.enqueue(b);
        if (newer) await queue.enqueue(d);
        const resolution = { ...a, operationId: crypto.randomUUID(), content: text('Manual C'), resolution: { operationId: a.operationId, choice: 'manual' as const, currentRevision: 'r1', observedLocal: b.content } }, receipt = result(resolution);
        await queue.acceptResolution(a.operationId, resolution, receipt);
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual(newer ? [resolution.operationId, d.operationId] : [resolution.operationId]);
        const files = new Map([[a.relativePath, newer ? d.content : receipt.content]]), io = host(files), sent: string[] = [];
        await queue.flush(async op => { sent.push(parseObsidianMarkdown(op.content)!.bodyMarkdown); return result(op); }, (op, value, observed) => applyQueuedReceipt(queue.state.operations, op, value, observed, io), async () => {});
        expect(sent).toEqual(newer ? ['Later D'] : []);
        expect(parseObsidianMarkdown(files.get(a.relativePath)!)!.bodyMarkdown).toBe(newer ? 'Later D' : 'Manual C');
        expect(queue.state.operations).toHaveLength(0);
    });

    it('keeps explicit moves/deletions and rolls back covered-snapshot removal on disk failure', async () => {
        let fail = false;
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => { if (fail) throw new Error('ENOSPC'); }), a = edit('A'), b = edit('B'), move = { ...edit('B', 'Memora/b.md'), kind: 'move' as const, previousRelativePath: a.relativePath }, deletion = { ...edit('B', move.relativePath), kind: 'delete' as const };
        for (const op of [a, b, move, deletion]) await queue.enqueue(op);
        const replacement = { ...a, operationId: crypto.randomUUID(), resolution: { operationId: a.operationId, choice: 'local' as const, currentRevision: 'r1', observedLocal: b.content } };
        fail = true;
        await expect(queue.acceptResolution(a.operationId, replacement, result(replacement))).rejects.toThrow('ENOSPC');
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([a, b, move, deletion].map(op => op.operationId));
        fail = false;
        await queue.acceptResolution(a.operationId, replacement, result(replacement));
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([replacement, move, deletion].map(op => op.operationId));
    });

    it('clears a superseded transport error after a valid conflict receipt or comparison', async () => {
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {}), a = edit();
        await queue.enqueue(a);
        await queue.flush(async () => { throw new Error('paused'); }, async () => true, async () => {});
        expect(queue.state.operations[0]!.error).toBe('paused');
        const conflict: ObsidianEditReceipt = { ...result(a), status: 'conflict', comparison: { base: 'Base', local: a.content, app: 'App' } };
        await queue.flush(async () => conflict, async () => true, async () => {});
        expect(queue.state.operations[0]!.error).toBeUndefined();
        queue.state.operations[0]!.error = 'paused';
        await queue.refreshComparison(a.operationId, conflict);
        expect(queue.state.operations[0]!.error).toBeUndefined();
    });
});


describe('generated region rebase', () => {
    it('ports only generated bytes proven unchanged, leaving human divergence for conflict', () => {
        const original = edit();
        const wikiBody = '# Wiki\n\n<!-- memora:generated:start -->\nOld generated\n<!-- memora:generated:end -->\n';
        const a = { ...original, targetType: 'wiki_page' as const, content: original.content.replace('Initial', wikiBody) };
        const updated = result(a, a.content.replace('Old generated', 'New generated').replace('memora_sync_version: 1', 'memora_sync_version: 2'));
        const newerProse = a.content.replace('# Wiki', '# Human title');
        const rebased = rebaseQueuedContent(a, updated, newerProse);
        expect(rebased).toContain('# Human title');
        expect(rebased).toContain('New generated');
        const divergent = newerProse.replace('Old generated', 'Human changed generated');
        expect(rebaseQueuedContent(a, updated, divergent)).toContain('Human changed generated');
        expect(rebaseQueuedContent({ ...a, resolution: { operationId: crypto.randomUUID(), choice: 'app', currentRevision: 'r1' } }, updated, newerProse)).toContain('Old generated');
    });
});

describe('resolution attempt families', () => {
    const conflict = (op: ObsidianEditOperation): ObsidianEditReceipt => ({ ...result(op), status: 'conflict', syncVersion: op.baseVersion, projection: 'conflict', comparison: { base: text('Base'), local: op.content, app: text('App') } });
    const attempt = (original: ObsidianEditOperation, body: string): ObsidianEditOperation => ({ ...original, operationId: crypto.randomUUID(), content: text(body), resolution: { operationId: original.operationId, choice: 'manual', currentRevision: 'r1', observedLocal: original.content } });

    it('retires a failed plugin attempt from the desktop manifest after restart, preserving a later edit', async () => {
        const original = edit('Observed A'), failed = attempt(original, 'Invalid manual draft'), later = edit('Later edit D');
        const initial = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {});
        await initial.enqueue(original);
        await initial.flush(async op => conflict(op), async () => false, async () => {});
        await initial.resolve(original.operationId, failed, original.content);
        await initial.flush(async op => conflict(op), async () => false, async () => {});
        const queue = new ObsidianOperationQueue(structuredClone(initial.state), async () => {});
        await queue.enqueue(later);
        const desktop = attempt(original, 'Valid desktop C'), receipt = result(desktop);
        await queue.acceptResolution(original.operationId, desktop, receipt, [original.operationId, failed.operationId]);
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([desktop.operationId, later.operationId]);
        const files = new Map([[original.relativePath, later.content]]), sent: string[] = [];
        await queue.flush(async op => { sent.push(op.operationId); return result(op); }, (op, value, observed) => applyQueuedReceipt(queue.state.operations, op, value, observed, host(files)), async () => {});
        expect(sent).toEqual([later.operationId]);
        expect(queue.state.operations).toHaveLength(0);
        expect(parseObsidianMarkdown(files.get(original.relativePath)!)!.bodyMarkdown).toBe('Later edit D');
    });

    it('normalizes a valid plugin retry to the original instead of nesting under the failed attempt', async () => {
        const original = edit('Observed A'), failed = attempt(original, 'Invalid draft');
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {});
        await queue.enqueue(original);
        await queue.resolve(original.operationId, failed, original.content);
        await queue.flush(async op => conflict(op), async () => false, async () => {});
        const retry = attempt(failed, 'Valid retry');
        await queue.resolve(failed.operationId, retry, original.content);
        expect(queue.state.operations[0]!.operation.resolution!.operationId).toBe(original.operationId);
        const files = new Map([[original.relativePath, original.content]]);
        await queue.flush(async op => { expect(op.resolution!.operationId).toBe(original.operationId); return result(op); }, (op, value, observed) => applyQueuedReceipt(queue.state.operations, op, value, observed, host(files)), async () => {});
        expect(queue.state.operations).toHaveLength(0);
        expect(files.get(original.relativePath)).toContain('Valid retry');
    });

    it('does not retire a newer attempt or an independent conflict absent from the authoritative IDs', async () => {
        const original = edit('Same observed bytes'), newer = attempt(original, 'Later manual draft'), independent = edit('Same observed bytes');
        const queue = new ObsidianOperationQueue({ version: 1, operations: [] }, async () => {});
        await queue.enqueue(newer);
        await queue.enqueue(independent);
        await queue.refreshComparison(newer.operationId, conflict(newer));
        await queue.refreshComparison(independent.operationId, conflict(independent));
        const desktop = attempt(original, 'Earlier successful draft');
        await queue.acceptResolution(original.operationId, desktop, result(desktop), [original.operationId]);
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([newer.operationId, independent.operationId]);
        await queue.acceptResolution(original.operationId, desktop, result(desktop), [original.operationId, newer.operationId]);
        expect(queue.state.operations.map(row => row.operation.operationId)).toEqual([desktop.operationId, independent.operationId]);
    });
});
