// How the Inbox words what the stores hold (F4 D29, spec 3.10): the rows of the repository's
// ordered listing become items with a variant, scalar parameters, the objects they name (with their
// titles, never as IDs) and the verbs they offer. Nothing here writes; the service does.
import {
  createChangeSetRepository,
  createGardenerFindingRepository,
  createInboxRepository,
  type GardenerFindingRecord,
  type InboxQuarantineRecord,
  type InboxRelationRecord,
  type InboxRowKey,
  type PgPool
} from "@app/db";
import {
  gardenerTaskKind,
  inboxVariants,
  parseObjectAddress,
  type ChangeSetKind,
  type ChangeSetSummary,
  type InboxItem,
  type InboxKind,
  type InboxObject,
  type InboxVerb
} from "@app/domain";

type Title = InboxObject["title"];

/** The Obsidian conflicts the sync service lists, in the shape the Inbox merges. */
export interface ObsidianConflictRecord {
  /** The conflict's own ID (a projection revision or an editorial operation). */
  id: string;
  /** The vault path of the file. */
  path: string;
  variant: "editorial" | "deleted" | "projection";
  /** When it arose; null: the Inbox reads it from the operation or revision row. */
  at: Date | null;
}

const changeSetKinds = new Set<string>(["topic", "relation", "overview"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The change-set a `review` ID names: `<store>:<uuid>`. */
export function parseChangeSetItemId(id: string): { kind: ChangeSetKind; id: string } | null {
  const [kind, uuid, extra] = id.split(":");
  if (extra !== undefined || !kind || !uuid) return null;
  if (!changeSetKinds.has(kind) || !uuidPattern.test(uuid)) return null;
  return { kind: kind as ChangeSetKind, id: uuid.toLowerCase() };
}

/** The subject a `quarantined` ID names: `<task kind>|<subject key>`. */
export function parseQuarantineItemId(id: string): { kind: string; subjectKey: string } | null {
  const bar = id.indexOf("|");
  if (bar <= 0 || bar === id.length - 1) return null;
  return { kind: id.slice(0, bar), subjectKey: id.slice(bar + 1) };
}

export const isUuid = (value: string): boolean => uuidPattern.test(value);

/** The object a quarantined subject key (`note:`, `topic:`, `root:` + ID) names, else null. */
function subjectObject(subjectKey: string): { kind: InboxObject["kind"]; id: string } | null {
  const colon = subjectKey.indexOf(":");
  if (colon <= 0) return null;
  const prefix = subjectKey.slice(0, colon);
  const id = subjectKey.slice(colon + 1);
  if (!isUuid(id)) return null;
  if (prefix === "note") return { kind: "note", id: id.toLowerCase() };
  if (prefix === "topic") return { kind: "topic", id: id.toLowerCase() };
  if (prefix === "root") return { kind: "source", id: id.toLowerCase() };
  return null;
}

const quarantineTasks: readonly string[] = inboxVariants.quarantined;

/** The task a quarantined kind belongs to, as one of the variants the interface words. */
export function quarantineVariant(kind: string): string {
  const task = gardenerTaskKind(kind)?.task ?? "other";
  return quarantineTasks.includes(task) ? task : "other";
}

const pickVariant = <K extends InboxKind>(kind: K, wanted: unknown, fallback: string): string => {
  const variants: readonly string[] = inboxVariants[kind];
  return typeof wanted === "string" && variants.includes(wanted) ? wanted : fallback;
};

/** The note an address names (`memora://note/<id>`), else null. */
function noteAddress(address: string): string | null {
  const parsed = parseObjectAddress(address);
  return parsed?.kind === "note" ? parsed.id : null;
}

const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;

/** A finding's parameters kept to the scalars the interface needs. */
function findingParams(
  finding: GardenerFindingRecord,
  names: readonly string[]
): Record<string, string | number | boolean | null> {
  const params: Record<string, string | number | boolean | null> = {};
  for (const name of names) {
    const value = scalar(finding.params[name]);
    if (value !== null) params[name] = value;
  }
  return params;
}

/** The kind of budget item a finding's fingerprint (`money_80:<month>`) names. */
export function budgetVariant(fingerprint: string): string {
  return pickVariant("budget", fingerprint.split(":")[0], "money_80");
}

interface Lookups {
  titles: Map<string, Title>;
  summaries: Map<string, ChangeSetSummary>;
  quarantined: Map<string, InboxQuarantineRecord>;
  relations: Map<string, InboxRelationRecord>;
  findings: Map<string, GardenerFindingRecord>;
}

const object = (lookups: Lookups, kind: InboxObject["kind"], id: string): InboxObject => ({
  kind,
  id,
  title: lookups.titles.get(`${kind}:${id}`) ?? null
});

function reviewItem(row: InboxRowKey, lookups: Lookups): InboxItem | null {
  const ref = parseChangeSetItemId(row.id);
  const summary = ref ? lookups.summaries.get(`${ref.kind}:${ref.id}`) : undefined;
  if (!ref || !summary || summary.status !== "pending_review") return null;
  // What the change-set changed, when that is one object: a topic's overview, a pass's source.
  const subject =
    summary.subjectId === null
      ? null
      : summary.kind === "overview"
        ? object(lookups, "topic", summary.subjectId)
        : summary.kind === "relation"
          ? object(lookups, "source", summary.subjectId)
          : null;
  return {
    kind: "review",
    id: row.id,
    risk: row.risk,
    variant: summary.kind,
    at: row.at,
    params: {},
    objects: subject ? [subject] : [],
    changeSet: summary,
    actions: ["apply", "dismiss"]
  };
}

function quarantinedItem(row: InboxRowKey, lookups: Lookups): InboxItem | null {
  const record = lookups.quarantined.get(row.id);
  if (!record) return null;
  const subject = subjectObject(record.subjectKey);
  const actions: InboxVerb[] = record.lastJobId ? ["retry", "dismiss"] : ["dismiss"];
  return {
    kind: "quarantined",
    id: row.id,
    risk: row.risk,
    variant: quarantineVariant(record.kind),
    at: row.at,
    params: { errorClass: record.errorClass, failures: record.failures },
    objects: subject ? [object(lookups, subject.kind, subject.id)] : [],
    changeSet: null,
    actions
  };
}

function relationItem(row: InboxRowKey, lookups: Lookups): InboxItem | null {
  const relation = lookups.relations.get(row.id);
  if (!relation) return null;
  const withdrawn = row.kind === "withdrawn";
  return {
    kind: row.kind,
    id: row.id,
    risk: row.risk,
    variant: withdrawn ? pickVariant("withdrawn", relation.vetoSource, "unknown") : "relation",
    at: row.at,
    params: { relationType: relation.relationType },
    objects: [
      { kind: "note", id: relation.sourceNote.id, title: relation.sourceNote.title },
      { kind: "note", id: relation.targetNote.id, title: relation.targetNote.title }
    ],
    changeSet: null,
    actions: ["apply", "dismiss"]
  };
}

function findingItem(row: InboxRowKey, lookups: Lookups): InboxItem | null {
  const finding = lookups.findings.get(row.id);
  if (!finding || finding.status !== "open") return null;
  const base = { id: row.id, risk: row.risk, at: row.at, changeSet: null } as const;
  if (row.kind === "duplicate") {
    const notes = finding.objectRefs.flatMap((address) => noteAddress(address) ?? []);
    return {
      ...base,
      kind: "duplicate",
      variant: pickVariant("duplicate", finding.params.reason, "both"),
      params: findingParams(finding, ["cosine"]),
      objects: notes.slice(0, 2).map((id) => object(lookups, "note", id)),
      actions: ["dismiss"]
    };
  }
  if (row.kind === "backlog") {
    const variant = pickVariant("backlog", finding.params.task, "other");
    return {
      ...base,
      kind: "backlog",
      variant,
      params: findingParams(finding, ["notes"]),
      objects: [],
      actions: variant === "match" ? ["apply", "dismiss"] : ["dismiss"]
    };
  }
  if (row.kind === "budget") {
    const variant = budgetVariant(finding.fingerprint);
    return {
      ...base,
      kind: "budget",
      variant,
      params: findingParams(finding, ["month", "spentUsd", "capUsd"]),
      objects: [],
      actions: variant === "money_80" ? ["apply", "dismiss"] : ["dismiss"]
    };
  }
  return null;
}

/** An Obsidian conflict as an item: medium risk, nothing to do here but open it where it is solved. */
export function obsidianItem(record: ObsidianConflictRecord, at: string): InboxItem {
  return {
    kind: "obsidian_conflict",
    id: `${record.variant === "projection" ? "projection" : "editorial"}:${record.id}`,
    risk: "medium",
    variant: record.variant,
    at,
    params: { path: record.path.slice(0, 300) },
    objects: [],
    changeSet: null,
    actions: []
  };
}

/**
 * Items for these rows, in their order: the change-set summaries, quarantine records, relations,
 * findings and titles each read once for the whole page. A row whose subject is gone or no longer
 * open (it changed between the listing and this read) is left out.
 */
export async function inboxItems(pool: PgPool, rows: readonly InboxRowKey[]): Promise<InboxItem[]> {
  const inbox = createInboxRepository(pool);
  const ofKind = (...kinds: InboxKind[]) => rows.filter((row) => kinds.includes(row.kind));

  const changeRefs = ofKind("review").flatMap((row) => parseChangeSetItemId(row.id) ?? []);
  const subjects = ofKind("quarantined").flatMap((row) => parseQuarantineItemId(row.id) ?? []);
  const relationIds = ofKind("contradiction", "withdrawn").map((row) => row.id);
  const findingRows = ofKind("duplicate", "backlog", "budget");
  const findings = createGardenerFindingRepository(pool);

  const [summaries, quarantined, relations, findingRecords] = await Promise.all([
    createChangeSetRepository(pool).getMany(changeRefs),
    inbox.quarantined(subjects),
    inbox.relations(relationIds),
    Promise.all(findingRows.map((row) => findings.get(row.id)))
  ]);

  const lookups: Lookups = {
    titles: new Map(),
    summaries: new Map(summaries.map((summary) => [`${summary.kind}:${summary.id}`, summary])),
    quarantined: new Map(
      quarantined.map((record) => [`${record.kind}|${record.subjectKey}`, record])
    ),
    relations: new Map(relations.map((relation) => [relation.id, relation])),
    findings: new Map(
      findingRecords.flatMap((record) => (record ? [[record.id, record] as const] : []))
    )
  };

  const notes = new Set<string>();
  const sources = new Set<string>();
  const topics = new Set<string>();
  for (const summary of summaries) {
    if (summary.subjectId === null) continue;
    if (summary.kind === "overview") topics.add(summary.subjectId);
    if (summary.kind === "relation") sources.add(summary.subjectId);
  }
  for (const record of quarantined) {
    const subject = subjectObject(record.subjectKey);
    if (subject?.kind === "note") notes.add(subject.id);
    if (subject?.kind === "topic") topics.add(subject.id);
    if (subject?.kind === "source") sources.add(subject.id);
  }
  for (const record of findingRecords)
    for (const address of record?.objectRefs ?? []) {
      const id = noteAddress(address);
      if (id) notes.add(id);
    }
  lookups.titles = await inbox.titles({
    notes: [...notes],
    sources: [...sources],
    topics: [...topics]
  });

  const items: InboxItem[] = [];
  for (const row of rows) {
    const item =
      row.kind === "review"
        ? reviewItem(row, lookups)
        : row.kind === "quarantined"
          ? quarantinedItem(row, lookups)
          : row.kind === "contradiction" || row.kind === "withdrawn"
            ? relationItem(row, lookups)
            : findingItem(row, lookups);
    if (item) items.push(item);
  }
  return items;
}
