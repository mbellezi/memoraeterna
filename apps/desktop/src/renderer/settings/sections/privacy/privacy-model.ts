import type { AiClassRoutes, AiProviderConfig } from "../../../../shared/ipc";

/**
 * What leaves this Mac, derived from what the setup says (design record 7.6, docs/f5-decisions.md
 * D17): one row per job that can send something, where it runs and what travels when it does. Pure
 * functions over the answers of `ai.classRoutes`, `ai.decisionsStatus`, `ai.listProviders` and the
 * book-lookup setting, so each rule is tested without a screen. The words come from the copy; the
 * model only says which.
 */

export type LeaveJob =
  "embed" | "decide" | "writeFast" | "writeQuality" | "answer" | "judge" | "decisions" | "books";

export type LookupService = "openLibrary" | "googleBooks" | "crossref";

/**
 * Who receives a metadata lookup, by the setting. Books go to the provider chosen (both, one after
 * the other, in "auto"); articles, papers and sections go to Crossref whatever the choice, as long
 * as the lookup is on (main's MetadataEnrichmentService).
 */
export const lookupServices = (source: "auto" | "openLibrary" | "google"): LookupService[] =>
  source === "openLibrary"
    ? ["openLibrary", "crossref"]
    : source === "google"
      ? ["googleBooks", "crossref"]
      : ["openLibrary", "googleBooks", "crossref"];

/** Where a job runs: on this Mac, in the cloud (by the profile or provider named), on the internet, or not at all. */
export type Where =
  | { kind: "local" }
  | { kind: "cloud"; name: string | null }
  | {
      kind: "internet";
      source: "auto" | "openLibrary" | "google";
      /** Every service the lookup can contact with this setting: articles always go to Crossref. */
      services: readonly LookupService[];
    }
  | { kind: "off" }
  | { kind: "noModel" };

export interface LeaveRow {
  job: LeaveJob;
  where: Where;
  /** Something can travel: the job runs off this Mac. */
  leaves: boolean;
}

export interface LeavesInput {
  routes: Pick<AiClassRoutes, "classes" | "judge">;
  decisions: { enabled: boolean; state: "off" | "unavailable_preset" | "ready" | "fallback" };
  /** The book-lookup setting: "auto", "open-library", "google-books" or "off". */
  bookLookup: unknown;
  /**
   * A provider's stored display name to the name the AI section calls its kind in this language: a
   * route that names a provider by its stored name is shown by that name (one name for a provider
   * everywhere). A name not in the map (a profile's own name) is shown as it is.
   */
  providerNames?: ReadonlyMap<string, string>;
}

const classJobs = {
  embed: "embed",
  decide: "decide",
  "write-fast": "writeFast",
  "write-quality": "writeQuality",
  answer: "answer"
} as const satisfies Record<AiClassRoutes["classes"][number]["id"], LeaveJob>;

const routeWhere = (
  route: {
    profileId: string | null;
    remote: boolean;
    profileName: string | null;
    providerName?: string | null;
  },
  providerNames: ReadonlyMap<string, string> | undefined
): Where => {
  if (route.profileId === null) return { kind: "noModel" };
  if (!route.remote) return { kind: "local" };
  const name = route.providerName ?? route.profileName;
  return { kind: "cloud", name: name === null ? null : (providerNames?.get(name) ?? name) };
};

const bookSource = (value: unknown): Extract<Where, { kind: "internet" }>["source"] | null =>
  value === "open-library"
    ? "openLibrary"
    : value === "google-books"
      ? "google"
      : value === "off"
        ? null
        : "auto";

/** The rows of the table, in the order the jobs run in the setup's own list. */
export function leaveRows(input: LeavesInput): LeaveRow[] {
  const rows: LeaveRow[] = [];
  for (const route of input.routes.classes) {
    const job = classJobs[route.id];
    if (job)
      rows.push({
        job,
        where: routeWhere(route, input.providerNames),
        leaves: route.profileId !== null && route.remote
      });
  }
  const judge = routeWhere(input.routes.judge, input.providerNames);
  rows.push({ job: "judge", where: judge, leaves: judge.kind === "cloud" });
  const decisionsOn = input.decisions.enabled && input.decisions.state !== "unavailable_preset";
  rows.push({
    job: "decisions",
    where: decisionsOn ? { kind: "cloud", name: "OpenAI" } : { kind: "off" },
    leaves: decisionsOn
  });
  const books = bookSource(input.bookLookup);
  rows.push({
    job: "books",
    where:
      books === null
        ? { kind: "off" }
        : { kind: "internet", source: books, services: lookupServices(books) },
    leaves: books !== null
  });
  return rows;
}

/**
 * The names of the credentials kept on this Mac, in a stable order, never a value: each provider
 * with a stored secret by its display name, then the OpenAI Decisions key, the Google Books key and the
 * model repository token by the names the caller gives them.
 */
export function credentialNames(input: {
  providers: readonly Pick<AiProviderConfig, "displayName" | "secretConfigured">[];
  decisionsKeyStored: boolean;
  decisionsName: string;
  googleBooksKeyStored: boolean;
  googleBooksName: string;
  repositoryTokenStored: boolean;
  repositoryTokenName: string;
}): string[] {
  return [
    ...input.providers.filter((provider) => provider.secretConfigured).map((p) => p.displayName),
    ...(input.decisionsKeyStored ? [input.decisionsName] : []),
    ...(input.googleBooksKeyStored ? [input.googleBooksName] : []),
    ...(input.repositoryTokenStored ? [input.repositoryTokenName] : [])
  ];
}

/** How many saved questions the count line says, from one page of the list: "more than 50" when it has a next. */
export function questionCount(page: { items: readonly unknown[]; next?: string | undefined }): {
  count: number;
  more: boolean;
} {
  return { count: page.items.length, more: page.next !== undefined };
}
