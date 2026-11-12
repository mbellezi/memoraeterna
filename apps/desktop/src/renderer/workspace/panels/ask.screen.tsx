import type { ScreenModule } from "../surfaces";
import { Component } from "./ask.panel";
import { askPanelFixtures } from "./ask/ask-fixtures";
import { forgetAsks } from "./ask/ask-session";
import { PanelStackScreen, openedFrom, t } from "./ask/ask-screen-parts";

export const surface = "ask";

/**
 * The Ask panel as the stack draws it: the field with the scope that will be asked and the
 * questions asked recently (success), what to do when nothing was asked yet (empty), the question
 * being sent (loading) and one quiet failure that keeps the words (error). The address carries the
 * words, so the panel asks at once; the screens do not replace it with the Question's page (that is
 * the next screen), so what is shown is the panel after it asked.
 */
export const fixtures: ScreenModule["fixtures"] = {
  success: askPanelFixtures(false),
  empty: askPanelFixtures(true)
};

/** The words come with the address, as Cmd-K's "?" writes them: the panel asks at once. */
const frame = {
  surface,
  address:
    "memora://ask?q=Why%20do%20fermented%20foods%20keep%20longer%20outside%20the%20fridge%3F",
  kind: null,
  kindLabel: t("askPanel.kind"),
  title: t("askPanel.kind"),
  Component
} as const;

export function render() {
  // Each mount is a new window: nothing was asked yet.
  forgetAsks();
  return <PanelStackScreen {...frame} previous={openedFrom} />;
}
