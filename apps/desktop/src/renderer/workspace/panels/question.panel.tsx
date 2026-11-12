import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatObjectAddress, parseObjectAddress } from "@app/domain";
import type { ObjectSummary } from "@app/domain";

import { useAppEvent } from "../../lib/app-events";
import { useObjectChanged } from "../../lib/object-events";
import { useStableCallback } from "../../lib/stable-callback";
import type { PanelProps } from "../PanelStack";
import { useViewportWidth } from "../use-workspace";
import { AskLauncherController } from "./ask/ask-launcher";
import { shownAnswer } from "./ask/answer-model";
import { QuestionController } from "./ask/question-controller";
import { QuestionPageView } from "./ask/QuestionPageView";
import { questionState } from "./ask/question-state";

/**
 * The Question panel (`#ask`, `#passage`, design record §6.4, D14): `memora://question/<id>`. It
 * reads the stored Question and follows the Ask that is writing it through the bus: paragraphs
 * render as they arrive, the status band names the stage, and when the Ask ends the stored answer
 * replaces the stream. The frame above it draws the path ribbon; this file tells it where the
 * Question sits: no path while the answer is streaming (it comes from the citations, S4), the path
 * `locate(question)` returns once it is done, and a topic-scoped Question keeps its topic's path.
 * Esc stops an Ask that is writing; a hidden panel loads nothing and listens to nothing.
 */

export const kind = "question";

export function match(address: string): boolean {
  return parseObjectAddress(address)?.kind === "question";
}

/** The title is the question's words, as `objects.get` reads them; the kind word comes from the frame. */
export function title(summary: ObjectSummary | null): string {
  return summary?.title ?? "";
}

export function Component({ t, address, mode, active, onState, onPlace, onOpen }: PanelProps) {
  const id = parseObjectAddress(address)?.id ?? null;
  const viewportWidth = useViewportWidth();
  const [controller] = useState(
    () =>
      new QuestionController({
        api: () => (typeof window === "undefined" ? undefined : window.app?.questions)
      })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const openFollowUp = useStableCallback((questionId: string) =>
    onOpen(formatObjectAddress({ kind: "question", id: questionId }))
  );
  const [follow] = useState(
    () =>
      new AskLauncherController({
        api: () => (typeof window === "undefined" ? undefined : window.app?.questions),
        onAsked: openFollowUp
      })
  );
  const followSnapshot = useSyncExternalStore(
    follow.subscribe,
    follow.getSnapshot,
    follow.getSnapshot
  );

  useEffect(() => {
    if (id !== null) controller.show(id, active);
  }, [controller, id, active]);

  // The Ask of this Question speaks on the bus; the Question itself reads again when it changes.
  useAppEvent("consultation.delta", (event) => controller.applyDelta(event), active);
  useAppEvent("consultation.status", (event) => controller.applyStatus(event), active);
  useObjectChanged([address], () => controller.reread(), active);

  const load = id === null ? ({ status: "error" } as const) : snapshot.load;
  const reported = id === null ? "error" : questionState(snapshot);
  useEffect(() => onState(reported), [onState, reported]);

  // Where the Question sits: nowhere while its answer is written, then where its citations put it.
  const place = useMemo(() => {
    if (snapshot.load.status !== "ready") return "placed" as const;
    const { question } = snapshot.load;
    if (question.scope.kind === "topic") return "placed" as const;
    return shownAnswer(question, snapshot.stream).live
      ? ("tentativeQuestion" as const)
      : ("byCitations" as const);
  }, [snapshot]);
  useEffect(() => onPlace({ place }), [onPlace, place]);

  // Esc stops the answer that is being written (a dialog or a menu takes Esc first).
  const writing =
    snapshot.load.status === "ready" && shownAnswer(snapshot.load.question, snapshot.stream).live;
  useEffect(() => {
    if (!active || mode !== "full" || !writing) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      controller.stop();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, mode, writing, controller]);

  return (
    <QuestionPageView
      t={t}
      snapshot={{ ...snapshot, load }}
      mode={mode}
      viewportWidth={viewportWidth}
      onOpen={onOpen}
      onRetry={() => controller.retry()}
      onStop={() => controller.stop()}
      onAskAgain={() => controller.askAgain()}
      followUp={{
        send: followSnapshot.send,
        onEdit: () => follow.clearError(),
        onSend: (text) => {
          if (snapshot.load.status !== "ready") return;
          follow.ask({ text, scope: snapshot.load.question.scope });
        }
      }}
    />
  );
}
