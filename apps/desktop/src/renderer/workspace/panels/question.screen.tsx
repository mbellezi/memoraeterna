import type { ScreenModule } from "../surfaces";
import { Component } from "./question.panel";
import { askFixture, questionFixture, questionPanelFixtures } from "./ask/ask-fixtures";
import { PanelStackScreen, t, useFocusCitation } from "./ask/ask-screen-parts";

export const surface = "question";

/**
 * The Question page as the stack draws it: a stored, answered Question with its chips, its sources
 * list and, below 1280 px, the passage tray. Success is the answer with the second citation in
 * reach (its passage is open in the list or the tray); empty is an answer that found nothing in the
 * library to rest on.
 */
export const fixtures: ScreenModule["fixtures"] = {
  success: questionPanelFixtures(questionFixture("stale")),
  empty: questionPanelFixtures(questionFixture("noGrounding"))
};

const frame = {
  surface,
  address: askFixture.questionAddress,
  kind: "question",
  kindLabel: t("objects.kinds.question"),
  title: "Why do fermented foods keep longer outside the fridge?",
  Component
} as const;

function Screen() {
  useFocusCitation(2);
  return <PanelStackScreen {...frame} />;
}

export function render() {
  return <Screen />;
}
