import type { LanguageCode, MessageKey, Translator } from "@app/i18n";
import type { ObsidianLayoutStatus } from "@app/integration-contracts";

import type {
  IntegrationClient,
  IntegrationGatewayStatus,
  ObsidianSyncStatus
} from "../../../../shared/ipc";
import type { StatusTone } from "../../SettingControls";
import {
  bookLookupModes,
  obsidianSyncModes,
  type BookLookupMode,
  type ObsidianSyncMode
} from "../../../components/settings/merged-controls";

/**
 * What Settings › Integrations shows, as pure functions (F5 T164, the Settings v2 mockup): the words
 * of each choice, when a sync ran, what the layout migration is waiting for and the summary of the
 * paired apps.
 */

export { bookLookupModes, obsidianSyncModes, type BookLookupMode, type ObsidianSyncMode };

export const syncModeLabel: Readonly<Record<ObsidianSyncMode, MessageKey>> = {
  off: "settingsIntegrations.sync.off",
  on: "settingsIntegrations.sync.on",
  paused: "settingsIntegrations.sync.paused"
};

export const bookModeLabel: Readonly<Record<BookLookupMode, MessageKey>> = {
  off: "settingsIntegrations.books.off",
  auto: "settingsIntegrations.books.auto",
  "open-library": "settingsIntegrations.books.openLibrary",
  "google-books": "settingsIntegrations.books.googleBooks"
};

/** The mode a `describe` value stands for (the adapters answer "off", "on" or "paused"). */
export const syncModeOfValue = (value: unknown): ObsidianSyncMode =>
  value === "on" || value === "paused" ? value : "off";

export const bookModeOfValue = (value: unknown): BookLookupMode =>
  (bookLookupModes as readonly unknown[]).includes(value) ? (value as BookLookupMode) : "auto";

/** "today, 09:12", "yesterday, 22:14" or "Nov 10, 09:12", in the person's language. */
export function formatWhen(t: Translator, locale: LanguageCode, iso: string, now: Date): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const apart = Math.round((day(now) - day(at)) / 86_400_000);
  if (apart === 0) return t("settingsIntegrations.when.today", { values: { time } });
  if (apart === 1) return t("settingsIntegrations.when.yesterday", { values: { time } });
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
  return t("settingsIntegrations.when.other", { values: { date, time } });
}

export interface SyncLine {
  tone: StatusTone;
  text: string;
  /** "Synchronize now" is offered when no run is going and the sync is on. */
  canRun: boolean;
  /** Progress of the run that is going, 0 to 1. */
  progress: number | null;
}

/**
 * The line under the sync control: running, failed, or when it last finished. What waits for review
 * is counted once, by "Vault reviews" (`waiting`, the same number): the sync's own conflict count
 * would be a second, differing count of the same pages, so the line takes the review's.
 */
export function syncLine(
  t: Translator,
  mode: ObsidianSyncMode,
  status: ObsidianSyncStatus,
  now: Date,
  waiting: number
): SyncLine | null {
  if (mode === "off") return null;
  if (mode === "paused")
    return {
      tone: "idle",
      text: t("settingsIntegrations.sync.pausedNote"),
      canRun: false,
      progress: null
    };
  if (status.state === "running")
    return {
      tone: "working",
      text: t(`obsidianSync.stages.${status.stage}` as MessageKey),
      canRun: false,
      progress: status.progress
    };
  if (status.state === "failed")
    return {
      tone: "warn",
      text: t("settingsIntegrations.sync.failed"),
      canRun: true,
      progress: null
    };
  if (status.finishedAt === null)
    return {
      tone: "idle",
      text: t("settingsIntegrations.sync.never"),
      canRun: true,
      progress: null
    };
  return {
    tone: waiting > 0 ? "warn" : "ok",
    text: `${t("settingsIntegrations.sync.last", {
      values: { when: formatWhen(t, t.locale, status.finishedAt, now) }
    })}${waiting > 0 ? ` · ${reviewText(t, waiting)}` : ""}`,
    canRun: true,
    progress: null
  };
}

export const reviewText = (t: Translator, count: number): string =>
  t(count === 1 ? "settingsIntegrations.sync.reviewOne" : "settingsIntegrations.sync.reviewMany", {
    values: { count }
  });

export const sourcesText = (t: Translator, count: number): string =>
  count === 0
    ? t("settingsIntegrations.scope.all")
    : t(
        count === 1
          ? "settingsIntegrations.scope.countOne"
          : "settingsIntegrations.scope.countMany",
        {
          values: { count }
        }
      );

// ---------------------------------------------------------------------------------------------
// The layout migration (copying the original files into the vault moves the vault's folders)

export type LayoutMigration = ObsidianLayoutStatus["migrations"][number];

/** A migration that was prepared and has not finished: the person still has a step to take. */
const OPEN_STATUSES = ["preview", "quiescing", "partial", "applying", "rolling_back"] as const;
export const migrationIsOpen = (migration: LayoutMigration | undefined): boolean =>
  migration !== undefined && (OPEN_STATUSES as readonly string[]).includes(migration.status);

/**
 * Whether the "copy the original files" switch reads as on: what the person asked for while a
 * migration waits to be applied (the switch moves at once, and the review says what is left), else
 * what is applied. A rollback in progress shows the applied value.
 */
export function attachmentsOn(status: ObsidianLayoutStatus | null, applied: boolean): boolean {
  const latest = status?.migrations[0];
  if (latest && migrationIsOpen(latest) && latest.status !== "rolling_back")
    return latest.config.attachments === "copy";
  return status?.config ? status.config.attachments === "copy" : applied;
}

export type LayoutStep = "review" | "waiting" | "rollback" | "partial" | "completed" | "rolledBack";

/** What the latest migration is waiting for, in one word the copy turns into a sentence. */
export function layoutStep(migration: LayoutMigration): LayoutStep {
  switch (migration.status) {
    case "completed":
      return "completed";
    case "rolled_back":
      return "rolledBack";
    case "quiescing":
      return "waiting";
    case "rolling_back":
      return "rollback";
    case "partial":
      return "partial";
    default:
      return "review";
  }
}

/** How many of a migration's files are done (or rolled back), for "3 of 12 files". */
export function layoutSettled(migration: LayoutMigration): number {
  const rolling = migration.status === "rolling_back" || migration.status === "rolled_back";
  return migration.targets.filter(
    (row) => row.status === (rolling ? "rolled_back" : "done") || row.status === "excluded"
  ).length;
}

// ---------------------------------------------------------------------------------------------
// The gateway

export function gatewayMeta(
  t: Translator,
  gateway: IntegrationGatewayStatus | null,
  clients: readonly IntegrationClient[] | null
): string | null {
  if (!gateway || !clients) return null;
  const paired = clients.filter((client) => client.status === "paired").length;
  const state = t(`settingsIntegrations.gateway.states.${gateway.state}` as MessageKey);
  return t(
    paired === 0
      ? "settingsIntegrations.gateway.metaNone"
      : paired === 1
        ? "settingsIntegrations.gateway.metaOne"
        : "settingsIntegrations.gateway.metaMany",
    { values: { count: paired, state } }
  );
}

export const clientKindLabel = (clientType: string): MessageKey =>
  clientType === "obsidian-plugin"
    ? "settingsIntegrations.gateway.kinds.obsidianPlugin"
    : "settingsIntegrations.gateway.kinds.chromeExtension";
