import { createSettingsRepository, type Queryable } from "@app/db";
import {
  recommendedMatchingPresetId,
  type AiPresetId,
  type KnowledgeControls,
  type NoteDeciderMode
} from "@app/domain";

import type { AppEvent } from "../../shared/app-events.js";
import type { AiClassRouteTarget, AppSettings, StorageSettings } from "../../shared/ipc.js";
import type {
  SettingDescription,
  SettingsDescribeResult,
  SettingsResetResult
} from "../../shared/ipc-settings-describe.js";
import {
  settingsRegistryV2,
  type Json,
  type ResetAdapterId,
  type SettingEntryV2
} from "../../shared/settings-registry.js";
import { appEventPort } from "./app-events.js";
import type { AiService } from "./ai-service.js";
import type { CredentialService } from "./credential-service.js";
import type { KnowledgeControlsService } from "./gardener/knowledge-controls.js";
import type { MetadataEnrichmentService } from "./metadata-enrichment-service.js";
import type { ObsidianLayoutMigration } from "./obsidian-layout-migration.js";
import type { ObsidianWikiProjection } from "./obsidian-wiki-projection.js";
import type { SettingsService } from "./settings-service.js";

/**
 * "Changed from default" and the reset of Settings v2 (F5 T160, D17, spec 3.8). Every entry of the
 * registry that stores something names a reset adapter; an adapter reads the setting's value the
 * way its control shows it and puts it back through the setting's own writer, so validation and the
 * side effects of that writer are unchanged: the settings service for the two stores it owns, the
 * Knowledge controls service, the AI service (setup, routes, decider, providers, the Decisions
 * opt-in and key), the Obsidian wiki and layout services, and the metadata service. A reset of a
 * setting that already holds its default writes nothing and publishes nothing.
 *
 * What the renderer is told never holds a secret or a filesystem path: a credential or a folder
 * reads `true` once set and `null` while it is not.
 */

/** The stores a `settings.changed` names; the settings service announces `app` and `storage` itself. */
type AnnouncedStore = Extract<AppEvent, { type: "settings.changed" }>["stores"][number];

/** What this service needs of the rest of the main process; each member is the writer of its setting. */
export interface SettingsResetPorts {
  settings: Pick<SettingsService, "getApp" | "updateApp" | "get" | "update" | "osLanguage">;
  ai: () => Pick<
    AiService,
    | "classRoutes"
    | "presetDefaults"
    | "applyPreset"
    | "setClassRoute"
    | "setDeciderMode"
    | "decisionsStatus"
    | "setDecisionsEnabled"
    | "removeDecisionsKey"
    | "listProviders"
  > | null;
  /** The setup this Mac's hardware recommends (informative; decision 26); null when unknown. */
  recommendedPreset: () => Promise<AiPresetId | null>;
  knowledgeControls: () => Pick<KnowledgeControlsService, "get" | "update"> | null;
  /** Told after the tree shape moved, as the Knowledge controls' own handler does (F4 D13). */
  treeShapeChanged?: () => void;
  obsidian: () => {
    wiki: Pick<ObsidianWikiProjection, "layout" | "scope" | "saveScope">;
    layoutMigration: Pick<ObsidianLayoutMigration, "preview">;
  } | null;
  googleBooks: () => Pick<
    MetadataEnrichmentService,
    "getGoogleBooksKeyStatus" | "updateGoogleBooksKey"
  > | null;
  /** The database, for the `settings` rows with no service of their own (the model repository token). */
  pool: () => Queryable | null;
  credentials: Pick<CredentialService, "remove">;
  registry?: readonly SettingEntryV2[];
  publish?: (event: AppEvent) => void;
  logger?: Pick<Console, "warn">;
}

type SetupDefaults = Awaited<
  ReturnType<NonNullable<ReturnType<SettingsResetPorts["ai"]>>["presetDefaults"]>
>;

const noDefaults: SetupDefaults = { routes: {}, deciderMode: null };

interface Reading {
  value: Json;
  /** Null when the default depends on the machine or on another setting. */
  default: Json | null;
  changed: boolean;
}

/** One setting kind: how it is read and how it is put back. */
interface Adapter {
  /** The store to announce after a reset, per entry; absent when the writer announces itself. */
  announces?: AnnouncedStore | ((entry: SettingEntryV2) => AnnouncedStore);
  /** The other settings the writer moves besides the entry (they go in the same event's keys). */
  moves?: (entry: SettingEntryV2) => readonly string[];
  read(entry: SettingEntryV2, context: Context): Promise<Reading>;
  /**
   * Writes the default through the setting's writer. `pending` when a confirmed step remains;
   * `wrote: false` when nothing was written (the step needs the person's confirmation first).
   */
  write(
    entry: SettingEntryV2,
    context: Context,
    before: Reading,
    confirmed: boolean
  ): Promise<{ pending?: true; wrote?: false } | void>;
}

/** The stores of one describe or one reset, each read at most once. */
interface Context {
  ports: SettingsResetPorts;
  app(): Promise<AppSettings>;
  storage(): Promise<StorageSettings>;
  routes(): Promise<Awaited<ReturnType<AiService["classRoutes"]>>>;
  /** The setup the person is on (null on Custom or before any); the routes' own default is it. */
  currentSetup(): Promise<AiPresetId | null>;
  /** What the setup of the routes gives (the current one; on Custom the recommended one), read only. */
  setupDefaults(): Promise<SetupDefaults>;
  /** What the person's current setup gives; empty on Custom or before any setup. */
  currentDefaults(): Promise<SetupDefaults>;
  decisions(): Promise<Awaited<ReturnType<AiService["decisionsStatus"]>>>;
  controls(): Promise<KnowledgeControls>;
  ai(): NonNullable<ReturnType<SettingsResetPorts["ai"]>>;
  obsidian(): NonNullable<ReturnType<SettingsResetPorts["obsidian"]>>;
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const missing = () => new Error("errors.common.missingConfiguration");

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | null = null;
  return () => (loaded ??= load());
}

function createContext(ports: SettingsResetPorts): Context {
  const ai = () =>
    ports.ai() ??
    (() => {
      throw missing();
    })();
  const obsidian = () =>
    ports.obsidian() ??
    (() => {
      throw missing();
    })();
  const routes = once(async () => ai().classRoutes());
  const currentSetup = once(async () => {
    const preset = (await routes()).preset;
    return preset !== null && preset !== "custom" ? preset : null;
  });
  const currentDefaults = once(async () => {
    const setup = await currentSetup();
    return setup ? ai().presetDefaults(setup) : noDefaults;
  });
  const setupDefaults = once(async () => {
    if (await currentSetup()) return currentDefaults();
    // Routes pointed by hand (Custom) are compared with what the recommended setup gives; before
    // any setup the routes come from the legacy mapping and no default is claimed for them.
    if ((await routes()).preset !== "custom") return noDefaults;
    const recommended = await ports.recommendedPreset().catch(() => null);
    return recommended ? ai().presetDefaults(recommended) : noDefaults;
  });
  return {
    ports,
    app: once(() => ports.settings.getApp()),
    storage: once(() => ports.settings.get()),
    routes,
    currentSetup,
    currentDefaults,
    setupDefaults,
    decisions: once(async () => ai().decisionsStatus()),
    controls: once(async () => {
      const controls = ports.knowledgeControls();
      if (!controls) throw missing();
      return controls.get();
    }),
    ai,
    obsidian
  };
}

/** The value at a path of the stored document: `sourceRelationSettings.minImportance`. */
function valueAt(document: object, path: string): Json {
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return (current ?? null) as Json;
}

const defaultValue = (entry: SettingEntryV2): Json | null =>
  "value" in entry.default ? entry.default.value : null;

const key = (entry: SettingEntryV2): string => entry.store.keys[0] ?? entry.id;

/** What an unset list setting is stored as. */
const emptyValues: Readonly<Record<string, Json>> = { processingPresets: [] };

// --- the two stores of the settings service (it announces its own writes) ------------------------

const appPreference: Adapter = {
  async read(entry, context) {
    const stored = valueAt(await context.app(), key(entry));
    if ("unset" in entry.default) {
      const set = Array.isArray(stored) ? stored.length > 0 : stored !== null;
      return { value: set ? true : null, default: null, changed: set };
    }
    const fallback =
      "osLocale" in entry.default ? context.ports.settings.osLanguage() : defaultValue(entry);
    return { value: stored, default: fallback, changed: !same(stored, fallback) };
  },
  async write(entry, context, _before, confirmed) {
    const name = key(entry);
    // A list the person built (their saved import plans) is not emptied without their yes.
    if (Object.hasOwn(emptyValues, name) && !confirmed) return { pending: true, wrote: false };
    const value =
      "unset" in entry.default
        ? emptyValues[name]
        : "osLocale" in entry.default
          ? context.ports.settings.osLanguage()
          : defaultValue(entry);
    if (value === undefined) throw new Error("errors.common.validationFailed");
    await context.ports.settings.updateApp({ [name]: value } as never);
  }
};

const matchingValue: Adapter = {
  async read(entry, context) {
    const value = valueAt(await context.app(), entry.id);
    const fallback = defaultValue(entry);
    return { value, default: fallback, changed: !same(value, fallback) };
  },
  async write(entry, context) {
    const fallback = defaultValue(entry);
    const [group, member] = entry.id.split(".") as [string, string | undefined];
    if (!member) {
      await context.ports.settings.updateApp({ [group]: fallback } as never);
      return;
    }
    const current = ((await context.app()) as unknown as Record<string, object>)[group];
    await context.ports.settings.updateApp({
      [group]: { ...current, [member]: fallback }
    } as never);
  }
};

const matchingPreset: Adapter = {
  async read(_entry, context) {
    const value = (await context.app()).activeMatchingPresetId ?? recommendedMatchingPresetId;
    return {
      value,
      default: recommendedMatchingPresetId,
      changed: value !== recommendedMatchingPresetId
    };
  },
  async write(_entry, context) {
    // Selecting the Recommended preset keeps the person's saved presets; only the selection moves.
    await context.ports.settings.updateApp({ activeMatchingPresetId: recommendedMatchingPresetId });
  }
};

const storageSetting: Adapter = {
  async read(entry, context) {
    const name = key(entry) as "obsidianVaultPath" | "managedRoot";
    const stored = (await context.storage())[name];
    if (name === "obsidianVaultPath")
      return { value: stored ? true : null, default: null, changed: Boolean(stored) };
    const fallback = defaultValue(entry);
    return { value: stored, default: fallback, changed: !same(stored, fallback) };
  },
  async write(entry, context) {
    const name = key(entry);
    await context.ports.settings.update({
      [name]: name === "obsidianVaultPath" ? null : defaultValue(entry)
    } as never);
  }
};

const syncState = (storage: StorageSettings): Json =>
  storage.obsidianSyncEnabled ? (storage.obsidianSyncPaused ? "paused" : "on") : "off";

const obsidianSync: Adapter = {
  async read(entry, context) {
    const value = syncState(await context.storage());
    return { value, default: defaultValue(entry), changed: value !== "off" };
  },
  async write(_entry, context) {
    await context.ports.settings.update({ obsidianSyncEnabled: false, obsidianSyncPaused: false });
  }
};

const uploadCopies: Adapter = {
  async read(entry, context) {
    const storage = await context.storage();
    const changed = storage.uploadCopiesEnabled || storage.uploadCopiesFolderPath !== null;
    return { value: changed, default: defaultValue(entry), changed };
  },
  async write(_entry, context) {
    await context.ports.settings.update({
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null
    });
  }
};

const bookLookup: Adapter = {
  async read(entry, context) {
    const app = await context.app();
    const value = app.metadataEnrichmentEnabled ? app.bookMetadataProvider : "off";
    return { value, default: defaultValue(entry), changed: value !== defaultValue(entry) };
  },
  async write(entry, context) {
    await context.ports.settings.updateApp({
      metadataEnrichmentEnabled: true,
      bookMetadataProvider: defaultValue(entry) as "auto"
    });
  }
};

// --- the Knowledge controls ------------------------------------------------------------------------

const knowledgeControl: Adapter = {
  announces: "knowledge.controls",
  async read(entry, context) {
    const field = entry.id.slice("knowledge.controls.v1.".length) as keyof KnowledgeControls;
    const value = (await context.controls())[field] as Json;
    const fallback = defaultValue(entry);
    return { value, default: fallback, changed: !same(value, fallback) };
  },
  async write(entry, context) {
    const field = entry.id.slice("knowledge.controls.v1.".length) as keyof KnowledgeControls;
    const controls = context.ports.knowledgeControls();
    if (!controls) throw missing();
    const before = await controls.get();
    const after = await controls.update({ [field]: defaultValue(entry) });
    // A new tree shape proposes a rebuild for review, as the controls' own handler does (D13).
    if (field === "treeShape" && before.treeShape !== after.treeShape)
      context.ports.treeShapeChanged?.();
  }
};

// --- AI: the setup, the routes, the decider, the Decisions opt-in -------------------------------------

/** Re-applies a setup through the writer that seeds the routes; nothing is written when it is blocked. */
async function applySetup(context: Context, preset: AiPresetId): Promise<void> {
  const result = await context.ai().applyPreset({ preset, test: false });
  if (!result.applied) throw new Error("errors.ai.noCompatibleModel");
}

/** Every setting a setup writes: the setup, the six routes and the note decider mode. */
const setupMoves = [
  "ai.preset.v1",
  "ai.route.embed",
  "ai.route.decide",
  "ai.route.write-fast",
  "ai.route.write-quality",
  "ai.route.answer",
  "ai.route.judge",
  "relations.deciderMode"
] as const;

const aiPreset: Adapter = {
  announces: "ai",
  moves: () => setupMoves,
  async read(_entry, context) {
    const value = (await context.routes()).preset;
    const recommended = await context.ports.recommendedPreset().catch(() => null);
    return {
      value,
      default: recommended,
      changed: value !== null && recommended !== null && value !== recommended
    };
  },
  async write(_entry, context) {
    const recommended = await context.ports.recommendedPreset();
    if (!recommended) throw new Error("errors.ai.noCompatibleModel");
    await applySetup(context, recommended);
  }
};

const routeName = (entry: SettingEntryV2): AiClassRouteTarget =>
  key(entry).replace(/^class:/u, "") as AiClassRouteTarget;

const aiRoute: Adapter = {
  announces: "ai",
  // A route written by hand is the Custom setup, which the writer records with it.
  moves: () => ["ai.preset.v1"],
  async read(entry, context) {
    const routes = await context.routes();
    const name = routeName(entry);
    const route =
      name === "judge" ? routes.judge : routes.classes.find((candidate) => candidate.id === name);
    const value = route?.profileId ?? null;
    // The default is the profile of the setup this person is on (the recommended one on Custom),
    // when one exists already; a route that is not set, or whose setup would first need a profile
    // made, has no default to go back to and reads as unchanged.
    const fallback = (await context.setupDefaults()).routes[name] ?? null;
    return {
      value,
      default: fallback,
      changed: value !== null && fallback !== null && value !== fallback
    };
  },
  async write(entry, context, before) {
    // One route goes back through the writer of one route, never through the whole setup: the other
    // routes, the decider and the setup keep what the person chose.
    if (typeof before.default !== "string") throw new Error("errors.ai.noCompatibleModel");
    await context.ai().setClassRoute({ route: routeName(entry), profileId: before.default });
  }
};

const deciderMode: Adapter = {
  announces: "ai",
  async read(_entry, context) {
    const value = (await context.routes()).judge.deciderMode;
    // A setup stores the mode its plan names; that is what the setting holds by default. With no
    // setup behind it (Custom) the mode is derived from the routes, which an unset mode stands for.
    const fallback = (await context.currentDefaults()).deciderMode;
    return { value, default: fallback, changed: value !== fallback };
  },
  async write(_entry, context, before) {
    await context.ai().setDeciderMode((before.default as NoteDeciderMode | null) ?? null);
  }
};

const decisionsOptIn: Adapter = {
  announces: "ai",
  async read(entry, context) {
    const value = (await context.decisions()).enabled;
    return { value, default: defaultValue(entry), changed: value !== defaultValue(entry) };
  },
  async write(_entry, context) {
    await context.ai().setDecisionsEnabled(false);
  }
};

// --- credentials: set or not, never the secret ---------------------------------------------------------

const providerKind = (entry: SettingEntryV2): string => entry.id.slice("ai.provider.".length);

const credentialReaders: Readonly<
  Record<string, (context: Context, entry: SettingEntryV2) => Promise<boolean>>
> = {
  "local-models.repository-token-ref": async (context, entry) => {
    const pool = context.ports.pool();
    if (!pool) throw new Error("errors.database.notReady");
    return Boolean(await createSettingsRepository(pool).get(key(entry)));
  },
  "ai:decisions-openai-platform": async (context) => (await context.decisions()).keyStored,
  "metadata:google-books": async (context) => {
    const books = context.ports.googleBooks();
    if (!books) throw missing();
    return (await books.getGoogleBooksKeyStatus()).configured;
  }
};

const credentialWriters: Readonly<
  Record<string, (context: Context, entry: SettingEntryV2) => Promise<void>>
> = {
  "local-models.repository-token-ref": async (context, entry) => {
    const pool = context.ports.pool();
    if (!pool) throw new Error("errors.database.notReady");
    const settings = createSettingsRepository(pool);
    const reference = await settings.get<string>(key(entry));
    if (reference) await context.ports.credentials.remove(reference);
    await settings.delete(key(entry));
  },
  "ai:decisions-openai-platform": async (context) => {
    await context.ai().removeDecisionsKey();
  },
  "metadata:google-books": async (context) => {
    const books = context.ports.googleBooks();
    if (!books) throw missing();
    await books.updateGoogleBooksKey(null);
  }
};

/** The store a credential's status is read from: a consumer of that store reads it again. */
const credentialStores: Readonly<Record<string, AnnouncedStore>> = {
  "metadata:google-books": "app"
};

const credential: Adapter = {
  announces: (entry) => credentialStores[entry.id] ?? "ai",
  async read(entry, context) {
    const reader = credentialReaders[entry.id];
    const set = reader
      ? await reader(context, entry)
      : (await context.ai().listProviders()).some(
          (provider) => provider.provider === providerKind(entry) && provider.secretConfigured
        );
    return { value: set ? true : null, default: null, changed: set };
  },
  async write(entry, context) {
    const writer = credentialWriters[entry.id];
    if (writer) return writer(context, entry);
    // A provider's key lives in its configuration and the AI service has no writer for the key
    // alone: removing it means deleting a configuration, which unlinks the profiles on it. That is
    // the Providers page's confirmed, per-configuration step, so a reset only points there.
    return { pending: true, wrote: false };
  }
};

// --- Obsidian: the wiki scope and the journaled layout ----------------------------------------------------

const wikiScope: Adapter = {
  announces: "obsidian",
  async read(entry, context) {
    const scope = await context.obsidian().wiki.scope();
    if (entry.id === "obsidian.wiki.includeDescendants")
      return {
        value: scope.includeDescendants,
        default: defaultValue(entry),
        changed: scope.includeDescendants !== defaultValue(entry)
      };
    return {
      value: scope.sourceIds.length > 0 ? scope.sourceIds.length : null,
      default: null,
      changed: scope.sourceIds.length > 0
    };
  },
  async write(entry, context) {
    const wiki = context.obsidian().wiki;
    const scope = await wiki.scope();
    await wiki.saveScope(
      entry.id === "obsidian.wiki.includeDescendants"
        ? { sourceIds: scope.sourceIds, includeDescendants: true }
        : { sourceIds: [], includeDescendants: scope.includeDescendants }
    );
  }
};

const obsidianLayout: Adapter = {
  announces: "obsidian",
  async read(entry, context) {
    const layout = await context.obsidian().wiki.layout();
    if (entry.id === "obsidian.layout.attachments") {
      const value = layout?.attachments ?? "omit";
      return { value, default: defaultValue(entry), changed: value !== "omit" };
    }
    // The layout language follows the language of the notes until the person overrides it.
    const followed = (await context.app()).contentLanguage;
    return {
      value: layout?.language ?? followed,
      default: followed,
      changed: layout !== null && layout.language !== followed
    };
  },
  async write(entry, context) {
    const { wiki, layoutMigration } = context.obsidian();
    const layout = await wiki.layout();
    if (!layout) return;
    const followed = (await context.app()).contentLanguage;
    // The layout moves the vault's folders: the reset prepares the journaled migration, which the
    // person applies once the editors are closed. Nothing in the vault changes here.
    await layoutMigration.preview(
      entry.id === "obsidian.layout.attachments"
        ? { ...layout, attachments: "omit" }
        : { ...layout, language: followed }
    );
    return { pending: true };
  }
};

const adapters: Readonly<Record<Exclude<ResetAdapterId, "none">, Adapter>> = {
  "ai-preset": aiPreset,
  "ai-route": aiRoute,
  "app-preference": appPreference,
  "book-lookup": bookLookup,
  credential,
  "decider-mode": deciderMode,
  "decisions-opt-in": decisionsOptIn,
  "knowledge-control": knowledgeControl,
  "matching-preset": matchingPreset,
  "matching-value": matchingValue,
  "obsidian-layout": obsidianLayout,
  "obsidian-sync": obsidianSync,
  "obsidian-wiki-scope": wikiScope,
  "storage-setting": storageSetting,
  "upload-copies": uploadCopies
};

export class SettingsReset {
  private readonly registry: readonly SettingEntryV2[];

  public constructor(private readonly ports: SettingsResetPorts) {
    this.registry = ports.registry ?? settingsRegistryV2;
  }

  /**
   * The value, the default and the "changed" marker of every entry that stores something. A store
   * that cannot be read now leaves its entries out (a warning names the first failure of each).
   */
  public async describe(): Promise<SettingsDescribeResult> {
    const context = createContext(this.ports);
    const entries: SettingDescription[] = [];
    const failed = new Set<string>();
    for (const entry of this.registry) {
      const adapter = this.adapterOf(entry);
      if (!adapter) continue;
      try {
        const reading = await adapter.read(entry, context);
        entries.push({ id: entry.id, ...reading });
      } catch (error) {
        if (!failed.has(entry.reset)) {
          failed.add(entry.reset);
          (this.ports.logger ?? console).warn(
            `Settings: ${entry.id} could not be described`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
    return { entries };
  }

  /**
   * Puts one entry back through its writer and says what it holds now. A setting that holds its
   * default is left alone. The settings service announces its own writes; every other adapter
   * publishes `settings.changed` for its store after the write committed.
   */
  public async reset(input: {
    id: string;
    confirmed?: boolean | undefined;
  }): Promise<SettingsResetResult> {
    const entry = this.registry.find((candidate) => candidate.id === input.id);
    if (!entry) throw new Error("errors.common.notFound");
    const adapter = this.adapterOf(entry);
    if (!adapter) throw new Error("errors.common.validationFailed");
    const before = await adapter.read(entry, createContext(this.ports));
    if (!before.changed) return { id: entry.id, value: before.value };
    const outcome = await adapter.write(
      entry,
      createContext(this.ports),
      before,
      input.confirmed === true
    );
    if (adapter.announces && outcome?.wrote !== false)
      (this.ports.publish ?? ((event) => appEventPort.publish(event)))({
        type: "settings.changed",
        stores: [
          typeof adapter.announces === "function" ? adapter.announces(entry) : adapter.announces
        ],
        keys: [...new Set([entry.id, ...(adapter.moves?.(entry) ?? [])])]
      });
    const after = await adapter.read(entry, createContext(this.ports));
    return {
      id: entry.id,
      value: after.value,
      ...(outcome?.pending ? { pending: true as const } : {})
    };
  }

  private adapterOf(entry: SettingEntryV2): Adapter | null {
    if (entry.reset === "none" || entry.store.kind === "none") return null;
    return adapters[entry.reset];
  }
}
