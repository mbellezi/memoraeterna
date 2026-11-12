import { useState } from "react";
import { Info, LayoutPanelLeft, Table2 } from "lucide-react";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../../../../components/ui/toggle-group";
import type { BranchModel, BranchScope } from "./branch-model";
import { superNodeRatio } from "./branch-sigma";
import { branchNotices, groupLinks, outsideTopics } from "./table-model";

/**
 * What surrounds the Grafo's canvas and table (design record 7.5): the display switch, the notice of
 * what the read left out, the lines between topic groups and the topics outside the branch.
 */

/** Chooses another branch: what the lens does when the person picks one in its menu. */
export type BranchChoose = (scope: BranchScope) => void;

export type RelationsDisplay = "both" | "table";

/** "Gráfico e tabela | Só tabela": the same switch as the Árvore's, so the two tabs read alike. */
export function DisplayToggle({
  t,
  value,
  onChange,
  disabled = false
}: {
  t: Translator;
  value: RelationsDisplay;
  onChange: (value: RelationsDisplay) => void;
  /** While the branch loads the switch stays, still, so the header does not move. */
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      label={t("map.display.label")}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <ToggleGroupItem value="both">
        <LayoutPanelLeft aria-hidden="true" />
        {t("map.display.both")}
      </ToggleGroupItem>
      <ToggleGroupItem value="table">
        <Table2 aria-hidden="true" />
        {t("map.display.table")}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/**
 * One quiet line for each thing the read left out: notes or relations past its limits, and the
 * heaviest group-to-group lines kept when there are more than it lists. Never a warning: nothing
 * of the person's is lost, the picture is only a part of a large branch.
 */
export function BranchNotices({ t, model }: { t: Translator; model: BranchModel }) {
  const notices = branchNotices(model);
  if (notices.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-1">
      {notices.map((notice) => (
        <p
          key={notice}
          role="note"
          className="m-0 flex max-w-(--measure) items-start gap-2 text-sm text-secondary-foreground"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 [text-wrap:pretty]">
            {t(
              notice === "truncated"
                ? "mapRelationsTable.notice.truncated"
                : "mapRelationsTable.notice.groupLines"
            )}
          </span>
        </p>
      ))}
    </div>
  );
}

const groupLinksShown = 6;

/** A topic's name stays whole on one line while it fits: it moves to the next line, never splits. */
const topicNameClass = "inline-block max-w-full align-bottom";

/**
 * "Entre os tópicos": the lines the canvas draws from far away, one per pair of topic groups, as a
 * list. Only a branch whose canvas has that view (`superNodeRatio`) has the list.
 */
export function GroupLinks({ t, model }: { t: Translator; model: BranchModel }) {
  const [all, setAll] = useState(false);
  if (superNodeRatio(model) === null) return null;
  const links = groupLinks(model);
  if (links.length === 0) return null;
  const shown = all ? links : links.slice(0, groupLinksShown);
  return (
    <section
      aria-label={t("mapRelationsTable.groups.title")}
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 className="m-0 text-sm font-semibold text-foreground">
        {t("mapRelationsTable.groups.title")}
      </h3>
      <p className="m-0 text-xs text-secondary-foreground">{t("mapRelationsTable.groups.body")}</p>
      <ul className="m-0 grid list-none gap-0 p-0">
        {shown.map((link) => (
          <li
            key={link.key}
            className="flex min-w-0 items-baseline justify-between gap-3 border-t border-border px-1 py-1.5 text-sm"
          >
            <span className="min-w-0">
              <span className={topicNameClass}>{link.first}</span>{" "}
              <span className={topicNameClass}>
                <span aria-hidden="true" className="pr-1.5 text-muted-foreground">
                  ↔
                </span>
                <span className="sr-only">{t("mapRelationsTable.groups.and")}</span>
                {link.second}
              </span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-secondary-foreground">
              {link.weight === 1
                ? t("mapRelationsTable.countOne")
                : t("mapRelationsTable.count", { values: { count: link.weight } })}
            </span>
          </li>
        ))}
      </ul>
      {links.length > groupLinksShown ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setAll((value) => !value)}>
            {all
              ? t("mapRelationsTable.groups.fewer")
              : t("mapRelationsTable.groups.all", { values: { count: links.length } })}
          </Button>
        </div>
      ) : null}
      {model.superEdgesCapped ? (
        <p className="m-0 text-xs text-muted-foreground">{t("mapRelationsTable.groups.capped")}</p>
      ) : null}
    </section>
  );
}

/** A topic outside the branch: its title wraps at word boundaries, so a keyboard user reads it whole. */
const outsideTopicClass = cn(
  "flex w-full min-w-0 items-baseline gap-2 rounded-md border border-transparent bg-soft",
  "px-3 py-1.5 text-left text-sm text-foreground outline-offset-[-2px]",
  "hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent"
);

/**
 * "Fora do ramo": the topics the drawn notes connect to that the branch does not hold, most
 * connected first, each a way to see that topic's own branch. The read caps the list; at its cap it
 * says so, since the read does not mark it truncated.
 */
export function OutsideTopics({
  t,
  model,
  onChoose
}: {
  t: Translator;
  model: BranchModel;
  onChoose: BranchChoose;
}) {
  const topics = outsideTopics(model);
  if (topics.length === 0) return null;
  return (
    <section
      aria-label={t("mapRelationsTable.outside.title")}
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 className="m-0 text-sm font-semibold text-foreground">
        {t("mapRelationsTable.outside.title")}
      </h3>
      <p className="m-0 text-xs text-secondary-foreground">{t("mapRelationsTable.outside.body")}</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {topics.map((topic) => (
          <li key={topic.topicId} className="min-w-0">
            <button
              type="button"
              title={t("mapRelationsTable.outside.action", { values: { title: topic.title } })}
              onClick={() => onChoose({ kind: "topic", id: topic.topicId })}
              className={outsideTopicClass}
            >
              <ObjectKindGlyph kind="topic" className="shrink-0 self-center text-object-topic" />
              <span className="min-w-0 flex-1 break-words leading-snug [text-wrap:pretty]">
                {topic.title}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-secondary-foreground">
                {topic.edgeCount === 1
                  ? t("mapRelationsTable.countOne")
                  : t("mapRelationsTable.count", { values: { count: topic.edgeCount } })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {model.outsideCapped ? (
        <p className="m-0 text-xs text-muted-foreground">
          {t("mapRelationsTable.outside.capped", { values: { count: topics.length } })}
        </p>
      ) : null}
    </section>
  );
}
