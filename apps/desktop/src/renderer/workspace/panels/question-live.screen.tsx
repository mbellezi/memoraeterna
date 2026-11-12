import type { ScreenModule } from "../surfaces";
import { Component } from "./question.panel";
import {
  askFixture,
  deltaParagraphs,
  questionFixture,
  questionPanelFixtures
} from "./ask/ask-fixtures";
import { forgetAsks } from "./ask/ask-session";
import {
  PanelStackScreen,
  deliverEvents,
  openedFrom,
  t,
  useFocusCitation
} from "./ask/ask-screen-parts";
import type { QuestionPageViewProps } from "./ask/QuestionPageView";

export const surface = "question-live";

/**
 * The Question page while the Ask writes it (`#ask`, mid-stream): two of three paragraphs are in,
 * the status band says the answer is being written and how many sources it has cited so far, the
 * sources list follows, and the third paragraph is yet to come. The screens tool's fake `window.app`
 * never delivers an event, so this module delivers the two the bus would (the stage and the
 * paragraphs so far). Empty is a Question that is no longer in the library. Error is the route
 * that stops answering after two paragraphs: the stage `failed` arrives, the page keeps what was
 * written and says so once, with a way to ask again and another route to choose.
 */

/** Set by the error mode's own `questions.get`, which the page reads right after this renders. */
let routeFails = false;

export const fixtures: ScreenModule["fixtures"] = {
  success: questionPanelFixtures(questionFixture("running")),
  empty: { ...questionPanelFixtures(questionFixture("running")), "questions.get": null },
  // Only the Question and what its frame reads answer; the Ask itself fails on the bus below.
  error: {
    ...questionPanelFixtures(questionFixture("running")),
    "questions.get": () => {
      routeFails = true;
      return questionFixture("running");
    }
  }
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
  return <PanelStackScreen {...frame} previous={openedFrom} />;
}

/** What a provider answers when it fails: redacted text, never one of the app's own message keys. */
const providerError = "The provider returned an error.";

export function render() {
  // The fake `window.app` answers synchronously inside this call: only the error mode's read
  // says the route fails (loading never answers, success and empty do not set it).
  // Each mount is a new window: no earlier screen's record of what an Ask read.
  forgetAsks();
  routeFails = false;
  void (
    window.app?.questions.get({ id: askFixture.questionId }) as Promise<unknown> | undefined
  )?.catch(() => undefined);
  const failing = routeFails;
  deliverEvents({
    "consultation.status": [
      {
        type: "consultation.status",
        requestId: askFixture.requestId,
        questionId: askFixture.questionId,
        stage: writing
      },
      ...(failing
        ? [
            {
              type: "consultation.status",
              requestId: askFixture.requestId,
              questionId: askFixture.questionId,
              stage: "failed",
              error: providerError
            }
          ]
        : [])
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
