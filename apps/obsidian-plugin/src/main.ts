import { MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App } from 'obsidian';
import { createTranslator, type LanguageCode, type MessageKey, type Translator } from '@app/i18n';
import { normalizeProjectionText, parseObsidianMarkdown, parseWikiRegions, sectionStart, sectionEnd, serializeManagedFrontmatter, type ObsidianEditOperation, type ObsidianEditReceipt } from '@app/integration-contracts';
import { ObsidianGatewayClient } from './integration-client.js';
import { ObsidianOperationQueue, type QueueState, type QueuedOperation } from './operation-queue.js';
import { applyQueuedReceipt, assertConfirmedLocal, isKnownProjection, queuedPlacement } from './projection-delivery.js';
interface Settings {
    gatewayBaseUrl: string;
    clientId: string;
    pairingToken: string;
    locale: LanguageCode;
}
interface RegisteredFile {
    deleted?:boolean;
    targetId: string;
    targetType: ObsidianEditOperation['targetType'];
    relativePath: string;
    revision: string;
    syncVersion: number;
    contentHash: string;
    content: string;
}
interface SavedState {
    settings: Settings;
    vaultId: string;
    binding: string;
    managedRoot: string;
    files: RegisteredFile[];
    queue: QueueState;
}
const defaults: Settings = { gatewayBaseUrl: 'http://127.0.0.1:47831', clientId: '', pairingToken: '', locale: 'en' };
export default class MemoraObsidianPlugin extends Plugin {
    public override settings: Settings = defaults;
    private unloaded=false;
    public connected = false;
    public state!: SavedState;
    public queue!: ObsidianOperationQueue;
    public t: Translator = createTranslator('en');
    private client!: ObsidianGatewayClient;
    private status!: HTMLElement;
    private failure: MessageKey | null = null;
    private saves: Promise<void> = Promise.resolve();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private writes = new Set<string>();
    private drafts = new Map<string, Promise<string>>();
    private refreshing: Promise<void> | null = null;
    public override async onload() {
        const saved = await this.loadData() as Partial<SavedState> & Partial<Settings> | null;
        this.settings = { ...defaults, ...(saved?.settings ?? saved ?? {}) };
        this.state = { settings: this.settings, vaultId: saved?.vaultId ?? crypto.randomUUID(), binding: saved?.binding ?? '', managedRoot: saved?.managedRoot ?? '', files: saved?.files ?? [], queue: saved?.queue ?? { version: 1, operations: [] } };
        this.t = createTranslator(this.settings.locale);
        this.queue = new ObsidianOperationQueue(this.state.queue, () => this.persist());
        this.client = new ObsidianGatewayClient(() => this.settings, connected => { this.connected = connected; this.renderStatus(); if (connected)
            void this.synchronize().catch(error => this.noticeError(error)); });
        this.status = this.addStatusBarItem();
        this.status.onclick = () => new SyncReviewModal(this.app, this).open();
        this.renderStatus();
        this.addSettingTab(new MemoraSettingTab(this.app, this));
        this.addCommand({ id: 'memora-import-current-note', name: this.t('integrations.commands.importCurrentNote'), callback: () => void this.importCurrent() });
        this.addCommand({ id: 'memora-reconnect', name: this.t('integrations.commands.reconnect'), callback: () => void this.reconnect() });
        this.addCommand({ id: 'memora-reconcile', name: this.t('integrations.commands.reconcile'), callback: () => void this.synchronize().catch(error => this.noticeError(error)) });
        this.addCommand({ id: 'memora-add-human-section', name: this.t('obsidianEditing.addSection'), callback: () => void this.addHumanSection().catch(error => this.noticeError(error)) });
        this.addCommand({ id: 'memora-sync-review', name: this.t('obsidianEditing.review'), callback: () => new SyncReviewModal(this.app, this).open() });
        this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile)
            this.changed(file); }));
        this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile)
            this.changed(file); }));
        this.registerEvent(this.app.vault.on('rename', (file, previous) => { if (file instanceof TFile || file instanceof TFolder)
            void this.moved(file.path, previous).catch(error => this.noticeError(error)); }));
        this.registerEvent(this.app.vault.on('delete', file => { if (file instanceof TFile || file instanceof TFolder)
            void this.deleted(file.path).catch(error => this.noticeError(error)); }));
        this.registerInterval(window.setInterval(() => { if (this.connected)
            void this.synchronize().catch(error => this.noticeError(error)); }, 15000));
        this.app.workspace.onLayoutReady(() => { void this.reconnect(); });
        await this.persist();
    }
    public override onunload() {
        this.unloaded=true;
        this.queue.stop(); for (const timer of this.timers.values())
        clearTimeout(timer); this.client.disconnect(); }
    public persist() { const write = async () => { if(this.unloaded)throw new Error('plugin_stopped'); await this.saveData(this.state); this.renderStatus(); }; this.saves = this.saves.then(write, write); return this.saves; }
    public async saveSettings() { this.state.settings = this.settings; await this.persist(); this.t = createTranslator(this.settings.locale); }
    private noticeError(error?: unknown) {
        if(this.unloaded)return; const message = String(error); const key: MessageKey = message.includes('limit') ? 'obsidianWiki.errors.limit' : message.includes('paused') ? 'obsidianEditing.paused' : /unauthorized|forbidden/.test(message) ? 'obsidianEditing.rePair' : /unsupported|incompatible/.test(message) ? 'obsidianEditing.unsupported' : /ENOSPC|queue_full|disk/i.test(message) ? 'obsidianEditing.diskError' : 'obsidianEditing.deliveryError'; if (this.failure !== key)
        new Notice(this.t(key)); this.failure = key; this.renderStatus(); }
    public async reconnect() { try {
        this.client.disconnect();
        await this.client.connect();
        await this.synchronize();
    }
    catch (error) {
        this.noticeError(error);
    } }
    public syncMessage():MessageKey{return this.failure??(this.connected?'obsidianEditing.synced':'obsidianEditing.offline');}
    private renderStatus() { if (!this.status)
        return; const conflicts = this.queue?.state.operations.filter(r => r.receipt?.status === 'conflict').length ?? 0; this.status.setText(this.t(this.failure ?? (conflicts ? 'obsidianEditing.conflict' : this.queue?.state.operations.length ? 'obsidianEditing.pending' : this.connected ? 'obsidianEditing.synced' : 'obsidianEditing.offline'))); }
    private changed(file: TFile) { if (!file.path.startsWith(this.state.managedRoot+'/') || !file.path.endsWith('.md') || this.writes.has(file.path))
        return; this.drafts.set(file.path, this.app.vault.read(file).then(normalizeProjectionText)); const previous = this.timers.get(file.path); if (previous)
        clearTimeout(previous); this.timers.set(file.path, setTimeout(() => { this.timers.delete(file.path); void this.capture(file).then(() => this.flush()).catch(error => this.noticeError(error)); }, 650)); }
    private async capture(file: TFile) {
        if(!file.path.startsWith(this.state.managedRoot+'/'))return;
        if(file.stat.size>2_000_000)throw new Error('obsidianWiki.errors.limit');
        const content = normalizeProjectionText(await this.app.vault.read(file)), frame = parseObsidianMarkdown(content);
        let registered = this.state.files.find(f => f.relativePath === file.path) || this.state.files.find(f => f.targetId === frame?.frontmatter.memoraId);
        if (!registered || !file.path.startsWith(this.state.managedRoot + '/'))
            return;
        if (frame && frame.frontmatter.memoraSyncVersion > registered.syncVersion && this.connected && !this.queue.state.operations.some(r => r.operation.targetId === registered!.targetId)) {
            let cursor: number | null = 0;
            while (cursor !== null) {
                const manifest = await this.client.manifest(this.state.vaultId, cursor, []), current = manifest.files.find(f => f.targetId === registered!.targetId);
                if (current) {
                    Object.assign(registered, current);
                    await this.persist();
                    break;
                }
                cursor = manifest.cursor;
            }
        }
        const latest = [...this.queue.state.operations].reverse().find(r => r.operation.targetId === registered.targetId);
        if (isKnownProjection(file.path, content, registered, latest))
            return;
        await this.enqueue(registered, 'edit', file.path, content);
    }
    private operation(file: RegisteredFile, kind: ObsidianEditOperation['kind'], relativePath: string, content: string): ObsidianEditOperation { return { version: 1, operationId: crypto.randomUUID(), vaultId: this.state.vaultId, binding: this.state.binding, targetId: file.targetId, targetType: file.targetType, kind, relativePath, baseRevision: file.revision, baseVersion: file.syncVersion, baseHash: file.contentHash, content, occurredAt: new Date().toISOString() }; }
    private async enqueue(file: RegisteredFile, kind: ObsidianEditOperation['kind'], path: string, content: string, previous?: string) { await this.queue.enqueue({ ...this.operation(file, kind, path, content), ...(previous ? { previousRelativePath: previous } : {}) }); }
    private async moved(path: string, previous: string) {
        const files = this.state.files.filter(f => f.relativePath === previous || f.relativePath.startsWith(previous + '/'));
        for (const registered of files) {
            const before = registered.relativePath, next = path + before.slice(previous.length), file = this.app.vault.getAbstractFileByPath(next);
            if (!(file instanceof TFile))
                continue;
            const timer = this.timers.get(before);
            if (timer) clearTimeout(timer);
            this.timers.delete(before);
            const content = normalizeProjectionText(await this.app.vault.read(file));
            const latest = [...this.queue.state.operations].reverse().find(row => row.operation.targetId === registered.targetId);
            if (!isKnownProjection(before, content, registered, latest)) await this.enqueue(registered, 'edit', before, content);
            await this.enqueue(registered, 'move', next, content, before);
            this.drafts.delete(before);
            this.drafts.set(next, Promise.resolve(content));
            registered.relativePath = next;
            await this.persist();
        }
        await this.flush();
    }
    private async deleted(path: string) { for (const file of this.state.files.filter(f => f.relativePath === path || f.relativePath.startsWith(path + '/'))) {
        const timer = this.timers.get(file.relativePath);
        if (timer)
            clearTimeout(timer);
        const draft = await this.drafts.get(file.relativePath);
        if (draft && draft !== file.content)
            await this.enqueue(file, 'edit', file.relativePath, draft);
        const pending = [...this.queue.state.operations].reverse().find(r => r.operation.targetId === file.targetId);
        await this.enqueue(file, 'delete', file.relativePath, pending?.operation.content ?? file.content);
    } await this.flush(); }
    public synchronize(): Promise<void> { if (this.refreshing)
        return this.refreshing; this.refreshing = this.refresh().finally(() => { this.refreshing = null; }); return this.refreshing; }
    private async refresh() {
        // Retained operations and original IDs are delivered before scanning present files.
        // Keep this filter stable for every page even as receipts replace rows.
        const pendingOperationIds = this.queue.state.operations.map(row => row.operation.operationId);
        let cursor: number | null = 0;
        while (cursor !== null) {
            const manifest = await this.client.manifest(this.state.vaultId, cursor, pendingOperationIds);
            this.state.binding = manifest.binding.binding;
            this.state.managedRoot = manifest.binding.managedRoot;
            for (const resolution of manifest.resolutions)
                await this.queue.acceptResolution(resolution.originalOperationId, resolution.operation, resolution.receipt, resolution.supersededOperationIds);
            for (const file of manifest.files) {
                if (this.queue.state.operations.some(r => r.operation.targetId === file.targetId))
                    continue;
                const index = this.state.files.findIndex(f => f.targetId === file.targetId);
                if (index < 0)
                    this.state.files.push(file);
                else
                    this.state.files[index] = file;
            }
            cursor = manifest.cursor;
        }
        await this.persist();
        await this.flush();
        for (const file of this.app.vault.getMarkdownFiles())
            await this.capture(file);
        await this.flush();
        this.failure = null;
        this.renderStatus();
    }
    public async flush() {
        if (!this.state.binding || !this.connected)
            return;
        await this.queue.flush(op => this.client.operation(op), async (op, receipt, observed) => {
            const registered = this.state.files.find(f => f.targetId === op.targetId);
            if (registered) {
                Object.assign(registered, { deleted:receipt.status==='deleted', targetType: parseObsidianMarkdown(receipt.content)?.frontmatter.memoraType ?? registered.targetType, revision: receipt.revision, syncVersion: receipt.syncVersion, contentHash: receipt.contentHash, content: receipt.content, relativePath: queuedPlacement(this.queue.state.operations, op).relativePath });
                await this.persist();
            }
            return applyQueuedReceipt(this.queue.state.operations, op, receipt, observed, {
                read: async path => { const file = this.app.vault.getAbstractFileByPath(path); return file instanceof TFile ? this.app.vault.read(file) : null; },
                write: async (path, actual, content) => {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return false;
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view?.file?.path === file.path && normalizeProjectionText(view.editor.getValue()) !== actual)
                return false;
            this.writes.add(file.path);
            try {
                await this.app.vault.process(file, current => { if(this.unloaded)throw new Error('plugin_stopped'); if (normalizeProjectionText(current) !== actual || (view?.file?.path === file.path && normalizeProjectionText(view.editor.getValue()) !== actual))
                    throw new Error('newer_local_buffer'); return content; });
                this.drafts.delete(file.path);
                return true;
            }
            finally {
                this.writes.delete(file.path);
            }
                }
            });
        }, async (id) => { await this.client.acknowledge(id, this.state.vaultId); }, op => this.state.files.find(file => file.targetId === op.targetId)?.content);
        this.renderStatus();
    }
    public async resolve(row: QueuedOperation, choice: 'local' | 'app' | 'manual', text: string) {
        const receipt = row.receipt;
        if (!receipt?.comparison)
            return;
        const file = this.app.vault.getAbstractFileByPath(row.operation.relativePath);
        assertConfirmedLocal(file instanceof TFile ? await this.app.vault.read(file) : null, receipt.comparison.local);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file?.path === row.operation.relativePath) assertConfirmedLocal(view.editor.getValue(), receipt.comparison.local);
        const operation = { ...row.operation, kind: 'edit' as const, operationId: crypto.randomUUID(), occurredAt: new Date().toISOString(), content: choice === 'manual' ? text : receipt.comparison.local, resolution: { operationId: row.operation.resolution?.operationId ?? row.operation.operationId, currentRevision: receipt.revision, choice, observedLocal: receipt.comparison.local } };
        await this.queue.resolve(row.operation.operationId, operation, receipt.comparison.local);
        await this.flush();
    }
    public async detachCopy(row: QueuedOperation) { const file = this.app.vault.getAbstractFileByPath(row.operation.relativePath), comparison = row.receipt?.comparison; if (!(file instanceof TFile) || !comparison)
        return; const current = normalizeProjectionText(await this.app.vault.read(file)); if (current !== comparison.local)
        throw new Error('newer_local_buffer'); const frame = parseObsidianMarkdown(current); if (!frame)
        throw new Error('invalid_anchors'); await this.queue.detach(row.operation.operationId, { ...row.operation, operationId: crypto.randomUUID(), kind: 'detach', resolution: { operationId: row.operation.operationId, currentRevision: row.receipt!.revision, choice: 'app' } }); await this.app.vault.process(file, actual => { if (normalizeProjectionText(actual) !== current)
        throw new Error('newer_local_buffer'); return (frame.userFrontmatter ? '---\n' + frame.userFrontmatter + '\n---\n' : '') + frame.bodyMarkdown; }); await this.flush(); }
    public async refreshComparison(row: QueuedOperation) { const file = this.app.vault.getAbstractFileByPath(row.operation.relativePath); const content = file instanceof TFile ? normalizeProjectionText(await this.app.vault.read(file)) : row.operation.content; await this.queue.refreshComparison(row.operation.operationId, await this.client.compare(row.operation.operationId, content)); }
    private async addHumanSection() { const file = this.app.workspace.getActiveFile(); if (!file)
        return; const raw = await this.app.vault.read(file), frame = parseObsidianMarkdown(raw); if (frame?.frontmatter.memoraType !== 'wiki_page')
        throw new Error('unsupported'); const regions = parseWikiRegions(frame.bodyMarkdown); if (!regions)
        throw new Error('invalid_anchors'); const id = crypto.randomUUID(), intro = regions.sections.length ? '' : regions.editorial.replace(/^# [^\n]+\n/, '').replace(/^\n/, ''); const editorial = regions.sections.length ? regions.editorial : regions.editorial.match(/^# [^\n]+\n/)![0] + '\n'; const body = editorial + sectionStart(id) + '\n## ' + this.t('obsidianEditing.sectionTitle') + '\n\n' + intro + '\n' + sectionEnd(id) + '\n\n^memora-section-' + id + '\n\n' + regions.generated; await this.app.vault.modify(file, serializeManagedFrontmatter(frame.frontmatter, frame.userFrontmatter) + '\n' + body); await this.capture(file); await this.flush(); }
    private async importCurrent() { const file = this.app.workspace.getActiveFile(); if (!file)
        return; const content = await this.app.vault.read(file); if (parseObsidianMarkdown(content)) {
        await this.capture(file);
        await this.flush();
        return;
    } try {
        const bytes = new TextEncoder().encode(content), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        await this.client.importNote({ requestId: crypto.randomUUID(), relativePath: file.path, title: file.basename, markdown: content, contentHash: hash, mtimeMs: file.stat.mtime });
        new Notice(this.t('integrations.messages.noteSent'));
    }
    catch {
        this.noticeError();
    } }
}
class SyncReviewModal extends Modal {
    constructor(app: App, private readonly plugin: MemoraObsidianPlugin) { super(app); }
    public override onOpen() {
        const t = this.plugin.t;
        this.titleEl.setText(t('obsidianEditing.review'));
        this.contentEl.empty();
        const rows = this.plugin.queue.state.operations;
        if (!rows.length)
            this.contentEl.createEl('p', { text: t('obsidianEditing.empty') });
        for (const row of rows) {
            const section = this.contentEl.createDiv();
            section.createEl('h3', { text: row.operation.relativePath });
            section.createEl('p', { text: t(row.receipt?.status === 'conflict' ? 'obsidianEditing.conflict' : 'obsidianEditing.pending') });
            if (row.error)
                section.createEl('p', { text: t(row.error.includes('paused') ? 'obsidianEditing.paused' : /unauthorized|forbidden/.test(row.error) ? 'obsidianEditing.rePair' : /ENOSPC|disk|queue_full/.test(row.error) ? 'obsidianEditing.diskError' : 'obsidianEditing.deliveryError') });
            const comparison = row.receipt?.comparison;
            if (!comparison) {
                const area = section.createEl('textarea');
                area.value = row.observedContent ?? row.operation.content;
                area.readOnly = true;
                area.rows = 6;
                area.style.width = '100%';
                area.setAttribute('aria-label', t('obsidianEditing.local'));
                continue;
            }
            new Setting(section).addButton(button => button.setButtonText(t('integrations.commands.reconcile')).onClick(async () => { try {
                await this.plugin.refreshComparison(row);
                this.onOpen();
            }
            catch {
                section.createEl('p', { text: t('obsidianEditing.stale') });
            } }));
            if (['path', 'duplicate'].includes(row.receipt?.reason ?? ''))
                new Setting(section).setDesc(t('obsidianEditing.detachHint')).addButton(button => button.setButtonText(t('obsidianEditing.detach')).onClick(async () => { try {
                    await this.plugin.detachCopy(row);
                    this.onOpen();
                }
                catch {
                    section.createEl('p', { text: t('obsidianEditing.stale') });
                } }));
            let merged = comparison.local;
            for (const [label, value] of [['obsidianEditing.base', comparison.base], ['obsidianEditing.local', comparison.local], ['obsidianEditing.app', comparison.app]] as const) {
                section.createEl('h4', { text: t(label) });
                const area = section.createEl('textarea');
                area.value = value;
                area.setAttribute('aria-label', t(label));
                area.readOnly = true;
                area.rows = 6;
                area.style.width = '100%';
            }
            const area = section.createEl('textarea');
            area.value = merged;
            area.rows = 8;
            area.style.width = '100%';
            area.oninput = () => { merged = area.value; };
            area.setAttribute('aria-label', t('obsidianEditing.manual'));
            for (const choice of ['local', 'app', 'manual'] as const)
                new Setting(section).addButton(button => button.setButtonText(t(choice === 'local' ? 'obsidianEditing.keepLocal' : choice === 'app' ? 'obsidianEditing.keepApp' : 'obsidianEditing.manual')).onClick(async () => { try {
                    await this.plugin.resolve(row, choice, merged);
                    this.onOpen();
                }
                catch {
                    section.createEl('p', { text: t('obsidianEditing.stale') });
                } }));
        }
        const settled=this.plugin.state.files.filter(file=>!rows.some(row=>row.operation.targetId===file.targetId));
        if(settled.length){const details=this.contentEl.createEl('details');details.createEl('summary',{text:t(this.plugin.syncMessage())});const list=details.createEl('ul');for(const file of settled)list.createEl('li',{text:file.relativePath+' · '+t(file.deleted?'obsidianEditing.deleted':this.plugin.syncMessage())});}
        new Setting(this.contentEl).addButton(button => button.setButtonText(t('integrations.commands.reconnect')).onClick(async () => { await this.plugin.reconnect(); this.onOpen(); }));
    }
}
class MemoraSettingTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: MemoraObsidianPlugin) { super(app, plugin); }
    public override display() {
        const t = this.plugin.t;
        this.containerEl.empty();
        new Setting(this.containerEl).setName(t('integrations.desktopGateway')).setDesc(t(this.plugin.connected ? 'integrations.states.connected' : 'integrations.states.disconnected'));
        for (const [key, label] of [['gatewayBaseUrl', 'integrations.gatewayAddress'], ['clientId', 'integrations.clientId'], ['pairingToken', 'integrations.pairingToken']] as const)
            new Setting(this.containerEl).setName(t(label)).addText(text => { if (key === 'pairingToken')
                text.inputEl.type = 'password'; return text.setValue(this.plugin.settings[key]).onChange(async (value) => { this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings(); }); });
        new Setting(this.containerEl).setName(t('settings.language.uiLocale')).addDropdown(dropdown => dropdown.addOptions({ en: 'English', 'pt-BR': 'Português', it: 'Italiano', fr: 'Français', es: 'Español' }).setValue(this.plugin.settings.locale).onChange(async (value) => { this.plugin.settings.locale = value as LanguageCode; await this.plugin.saveSettings(); this.display(); }));
        new Setting(this.containerEl).addButton(button => button.setButtonText(t('obsidianEditing.review')).onClick(() => new SyncReviewModal(this.app, this.plugin).open()));
        new Setting(this.containerEl).addButton(button => button.setButtonText(t('integrations.commands.reconnect')).onClick(async () => { await this.plugin.reconnect(); this.display(); }));
    }
}
