import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App
} from "obsidian";
import { createTranslator, type LanguageCode, type Translator } from "@app/i18n";

import type { ObsidianManagedFrontmatter } from "@app/integration-contracts";
import { hashMarkdown, parseManagedNote } from "./frontmatter.js";
import { ObsidianGatewayClient } from "./integration-client.js";

interface MemoraPluginSettings {
  gatewayBaseUrl: string;
  clientId: string;
  pairingToken: string;
  locale: LanguageCode;
}

const defaults: MemoraPluginSettings = {
  gatewayBaseUrl: "http://127.0.0.1:47831",
  clientId: "",
  pairingToken: "",
  locale: "en"
};

export default class MemoraObsidianPlugin extends Plugin {
  public override settings: MemoraPluginSettings = defaults;
  public connected = false;
  private client!: ObsidianGatewayClient;
  private identities = new Map<string, ObsidianManagedFrontmatter>();
  private t: Translator = createTranslator("en");

  public override async onload(): Promise<void> {
    this.settings = { ...defaults, ...await this.loadData() as Partial<MemoraPluginSettings> };
    this.t = createTranslator(this.settings.locale);
    this.client = new ObsidianGatewayClient(
      () => this.settings,
      (connected) => { this.connected = connected; },
      () => undefined
    );
    this.addSettingTab(new MemoraSettingTab(this.app, this));
    this.addCommand({
      id: "memora-import-current-note",
      name: this.t("integrations.commands.importCurrentNote"),
      callback: () => void this.importCurrentNote()
    });
    this.addCommand({
      id: "memora-reconnect",
      name: this.t("integrations.commands.reconnect"),
      callback: () => void this.reconnect()
    });
    this.addCommand({
      id: "memora-reconcile",
      name: this.t("integrations.commands.reconcile"),
      callback: () => void this.reconcile(true)
    });
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) void this.notifyChanged(file, "created");
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.notifyChanged(file, "modified");
    }));
    this.registerEvent(this.app.vault.on("rename", (file, previousPath) => {
      if (file instanceof TFile) void this.notifyMoved(file, previousPath);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) void this.notifyDeleted(file.path);
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.reconnect().then(() => this.reconcile(false)).catch(() => undefined);
    });
  }

  public override onunload(): void {
    this.client.disconnect();
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.t = createTranslator(this.settings.locale);
  }

  public async reconnect(): Promise<void> {
    this.client.disconnect();
    try {
      await this.client.connect();
      new Notice(this.t("integrations.states.connected"));
    } catch {
      new Notice(this.t("integrations.messages.desktopUnavailable"));
      throw new Error("desktop_unavailable");
    }
  }

  private async importCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const content = await this.app.vault.read(file);
    const parsed = parseManagedNote(content);
    const markdown = parsed?.markdown ?? content;
    await this.client.importNote({
      requestId: crypto.randomUUID(),
      relativePath: file.path,
      title: file.basename,
      markdown,
      ...(parsed ? { frontmatter: parsed.frontmatter } : {}),
      contentHash: await hashMarkdown(markdown),
      mtimeMs: file.stat.mtime
    });
    new Notice(this.t("integrations.messages.noteSent"));
  }

  private async notifyChanged(file: TFile, kind: "created" | "modified"): Promise<void> {
    const note = await this.readManaged(file);
    if (!note) return;
    this.identities.set(file.path, note.frontmatter);
    await this.client.fileChanged({
      eventId: crypto.randomUUID(),
      kind,
      occurredAt: new Date().toISOString(),
      note: {
        requestId: crypto.randomUUID(),
        relativePath: file.path,
        title: file.basename,
        markdown: note.markdown,
        frontmatter: note.frontmatter,
        contentHash: await hashMarkdown(note.markdown),
        mtimeMs: file.stat.mtime
      }
    }).catch(() => undefined);
  }

  private async notifyMoved(file: TFile, previousPath: string): Promise<void> {
    const note = await this.readManaged(file);
    const frontmatter = note?.frontmatter ?? this.identities.get(previousPath);
    if (!frontmatter) return;
    this.identities.delete(previousPath);
    this.identities.set(file.path, frontmatter);
    await this.client.fileMoved({
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      memoraId: frontmatter.memoraId,
      previousRelativePath: previousPath,
      relativePath: file.path,
      syncVersion: frontmatter.memoraSyncVersion,
      mtimeMs: file.stat.mtime
    }).catch(() => undefined);
  }

  private async notifyDeleted(path: string): Promise<void> {
    const frontmatter = this.identities.get(path);
    if (!frontmatter) return;
    this.identities.delete(path);
    await this.client.fileDeleted({
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      memoraId: frontmatter.memoraId,
      relativePath: path,
      syncVersion: frontmatter.memoraSyncVersion
    }).catch(() => undefined);
  }

  private async reconcile(showNotice: boolean): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const snapshots = [];
    this.identities.clear();
    for (const file of files) {
      const note = await this.readManaged(file);
      if (!note) continue;
      this.identities.set(file.path, note.frontmatter);
      snapshots.push({
        relativePath: file.path,
        frontmatter: note.frontmatter,
        contentHash: await hashMarkdown(note.markdown),
        mtimeMs: file.stat.mtime,
        markdown: note.markdown
      });
    }
    await this.client.reconcile({ requestId: crypto.randomUUID(), scannedAt: new Date().toISOString(), files: snapshots });
    if (showNotice) new Notice(this.t("integrations.messages.reconciliationComplete"));
  }

  private async readManaged(file: TFile) {
    return parseManagedNote(await this.app.vault.read(file));
  }
}

class MemoraSettingTab extends PluginSettingTab {
  public constructor(app: App, private readonly plugin: MemoraObsidianPlugin) { super(app, plugin); }

  public override display(): void {
    const { containerEl } = this;
    const t = createTranslator(this.plugin.settings.locale);
    containerEl.empty();
    new Setting(containerEl).setName(t("integrations.desktopGateway"))
      .setDesc(this.plugin.connected ? t("integrations.states.connected") : t("integrations.states.disconnected"));
    new Setting(containerEl).setName(t("integrations.gatewayAddress")).addText((text) => text
      .setValue(this.plugin.settings.gatewayBaseUrl)
      .onChange(async (value) => { this.plugin.settings.gatewayBaseUrl = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName(t("integrations.clientId")).addText((text) => text
      .setValue(this.plugin.settings.clientId)
      .onChange(async (value) => { this.plugin.settings.clientId = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName(t("integrations.pairingToken")).addText((text) => {
      text.inputEl.type = "password";
      return text.setValue(this.plugin.settings.pairingToken)
        .onChange(async (value) => { this.plugin.settings.pairingToken = value.trim(); await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName(t("settings.language.uiLocale")).addDropdown((dropdown) => dropdown
      .addOptions({ en: "English", "pt-BR": "Portugues", it: "Italiano", fr: "Francais", es: "Espanol" })
      .setValue(this.plugin.settings.locale)
      .onChange(async (value) => { this.plugin.settings.locale = value as LanguageCode; await this.plugin.saveSettings(); this.display(); }));
    new Setting(containerEl).addButton((button) => button
      .setButtonText(t("integrations.commands.reconnect"))
      .onClick(() => void this.plugin.reconnect().then(() => this.display()).catch(() => undefined)));
  }
}
