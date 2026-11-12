import { useCallback } from "react";
import { formatObjectAddress, parseObjectAddress, type ObjectSummary } from "@app/domain";

import { TopicPage } from "../../components/topic-page/TopicPage";
import type { OpenableNavigation } from "../../components/WhereIsThis";
import type { PanelProps } from "../PanelStack";
import { useWorkspaceBridge } from "../workspace-bridge";
import { addressForNavigation, frameState } from "./object-open";

/**
 * The Topic panel (design record 6.1; D8, D10, D15): the Topic page inside a panel of the stack.
 * The frame draws the path ribbon (the ancestors) and the header; the page draws the title, the
 * counts, the overview with its citations, the subtopics, the notes and the sources. What it opens
 * (a note, a source, a cited passage with its anchors, another topic) is pushed beside the panel.
 * As the previous panel it draws its compact form: the overview's first lines and its notes, the
 * one that was opened marked.
 */

export const kind = "topic";

export function match(address: string): boolean {
  return parseObjectAddress(address)?.kind === "topic";
}

/** The title is the topic's name, as `objects.get` reads it; the kind word comes from the frame. */
export function title(summary: ObjectSummary | null): string {
  return summary?.title ?? "";
}

export function Component({ t, address, mode, active, onState, onOpen, current }: PanelProps) {
  const id = parseObjectAddress(address)?.id ?? null;
  const bridge = useWorkspaceBridge();
  const report = useCallback(
    (status: "loading" | "error" | "missing" | "ready") => onState(frameState(status)),
    [onState]
  );
  const openNavigation = useCallback(
    (navigation: OpenableNavigation) => {
      const next = addressForNavigation(navigation);
      if (next) onOpen(next);
    },
    [onOpen]
  );
  // A merged topic's page found its successor: the stack holds the current id, not the retired one.
  const redirect = useCallback(
    (topicId: string) =>
      onOpen(formatObjectAddress({ kind: "topic", id: topicId }), { replace: true }),
    [onOpen]
  );
  if (id === null) return null;
  return (
    <TopicPage
      topicId={id}
      active={active}
      t={t}
      embedded
      compact={mode === "compact"}
      current={current}
      onHoist={bridge ? (topicId) => bridge.dispatch({ type: "hoist", topicId }) : undefined}
      onLoadState={report}
      onRedirect={redirect}
      onNavigate={openNavigation}
      onOpenAddress={(next) => onOpen(next)}
    />
  );
}
