import type { ScreenModule } from "../surfaces";
import { Component } from "./question.panel";
import {
  askFixture,
  deltaParagraphs,
  questionFixture,
  questionPanelFixtures
} from "./ask/ask-fixtures";
import { PanelStackScreen, deliverEvents, t, useFocusCitation } from "./ask/ask-screen-parts";
import type { QuestionPageViewProps } from "./ask/QuestionPageView";

export const surface = "question-live";

/**
 * The Question page while the Ask writes it (`#ask`, mid-stream): two of three paragraphs are in,
 * the status band says the answer is being written and how many sources it has cited so far, the
 * sources list follows, and the third paragraph is yet to come. The screens tool's fake `window.app`
 * never delivers an event, so this module delivers the two the bus would (the stage and the
 * paragraphs so far). Empty is a Question that is no longer in the library.
 */
export const fixtures: ScreenModule["fixtures"] = {
  success: questionPanelFixtures(questionFixture("running")),
  empty: { ...questionPanelFixtures(questionFixture("running")), "questions.get": null }
};

const frame = {
  surface,
  address: askFixture.questionAddress,
  kind: "question",
  kindLabel: t("objects.kinds.question"),
  title: "Why do fermented foods keep longer outside the fridge?",
  Component
} as const;

/** The stage the page is delivered: the answer is being written. */
const writing: QuestionPageViewProps["snapshot"]["stream"]["stage"] = "answering";

function Screen() {
  useFocusCitation(1);
  return <PanelStackScreen {...frame} />;
}

export function render() {
  deliverEvents({
    "consultation.status": [
      {
        type: "consultation.status",
        requestId: askFixture.requestId,
        questionId: askFixture.questionId,
        stage: writing
      }
    ],
    "consultation.delta": [
      {
        type: "consultation.delta",
        requestId: askFixture.requestId,
        questionId: askFixture.questionId,
        paragraphs: deltaParagraphs(2),
        restart: false
      }
    ]
  });
  return <Screen />;
}
