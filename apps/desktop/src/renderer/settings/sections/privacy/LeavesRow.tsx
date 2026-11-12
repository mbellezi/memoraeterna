import { useMemo, type ReactNode } from "react";
import { Cloud, CircleDashed, Globe } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { SolidCheck } from "../../../components/ui/solid-glyphs";
import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { settingsTouch } from "../../../lib/status-followers";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { requestSettingsTarget } from "../../settings-target";
import { labelOf } from "../../settings-model";
import { providerEntryId, providerKinds } from "../ai/ai-model";
import { useSectionRead } from "../general/use-section-read";
import { credentialNames, leaveRows, type LeaveJob, type Where } from "./privacy-model";

/** The job's name: the same words as its route in AI, so a job is called one thing everywhere. */
const jobName = (t: Translator, job: LeaveJob): string => {
  switch (job) {
    case "embed":
      return t("settingsRegistry.aiRouteEmbed.label");
    case "decide":
      return t("settingsRegistry.aiRouteDecide.label");
    case "writeFast":
      return t("settingsRegistry.aiRouteWriteFast.label");
    case "writeQuality":
      return t("settingsRegistry.aiRouteWriteQuality.label");
    case "answer":
      return t("settingsRegistry.aiRouteAnswer.label");
    case "judge":
      return t("settingsRegistry.aiRouteJudge.label");
    case "decisions":
      return t("settingsPrivacy.leaves.decisions");
    case "books":
      return t("settingsPrivacy.leaves.books");
  }
};

const whatLeaves = (t: Translator, job: LeaveJob): string =>
  t(`settingsPrivacy.leaves.what.${job}`);

/**
 * Where a job runs: the place in one word and, under it in a quieter line, the service (the model
 * provider, or the book services) when it runs off this Mac. The service's name can be long, so it
 * has its own line instead of pushing the table wider than the window.
 */
function whereCell(t: Translator, where: Where): ReactNode {
  const word = (glyph: ReactNode, text: string, detail?: string) => (
    <span className="inline-flex items-start gap-1.5">
      <span className="mt-0.5 flex shrink-0 text-muted-foreground [&>svg]:size-3.5">{glyph}</span>
      <span>
        {text}
        {detail ? (
          <>
            <span className="sr-only"> · </span>
            <span className="block text-xs text-secondary-foreground [text-wrap:pretty]">
              {detail}
            </span>
          </>
        ) : null}
      </span>
    </span>
  );
  switch (where.kind) {
    case "local":
      return word(
        <SolidCheck className="size-3.5 text-success" />,
        t("settingsPrivacy.leaves.local")
      );
    case "cloud":
      return word(
        <Cloud aria-hidden="true" />,
        t("settingsPrivacy.leaves.cloud"),
        where.name ?? undefined
      );
    case "internet":
      return word(
        <Globe aria-hidden="true" />,
        t("settingsPrivacy.leaves.internet"),
        t(
          where.source === "auto"
            ? "settingsPrivacy.leaves.lookupAuto"
            : where.source === "google"
              ? "settingsPrivacy.leaves.lookupGoogle"
              : "settingsPrivacy.leaves.lookupOpenLibrary"
        )
      );
    case "off":
      return word(<CircleDashed aria-hidden="true" />, t("settingsPrivacy.leaves.off"));
    case "noModel":
      return word(<CircleDashed aria-hidden="true" />, t("settingsPrivacy.leaves.noModel"));
  }
}

/** The stored display name of each provider to the name its kind has in the AI section. */
function providerNamesOf(
  t: Translator,
  providers: readonly { provider: string; displayName: string }[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const provider of providers) {
    const kind = providerKinds.find((candidate) => candidate === provider.provider);
    const entry = kind
      ? settingsRegistryV2.find((candidate) => candidate.id === providerEntryId(kind))
      : undefined;
    if (entry) names.set(provider.displayName, labelOf(t, entry));
  }
  return names;
}

interface LeavesRead {
  routes: Awaited<ReturnType<typeof window.app.ai.classRoutes>>;
  decisions: Awaited<ReturnType<typeof window.app.ai.decisionsStatus>>;
  providers: Awaited<ReturnType<typeof window.app.ai.listProviders>>;
  googleBooksKeyStored: boolean;
}

/**
 * What leaves this Mac, by job: where each one runs with the current setup and, only when it runs off
 * this Mac, what travels. A job on this Mac, off, or without a model says "Nothing". Below the table
 * are the names of the credentials kept here (the values never reach this screen) and a link to AI,
 * where they change. Read once from the routes, the OpenAI Decisions status, the providers and the
 * Google Books key, and again when the AI or app settings change; the book lookup comes from
 * `settings.describe`, so the rows are worked out when drawn.
 */
export function LeavesRow({ entry }: { entry: SettingEntryV2 }) {
  const { t, describe } = useSettings();
  const bookLookup = describe("bookLookup")?.value;
  const repositoryTokenStored = describe("local-models.repository-token-ref")?.value === true;
  const { state, retry } = useSectionRead<LeavesRead>(async () => {
    const [routes, decisions, providers, googleBooks] = await Promise.all([
      window.app.ai.classRoutes(),
      window.app.ai.decisionsStatus(),
      window.app.ai.listProviders(),
      window.app.settings.getGoogleBooksKeyStatus()
    ]);
    return { routes, decisions, providers, googleBooksKeyStored: googleBooks.configured };
  }, [{ type: "settings.changed", when: settingsTouch("ai", "app") }]);
  // A provider is named as the AI section names its kind (the registry's label), in this language.
  const providerNames = useMemo(
    () =>
      state.status === "ready"
        ? providerNamesOf(t, state.value.providers)
        : new Map<string, string>(),
    [state, t]
  );
  const rows = useMemo(
    () =>
      state.status === "ready"
        ? leaveRows({
            routes: state.value.routes,
            decisions: state.value.decisions,
            bookLookup,
            providerNames
          })
        : [],
    [state, bookLookup, providerNames]
  );
  const credentials =
    state.status === "ready"
      ? credentialNames({
          providers: state.value.providers.map((provider) => ({
            ...provider,
            displayName: providerNames.get(provider.displayName) ?? provider.displayName
          })),
          decisionsKeyStored: state.value.decisions.keyStored,
          decisionsName: t("settingsPrivacy.leaves.decisions"),
          googleBooksKeyStored: state.value.googleBooksKeyStored,
          googleBooksName: t("settingsPrivacy.leaves.booksGoogle"),
          repositoryTokenStored,
          repositoryTokenName: t("settingsRegistry.localModelsRepositoryTokenRef.label")
        })
      : [];

  const body =
    state.status === "loading" ? (
      <LoadingState t={t} className="w-full">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[30%_36%_1fr] gap-4 border-b border-border py-3"
          >
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </LoadingState>
    ) : state.status === "error" ? (
      <ErrorState
        t={t}
        message={t("settingsPrivacy.leaves.readFailed")}
        kept={t("settingsPrivacy.leaves.readKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={retry}
      />
    ) : (
      <div className="w-full">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <caption className="sr-only">{t("settingsPrivacy.leaves.tableLabel")}</caption>
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[38%]" />
            <col />
          </colgroup>
          <thead>
            <tr className="text-xs text-secondary-foreground">
              {(["job", "where", "what"] as const).map((column) => (
                <th key={column} scope="col" className="pb-2 pr-4 font-medium last:pr-0">
                  {t(`settingsPrivacy.leaves.columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.job} className="border-t border-border align-top">
                <th scope="row" className="py-2.5 pr-4 text-left font-normal text-foreground">
                  {jobName(t, row.job)}
                </th>
                <td className="py-2.5 pr-4 text-foreground">{whereCell(t, row.where)}</td>
                <td
                  className={`py-2.5 [text-wrap:pretty] ${row.leaves ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {row.leaves ? whatLeaves(t, row.job) : t("settingsPrivacy.leaves.nothing")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="m-0 mt-3 max-w-[34rem] text-xs text-secondary-foreground [text-wrap:pretty]">
          {credentials.length > 0
            ? t("settingsPrivacy.leaves.credentials", { values: { names: credentials.join(", ") } })
            : t("settingsPrivacy.leaves.noCredentials")}{" "}
          <InlineAction size="xs" onClick={() => requestSettingsTarget({ section: "ai" })}>
            {t("settingsPrivacy.leaves.changeInAi")}
          </InlineAction>
        </p>
      </div>
    );

  return <RegistryRow entry={entry} stack control={body} />;
}
