import { obsidianEditOperationSchema, obsidianEditReceiptSchema, parseObsidianMarkdown, type ObsidianEditOperation, type ObsidianEditReceipt } from '@app/integration-contracts';
import { rebaseQueuedContent } from './projection-delivery.js';
export interface QueuedOperation {
    operation: ObsidianEditOperation;
    observedContent?: string;
    receipt?: ObsidianEditReceipt;
    error?: string;
}
export interface QueueState {
    version: 1;
    operations: QueuedOperation[];
}
/** Persistence completes before transport. Failed targets remain queued while other files progress. */
export class ObsidianOperationQueue {
    private stopped=false;
    stop(){this.stopped=true;}
    private serial: Promise<unknown> = Promise.resolve();
    private flushing: Promise<void> | null = null;
    constructor(public readonly state: QueueState, private readonly persist: () => Promise<void>) {
        if (state.version !== 1)
            throw new Error('unsupported_queue');
        state.operations = state.operations.map(row => ({ operation: obsidianEditOperationSchema.parse(row.operation), observedContent: typeof row.observedContent === 'string' ? row.observedContent : row.operation.content, ...(typeof row.error === 'string' ? { error: row.error.slice(0, 200) } : {}), ...(row.receipt ? { receipt: obsidianEditReceiptSchema.parse(row.receipt) } : {}) }));
    }
    private mutate<T>(work: () => Promise<T>): Promise<T> { const next = this.serial.then(async () => { if(this.stopped)throw new Error('queue_stopped'); const before = structuredClone(this.state.operations); try {
        return await work();
    }
    catch (error) {
        this.state.operations = before;
        throw error;
    } }); this.serial = next.catch(() => undefined); return next; }
    enqueue(operation: ObsidianEditOperation): Promise<void> {
        return this.mutate(async () => {
            const last = [...this.state.operations].reverse().find(r => r.operation.targetId === operation.targetId);
            if (last && ['kind', 'relativePath', 'previousRelativePath', 'baseRevision', 'baseVersion', 'baseHash', 'content'].every(key => last.operation[key as keyof ObsidianEditOperation] === operation[key as keyof ObsidianEditOperation]))
                return;
            if (this.state.operations.reduce((total, row) => total + row.operation.content.length + (row.receipt?.content.length ?? 0), operation.content.length) > 20000000 || this.state.operations.length >= 1000)
                throw new Error('queue_full');
            this.state.operations.push({ operation: obsidianEditOperationSchema.parse(operation), observedContent: operation.content });
            try {
                await this.persist();
            }
            catch (error) {
                this.state.operations.pop();
                throw error;
            }
        });
    }
    flush(send: (operation: ObsidianEditOperation) => Promise<ObsidianEditReceipt>, apply: (operation: ObsidianEditOperation, receipt: ObsidianEditReceipt, observedContent: string) => Promise<boolean>, acknowledge: (id: string) => Promise<void>, baseContent?: (operation: ObsidianEditOperation) => string | undefined): Promise<void> {
        if (this.flushing)
            return this.flushing;
        this.flushing = this.run(send, apply, acknowledge, baseContent).finally(() => { this.flushing = null; });
        return this.flushing;
    }
    private async run(send: (operation: ObsidianEditOperation) => Promise<ObsidianEditReceipt>, apply: (operation: ObsidianEditOperation, receipt: ObsidianEditReceipt, observedContent: string) => Promise<boolean>, acknowledge: (id: string) => Promise<void>, baseContent?: (operation: ObsidianEditOperation) => string | undefined) {
        const blocked = new Set<string>();
        while (true) {
            if(this.stopped)return;
            const row = this.state.operations.find(r => !blocked.has(r.operation.targetId));
            if (!row) return;
            try {
                const base = baseContent?.(row.operation);
                if (!row.receipt && row.operation.kind === 'move' && row.operation.previousRelativePath && base !== undefined && parseObsidianMarkdown(base)?.bodyMarkdown !== parseObsidianMarkdown(row.operation.content)?.bodyMarkdown) {
                    // Older offline queues may have captured a dirty move without its
                    // preceding save. Persist that save before sending either request.
                    await this.mutate(async () => {
                        const index = this.state.operations.findIndex(r => r.operation.operationId === row.operation.operationId);
                        if (index < 0) throw new Error('missing_operation');
                        if (this.state.operations.length >= 1000 || this.state.operations.reduce((n, item) => n + item.operation.content.length + (item.receipt?.content.length ?? 0), row.operation.content.length) > 20000000) throw new Error('queue_full');
                        const { previousRelativePath, ...operation } = row.operation;
                        this.state.operations.splice(index, 0, { operation: obsidianEditOperationSchema.parse({ ...operation, operationId: crypto.randomUUID(), kind: 'edit', relativePath: previousRelativePath }), observedContent: row.observedContent ?? row.operation.content });
                        await this.persist();
                    });
                    continue;
                }
                const receipt = row.receipt ?? obsidianEditReceiptSchema.parse(await send(row.operation));
                if(this.stopped)return;
                if (receipt.operationId !== row.operation.operationId || receipt.targetId !== row.operation.targetId)
                    throw new Error('invalid_receipt');
                await this.mutate(async () => { const current = this.state.operations.find(r => r.operation.operationId === row.operation.operationId); if (!current)
                    throw new Error('missing_operation'); current.receipt = receipt; delete current.error; await this.persist(); });
                if (receipt.status === 'conflict') {
                    blocked.add(row.operation.targetId);
                    continue;
                }
                if(this.stopped)return;
                const written = receipt.status === 'ignored' || await apply(row.operation, receipt, row.observedContent ?? row.operation.content);
                if (!written) {
                    blocked.add(row.operation.targetId);
                    continue;
                }
                if (receipt.status === 'synced')
                    await acknowledge(row.operation.operationId);
                await this.mutate(async () => {
                    const frame = parseObsidianMarkdown(receipt.content);
                    for (const next of receipt.status === 'synced' ? this.state.operations : []) {
                        if (next.operation.operationId === row.operation.operationId || next.receipt || next.operation.targetId !== row.operation.targetId)
                            continue;
                        const local = parseObsidianMarkdown(next.operation.content);
                        if (frame && local) {
                            next.operation = { ...next.operation, targetType: frame.frontmatter.memoraType, baseRevision: receipt.revision, baseVersion: receipt.syncVersion, baseHash: receipt.contentHash, content: rebaseQueuedContent(row.operation, receipt, next.operation.content) };
                        }
                    }
                    const index = this.state.operations.findIndex(r => r.operation.operationId === row.operation.operationId);
                    if (index < 0)
                        throw new Error('missing_operation');
                    this.state.operations.splice(index, 1);
                    await this.persist();
                });
            }
            catch (error) {
                if(this.stopped)return;
                blocked.add(row.operation.targetId);
                await this.mutate(async () => { const current = this.state.operations.find(r => r.operation.operationId === row.operation.operationId); if (current)
                    current.error = error instanceof Error ? error.message : 'delivery_failed'; await this.persist(); });
            }
        }
    }
    /** Only edit snapshots through the exact confirmed bytes are superseded. Moves,
     * deletions and edits after that boundary still represent independent intent. */
    private replaceResolution(originalId: string, replacement: QueuedOperation, observedLocal?: string | null, supersededOperationIds: string[] = []) {
        const sameTarget = (row: QueuedOperation) => row.operation.targetId === replacement.operation.targetId && row.operation.binding === replacement.operation.binding && row.operation.vaultId === replacement.operation.vaultId;
        const superseded = new Set(supersededOperationIds);
        const retiredAttempt = (row: QueuedOperation) => sameTarget(row) && superseded.has(row.operation.operationId) && row.operation.resolution?.operationId === originalId;
        const original = this.state.operations.findIndex(row => sameTarget(row) && (row.operation.operationId === originalId || retiredAttempt(row)));
        if (original < 0) return false;
        let covered = original;
        if (typeof observedLocal === 'string') {
            for (let index = original; index < this.state.operations.length; index++) {
                const row = this.state.operations[index]!;
                if (row.operation.targetId === replacement.operation.targetId && row.operation.relativePath === replacement.operation.relativePath && row.operation.kind === 'edit' && (row.observedContent ?? row.operation.content) === observedLocal) covered = index;
            }
        }
        this.state.operations = this.state.operations.flatMap((row, index) => {
            if (index === original) return [replacement];
            if (retiredAttempt(row)) return [];
            if (index > original && index <= covered && sameTarget(row) && !row.receipt && !row.operation.resolution && row.operation.kind === 'edit' && row.operation.relativePath === replacement.operation.relativePath) return [];
            return [row];
        });
        return true;
    }
    async acceptResolution(originalId: string, operation: ObsidianEditOperation, receipt: ObsidianEditReceipt, supersededOperationIds: string[] = []) {
        await this.mutate(async () => {
            const parsed = obsidianEditOperationSchema.parse(operation), result = obsidianEditReceiptSchema.parse(receipt);
            if (parsed.resolution?.operationId !== originalId || result.operationId !== parsed.operationId || result.targetId !== parsed.targetId) throw new Error('invalid_receipt');
            if (this.replaceResolution(originalId, { operation: parsed, receipt: result, observedContent: parsed.resolution.observedLocal ?? parsed.content }, parsed.resolution.observedLocal, supersededOperationIds)) await this.persist();
        });
    }
    async detach(id: string, operation: ObsidianEditOperation) { await this.mutate(async () => { const index = this.state.operations.findIndex(r => r.operation.operationId === id); if (index < 0)
        throw new Error('missing_conflict'); this.state.operations[index] = { operation: obsidianEditOperationSchema.parse(operation), observedContent: operation.content }; await this.persist(); }); }
    async refreshComparison(id: string, receipt: ObsidianEditReceipt) { await this.mutate(async () => { const row = this.state.operations.find(r => r.operation.operationId === id); if (!row || receipt.operationId !== id || receipt.targetId !== row.operation.targetId)
        throw new Error('invalid_receipt'); row.receipt = obsidianEditReceiptSchema.parse(receipt); delete row.error; await this.persist(); }); }
    async resolve(operationId: string, operation: ObsidianEditOperation, observedContent = operation.content) {
        await this.mutate(async () => {
            const previous = this.state.operations.find(row => row.operation.operationId === operationId);
            if (!previous) throw new Error('missing_conflict');
            const parsed = obsidianEditOperationSchema.parse(operation);
            if (parsed.resolution) parsed.resolution.operationId = previous.operation.resolution?.operationId ?? previous.operation.operationId;
            if (!this.replaceResolution(operationId, { operation: parsed, observedContent }, observedContent)) throw new Error('missing_conflict');
            await this.persist();
        });
    }
}
