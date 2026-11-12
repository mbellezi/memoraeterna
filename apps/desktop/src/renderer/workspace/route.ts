import {
  formatObjectAddress,
  inboxKinds,
  objectKinds,
  parseObjectAddress,
  type InboxKind,
  type ObjectAddress,
  type ObjectKind
} from "@app/domain";

/**
 * View addresses: the places of the workspace that are not objects (docs/f5-decisions.md D10).
 * Object addresses belong to `@app/domain`; this module is the only parser of the rest, and it is
 * renderer-only: an external deep link never reaches a view.
 *
 *   memora://home | memora://explore
 *   memora://library[?tab=sources|questions][&q=…][&sort=…][&dir=asc|desc][&status=…][&topic=<uuid>]
 *   memora://inbox[?kind=<InboxKind>]
 *   memora://map/relations|shape[?scope=<object address>]
 *   memora://settings[/<section>[#<setting>]]
 *   memora://search?q=…[&kinds=<kind>,<kind>]
 *   memora://ask[?q=…|draft=…][&scope=<object address>]
 *   memora://import[?source=<uuid>]
 *
 * Query values are percent-encoded. The parser is strict (unknown views, keys or values, repeated
 * keys and empty values are rejected) and accepts keys in any order; the formatter writes them in
 * the order above, so `parseAddress(formatView(v))` equals `{ view: v }`.
 */

/** The seven sections of Settings v2 (D17). */
export const settingsSectionIds = [
  "general",
  "ai",
  "knowledge",
  "library",
  "integrations",
  "privacy",
  "advanced"
] as const;
export type SettingsSectionId = (typeof settingsSectionIds)[number];

/** The columns `library.rows` sorts by. */
export const librarySorts = ["title", "added", "updated", "notes", "status"] as const;
export type LibrarySort = (typeof librarySorts)[number];
/** The five statuses `library.rows` gives a source (`S/ipc-library.ts`). */
export const libraryStatuses = ["processing", "ready", "failed", "needsYou", "storedOnly"] as const;
export type LibraryStatus = (typeof libraryStatuses)[number];
export const libraryTabs = ["sources", "questions"] as const;
export type LibraryTab = (typeof libraryTabs)[number];
export const mapLenses = ["relations", "shape"] as const;
export type MapLens = (typeof mapLenses)[number];

/** What the Library table shows: a text filter, a sort, a status and a topic. */
export interface LibraryQuery {
  text?: string;
  sort?: LibrarySort;
  dir?: "asc" | "desc";
  status?: LibraryStatus;
  /** A topic ID. */
  topic?: string;
}

/** An Ask's scope: an object without an anchor. No scope is the whole library. */
export type AskScope = ObjectAddress;

export type ViewAddress =
  | { view: "home" }
  | { view: "explore" }
  | { view: "library"; tab?: LibraryTab; query?: LibraryQuery }
  | { view: "inbox"; kind?: InboxKind }
  | { view: "map"; lens: MapLens; scope?: ObjectAddress }
  | { view: "settings"; section?: SettingsSectionId; setting?: string }
  | { view: "search"; query: string; kinds?: ObjectKind[] }
  /**
   * `question` is asked at once; `draft` only fills the field (the person reads and sends it), and
   * the two never come together.
   */
  | { view: "ask"; question?: string; draft?: string; scope?: AskScope }
  | { view: "import"; sourceId?: string };
export type ViewName = ViewAddress["view"];

export type ParsedAddress = { object: ObjectAddress } | { view: ViewAddress };

export const routeLimits = {
  /** Longest view address; an Ask question is the longest part. */
  maxAddressLength: 4096,
  /** Longest free text (a search query, a question, a Library filter). */
  maxTextLength: 2000
} as const;

const prefix = "memora://";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settingIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const oneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T =>
  value !== undefined && (values as readonly string[]).includes(value);

/** Reads `k=v&…` into a map, or null when a pair is malformed, empty, repeated or not allowed. */
function readQuery(query: string | null, allowed: readonly string[]): Map<string, string> | null {
  const fields = new Map<string, string>();
  if (query === null) return fields;
  for (const part of query.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    if (!allowed.includes(key) || fields.has(key)) return null;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(separator + 1));
    } catch {
      return null;
    }
    if (value.length === 0) return null;
    fields.set(key, value);
  }
  return fields;
}

const isText = (value: string | undefined): value is string =>
  value !== undefined && value.length <= routeLimits.maxTextLength;

/** A scope is a canonical object address with no anchor. */
function readScope(value: string | undefined): ObjectAddress | null {
  if (value === undefined) return null;
  const address = parseObjectAddress(value);
  return address && !address.anchor ? address : null;
}

/** `kinds=topic,note`: each kind once, in any order; they come back in the domain's order. */
function readKinds(value: string | undefined): ObjectKind[] | null {
  if (value === undefined) return null;
  const parts = value.split(",");
  if (new Set(parts).size !== parts.length) return null;
  if (!parts.every((part) => oneOf(objectKinds, part))) return null;
  return objectKinds.filter((kind) => parts.includes(kind));
}

function readLibrary(fields: Map<string, string>): ViewAddress | null {
  const view: { view: "library"; tab?: LibraryTab; query?: LibraryQuery } = { view: "library" };
  const tab = fields.get("tab");
  if (tab !== undefined) {
    if (!oneOf(libraryTabs, tab)) return null;
    view.tab = tab;
  }
  const query: LibraryQuery = {};
  const q = fields.get("q");
  if (q !== undefined) {
    if (!isText(q)) return null;
    query.text = q;
  }
  const sort = fields.get("sort");
  if (sort !== undefined) {
    if (!oneOf(librarySorts, sort)) return null;
    query.sort = sort;
  }
  const dir = fields.get("dir");
  if (dir !== undefined) {
    if (dir !== "asc" && dir !== "desc") return null;
    query.dir = dir;
  }
  const status = fields.get("status");
  if (status !== undefined) {
    if (!oneOf(libraryStatuses, status)) return null;
    query.status = status;
  }
  const topic = fields.get("topic");
  if (topic !== undefined) {
    if (!uuidPattern.test(topic)) return null;
    query.topic = topic.toLowerCase();
  }
  if (Object.keys(query).length > 0) view.query = query;
  return view;
}

function readView(
  segments: string[],
  query: string | null,
  fragment: string | null
): ViewAddress | null {
  const [name, sub, ...extra] = segments;
  if (extra.length > 0) return null;
  // Only Settings has a fragment (the setting to focus) and only Settings and Map a second segment.
  if (fragment !== null && name !== "settings") return null;
  if (sub !== undefined && name !== "settings" && name !== "map") return null;
  switch (name) {
    case "home":
    case "explore":
      return query === null ? { view: name } : null;
    case "library": {
      const fields = readQuery(query, ["tab", "q", "sort", "dir", "status", "topic"]);
      return fields ? readLibrary(fields) : null;
    }
    case "inbox": {
      const fields = readQuery(query, ["kind"]);
      if (!fields) return null;
      const kind = fields.get("kind");
      if (kind === undefined) return { view: "inbox" };
      return oneOf(inboxKinds, kind) ? { view: "inbox", kind } : null;
    }
    case "map": {
      const fields = readQuery(query, ["scope"]);
      if (!fields || !oneOf(mapLenses, sub)) return null;
      if (!fields.has("scope")) return { view: "map", lens: sub };
      const scope = readScope(fields.get("scope"));
      return scope ? { view: "map", lens: sub, scope } : null;
    }
    case "settings": {
      if (query !== null) return null;
      if (sub === undefined) return fragment === null ? { view: "settings" } : null;
      if (!oneOf(settingsSectionIds, sub)) return null;
      if (fragment === null) return { view: "settings", section: sub };
      return settingIdPattern.test(fragment)
        ? { view: "settings", section: sub, setting: fragment }
        : null;
    }
    case "search": {
      const fields = readQuery(query, ["q", "kinds"]);
      const q = fields?.get("q");
      if (!fields || !isText(q)) return null;
      if (!fields.has("kinds")) return { view: "search", query: q };
      const kinds = readKinds(fields.get("kinds"));
      return kinds ? { view: "search", query: q, kinds } : null;
    }
    case "ask": {
      const fields = readQuery(query, ["q", "draft", "scope"]);
      if (!fields) return null;
      if (fields.has("q") && fields.has("draft")) return null;
      const view: { view: "ask"; question?: string; draft?: string; scope?: AskScope } = {
        view: "ask"
      };
      const q = fields.get("q");
      if (q !== undefined) {
        if (!isText(q)) return null;
        view.question = q;
      }
      const draft = fields.get("draft");
      if (draft !== undefined) {
        if (!isText(draft)) return null;
        view.draft = draft;
      }
      if (fields.has("scope")) {
        const scope = readScope(fields.get("scope"));
        if (!scope) return null;
        view.scope = scope;
      }
      return view;
    }
    case "import": {
      const fields = readQuery(query, ["source"]);
      if (!fields) return null;
      const source = fields.get("source");
      if (source === undefined) return { view: "import" };
      return uuidPattern.test(source) ? { view: "import", sourceId: source.toLowerCase() } : null;
    }
    default:
      return null;
  }
}

/** Reads an object or a view address; null for anything else. */
export function parseAddress(raw: string): ParsedAddress | null {
  const object = parseObjectAddress(raw);
  if (object) return { object };
  if (raw.length > routeLimits.maxAddressLength || !raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const hash = rest.indexOf("#");
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash);
  const fragment = hash === -1 ? null : rest.slice(hash + 1);
  const question = beforeHash.indexOf("?");
  const path = question === -1 ? beforeHash : beforeHash.slice(0, question);
  const query = question === -1 ? null : beforeHash.slice(question + 1);
  const view = readView(path.split("/"), query, fragment);
  return view ? { view } : null;
}

/** The view an address names, or null when it is an object address or not an address. */
export function parseViewAddress(raw: string): ViewAddress | null {
  const parsed = parseAddress(raw);
  return parsed && "view" in parsed ? parsed.view : null;
}

function writeQuery(pairs: [string, string | undefined][]): string {
  const written = pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return written.length > 0 ? `?${written.join("&")}` : "";
}

const scopeText = (scope: ObjectAddress | undefined) =>
  scope ? formatObjectAddress({ kind: scope.kind, id: scope.id }) : undefined;

/** Formats a view canonically; throws on a view the parser would reject, so none is ever written. */
export function formatView(view: ViewAddress): string {
  const written = writeView(view);
  if (!parseViewAddress(written)) throw new TypeError("Invalid view address.");
  return written;
}

function writeView(view: ViewAddress): string {
  switch (view.view) {
    case "home":
    case "explore":
      return `${prefix}${view.view}`;
    case "library":
      return `${prefix}library${writeQuery([
        ["tab", view.tab],
        ["q", view.query?.text],
        ["sort", view.query?.sort],
        ["dir", view.query?.dir],
        ["status", view.query?.status],
        ["topic", view.query?.topic?.toLowerCase()]
      ])}`;
    case "inbox":
      return `${prefix}inbox${writeQuery([["kind", view.kind]])}`;
    case "map":
      return `${prefix}map/${view.lens}${writeQuery([["scope", scopeText(view.scope)]])}`;
    case "settings": {
      if (!view.section) return `${prefix}settings`;
      const base = `${prefix}settings/${view.section}`;
      return view.setting ? `${base}#${view.setting}` : base;
    }
    case "search":
      return `${prefix}search${writeQuery([
        ["q", view.query],
        [
          "kinds",
          view.kinds && view.kinds.length > 0
            ? objectKinds.filter((kind) => view.kinds?.includes(kind)).join(",")
            : undefined
        ]
      ])}`;
    case "ask":
      return `${prefix}ask${writeQuery([
        ["q", view.question],
        ["draft", view.draft],
        ["scope", scopeText(view.scope)]
      ])}`;
    case "import":
      return `${prefix}import${writeQuery([["source", view.sourceId?.toLowerCase()]])}`;
  }
}
