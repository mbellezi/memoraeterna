import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { useStableCallback } from "../../lib/stable-callback";
import type { PanelProps } from "../PanelStack";
import { parseViewAddress } from "../route";
import { AskLauncherController } from "./ask/ask-launcher";
import { askTextState, readAskAddress } from "./ask/ask-scope";
import { AskLauncherView, launcherState } from "./ask/AskLauncherView";

/**
 * The Ask panel (`#ask`, design record §6.4; D14): the view `memora://ask[?q=…][&scope=…]`. With
 * words it asks at once and, as soon as the Question exists (`questions.ask` answers before
 * retrieval starts), replaces itself with `memora://question/<id>`, which streams the answer and
 * is what a reload restores: an `ask` address is an instruction, never a place to come back to.
 * Without words it shows the field, the scope and the recent questions. The scope is a topic or a
 * source; any other object is refused (the Ask tab of the context panel maps a note, an entity or
 * a question to a scope before it opens one).
 */

export const kind = "ask";

export function match(address: string): boolean {
  return parseViewAddress(address)?.view === "ask";
}

/** The panel has no object: the header and the spine say what it is. */
export function title(_summary: unknown, t: Translator): string {
  return t("askPanel.kind");
}

export function Component({ t, address, mode, active, onState, onOpen }: PanelProps) {
  const request = readAskAddress(address);
  const scope = request?.scope ?? { status: "unsupported" as const };
  const [value, setValue] = useState(request?.text ?? "");
  const field = useRef<HTMLTextAreaElement>(null);
  const moveTo = useStableCallback((questionId: string) =>
    onOpen(formatObjectAddress({ kind: "question", id: questionId }), { replace: true })
  );
  const [controller] = useState(
    () =>
      new AskLauncherController({
        api: () => (typeof window === "undefined" ? undefined : window.app?.questions),
        onAsked: moveTo
      })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  const send = useStableCallback(() => {
    if (scope.status !== "ok" || askTextState(value) !== "ok") return;
    controller.ask({ text: value, scope: scope.scope });
  });

  // An address with words is an instruction: ask once, when the panel is on screen.
  const asked = useRef(false);
  useEffect(() => {
    if (!active || asked.current || !request || request.scope.status !== "ok") return;
    if (askTextState(request.text) !== "ok") return;
    asked.current = true;
    controller.ask({ text: request.text, scope: request.scope.scope, key: address });
  }, [active, address, controller, request]);

  // The recent questions are read once, and only for a panel that waits for words.
  useEffect(() => {
    if (active) controller.loadRecents();
  }, [active, controller]);

  // Words that cannot be sent yet put the field in reach.
  useEffect(() => {
    if (active && mode === "full" && !asked.current) field.current?.focus({ preventScroll: true });
  }, [active, mode]);

  const state = launcherState(snapshot, scope);
  useEffect(() => onState(state), [onState, state]);

  return (
    <AskLauncherView
      t={t}
      mode={mode}
      snapshot={snapshot}
      scope={scope}
      value={value}
      inputRef={field}
      onChange={(next) => {
        controller.clearError();
        setValue(next);
      }}
      onSend={send}
      onOpen={onOpen}
    />
  );
}
