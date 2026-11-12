// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../test-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import type { QuestionView } from "../../../../shared/ipc-questions";
import { applyDelta, applyStatus, emptyStream, streamFor, type StreamState } from "./answer-model";
import {
  askFixture,
  citationAddresses,
  readFixture,
  deltaParagraphs,
  questionFixture,
  questionPanelFixtures
} from "./ask-fixtures";
import { enterSends } from "./AskComposer";
import { forgetAsks, rememberRead } from "./ask-session";
import type { QuestionSnapshot } from "./question-controller";
import { questionState } from "./question-state";
import { QuestionPageView, trayBelow, type QuestionPageViewProps } from "./QuestionPageView";

const en = createTranslator("en");
const request = askFixture.requestId;

let dom: TestDom;
const opened: string[] = [];
const sends: string[] = [];
const calls = { stop: 0, again: 0, retry: 0 };

const snapshot = (
  question: QuestionView | null,
  stream: StreamState = emptyStream,
  load: QuestionSnapshot["load"] | null = null
): QuestionSnapshot => ({
  load: load ?? (question ? { status: "ready", question } : { status: "missing" }),
  stream,
  action: "idle"
});

const props = (
  value: QuestionSnapshot,
  overrides: Partial<QuestionPageViewProps> = {}
): QuestionPageViewProps => ({
  t: en,
  snapshot: value,
  mode: "full",
  viewportWidth: 1440,
  onOpen: (address) => void opened.push(address),
  onRetry: () => void (calls.retry += 1),
  onStop: () => void (calls.stop += 1),
  onAskAgain: () => void (calls.again += 1),
  followUp: {
    send: { status: "idle" },
    onSend: (text) => void sends.push(text),
    onEdit: () => undefined
  },
  ...overrides
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = () => dom.act(() => sleep(60));
const chip = (number: number) =>
  dom.document.querySelector(`[data-citation="${number}"]`) as HTMLElement;
const entry = (number: number) =>
  dom.document.querySelector(`[data-source-entry="${number}"]`) as HTMLElement;
const tray = () => dom.document.querySelector("[data-passage-tray]");
const hover = (target: Element) =>
  dom.act(() => {
    target.dispatchEvent(new dom.window.Event("mouseover", { bubbles: true }));
  });

beforeEach(() => {
  opened.length = 0;
  sends.length = 0;
  calls.stop = calls.again = calls.retry = 0;
  dom = createTestDom();
  const fixtures = questionPanelFixtures(questionFixture("done"));
  (dom.window as unknown as { app: unknown }).app = {
    objects: {
      resolveMany: (input: never) => Promise.resolve(fixtures["objects.resolveMany"](input))
    },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const done = () => snapshot(questionFixture("done"));

describe("citation chips, in the DOM", () => {
  it("expands the passage in the sources list when a chip is hovered, and covers nothing", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    expect(entry(2).hasAttribute("data-active")).toBe(false);
    expect(dom.document.querySelector("mark")).toBeNull();
    await hover(chip(2));
    expect(chip(2).hasAttribute("data-active")).toBe(true);
    expect(entry(2).hasAttribute("data-active")).toBe(true);
    // The passage and the cited sentence, read in the list.
    expect(entry(2).querySelector("mark")?.textContent).toContain("fills the space");
    expect(entry(2).textContent).toContain("Open the passage beside");
    // One entry is open at a time, and no card is drawn over the answer.
    expect(entry(1).hasAttribute("data-active")).toBe(false);
    expect(dom.document.querySelector('[data-surface="object-card"]')).toBeNull();
    expect(dom.document.querySelector("[data-answer-paragraph] mark")).toBeNull();
  });

  it("expands it on keyboard focus too", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    dom.focus(chip(3));
    await settle();
    expect(entry(3).hasAttribute("data-active")).toBe(true);
  });

  it("opens the cited passage beside the question on a click, at its anchor", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    await dom.act(() => chip(1).click());
    expect(opened).toEqual([citationAddresses[0]]);
    await dom.act(() => entry(3).click());
    expect(opened.at(-1)).toBe(citationAddresses[2]);
  });

  it("reads the passage in a tray at the foot below 1280 px, and in no tray from 1280 px", async () => {
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow - 1 })} />);
    await settle();
    // Nothing to read yet: the sources heading says how to reach a passage.
    expect(tray()).toBeNull();
    expect(dom.document.body.textContent).toContain("Hover or focus a citation");
    await hover(chip(1));
    await settle();
    const text = tray()?.textContent ?? "";
    expect(text).toContain("Citation 1");
    expect(text).toContain("Food microbiology, ch. 3");
    expect(text).toContain("Lactic acid bacteria lower the pH");
    expect(text).toContain("Open the passage beside");
    // One wording and one keycap position for the tray and for an expanded entry.
    expect(tray()?.querySelector("kbd")?.previousSibling?.textContent).toContain(
      "Open the passage beside"
    );
    // The list marks the entry but stays closed: one passage is never drawn twice.
    expect(entry(1).hasAttribute("data-active")).toBe(true);
    expect(entry(1).querySelector("mark")).toBeNull();
    expect(entry(1).textContent).not.toContain("Open the passage beside");
    expect(dom.document.querySelectorAll("mark")).toHaveLength(1);
  });

  it("keeps the tray on the answer's measure, with the edge still full width", async () => {
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow - 1 })} />);
    await settle();
    await hover(chip(1));
    await settle();
    const inner = tray()?.firstElementChild as HTMLElement;
    expect(inner.className).toContain("max-w-(--measure)");
  });

  it("counts the passages and the sources the answer cites, under the heading", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    const heading = dom.document.querySelector("section h2")?.textContent ?? "";
    expect(heading.replaceAll("\u00a0", " ")).toContain("3 passages cited · 2 sources");
  });

  it("writes the scope and what was read in the sources heading, and lists what was read and not cited", async () => {
    forgetAsks();
    rememberRead(askFixture.questionId, readFixture);
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    const heading = dom.document.querySelector("section h2")?.textContent ?? "";
    expect(heading).toContain("Scope: whole library · 5 passages read from 3 sources");
    const group = dom.document.querySelector('[role="group"]') as HTMLElement;
    expect(group.querySelector("h3")?.textContent).toBe("Read, not cited (2)");
    const rows = group.querySelectorAll("[data-read-not-cited]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Home canning basics");
    expect(rows[0]?.textContent).toContain("had nothing about keeping fermented food");
    // The second is another passage of a source the answer cites (3), and the Ask gave no reason:
    // the row says which passage it is and never that the source had nothing on the question.
    expect(rows[1]?.textContent).toContain("Kefir and kombucha at home");
    expect(rows[1]?.textContent).toContain("Another passage of source 3");
    expect(rows[1]?.textContent).not.toContain("did not bear");
    expect(rows[1]?.textContent).not.toContain("nothing");
    await dom.act(() => (rows[0] as HTMLElement).click());
    expect(opened).toEqual([readFixture.notCited[0]?.address]);
    forgetAsks();
  });

  it("lists only what the answer does not cite, and says a passage no more than the app knows", async () => {
    forgetAsks();
    const [first, second] = citationAddresses as [string, string, string];
    const bare = (address: string) => address.split("&span=")[0] as string;
    rememberRead(askFixture.questionId, {
      passages: 6,
      sources: 3,
      notCited: [
        // A passage the answer cites, read with or without its span: never "not cited".
        { address: bare(first), reason: "had nothing about this question" },
        { address: second },
        ...readFixture.notCited.slice(0, 1).map(({ address }) => ({ address })),
        ...readFixture.notCited.slice(1)
      ]
    });
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    const group = dom.document.querySelector('[role="group"]') as HTMLElement;
    expect(group.querySelector("h3")?.textContent).toBe("Read, not cited (2)");
    const rows = [...group.querySelectorAll("[data-read-not-cited]")];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Home canning basics"),
      expect.stringContaining("Kefir and kombucha at home")
    ]);
    // A source the answer does not cite at all: only that the answer did not use it.
    expect(rows[0]?.textContent).toContain("not used in the answer");
    expect(group.textContent).not.toContain("had nothing about this question");
    expect(group.textContent).not.toContain("nothing on");
    forgetAsks();
  });

  it("shows no group at all when every read passage is cited", async () => {
    forgetAsks();
    rememberRead(askFixture.questionId, {
      passages: 3,
      sources: 2,
      notCited: [{ address: citationAddresses[0] as string }]
    });
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    expect(dom.document.querySelector('[role="group"]')).toBeNull();
    forgetAsks();
  });

  it("shows no group when the Ask kept nothing of what it read, and not while it writes", async () => {
    forgetAsks();
    await dom.render(<QuestionPageView {...props(done())} />);
    expect(dom.document.querySelector('[role="group"]')).toBeNull();
    forgetAsks();
    rememberRead(askFixture.questionId, readFixture);
    const running = applyDelta(streamFor(request), {
      requestId: request,
      paragraphs: deltaParagraphs(2),
      restart: false
    });
    await dom.render(
      <QuestionPageView {...props(snapshot(questionFixture("running"), running))} />
    );
    expect(dom.document.querySelector('[role="group"]')).toBeNull();
    forgetAsks();
  });

  it("places the sources list in a column beside the answer from 1280 px, where the panel is wide enough", async () => {
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow })} />);
    await settle();
    const section = dom.document.querySelector("section") as HTMLElement;
    expect(section.className).toContain("@[58rem]:col-start-2");
    expect(dom.document.querySelector("article")?.className).toContain("@[58rem]:grid-cols-");
    // Below 1280 px the list follows the answer in one column, and the tray reads the passages.
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow - 1 })} />);
    await settle();
    expect(dom.document.querySelector("section")?.className).not.toContain("col-start-2");
    expect(dom.document.querySelector("article")?.className).not.toContain("@[58rem]");
  });

  it("keeps every focusable row of the sources list clear of the tray below 1280 px", async () => {
    forgetAsks();
    rememberRead(askFixture.questionId, readFixture);
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow - 1 })} />);
    await settle();
    await hover(chip(1));
    await settle();
    // The tray is at most 8rem tall (`max-h-32`): a focused row scrolls 9rem clear of the foot.
    expect(tray()?.className).toContain("max-h-32");
    const rows = [
      ...dom.document.querySelectorAll("[data-source-entry], [data-read-not-cited]")
    ] as HTMLElement[];
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.className.split(" ")).toContain("scroll-mb-36");
    // The follow-up field and every other control of the page keep the same clearance.
    expect(dom.document.querySelector("article")?.className).toContain(
      "[&_:is(textarea,button,a)]:scroll-mb-36"
    );
    // With no tray (1280 px and up) nothing needs the margin.
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow })} />);
    await settle();
    expect(dom.document.querySelectorAll("[data-source-entry].scroll-mb-36")).toHaveLength(0);
    expect(dom.document.querySelectorAll("[data-read-not-cited].scroll-mb-36")).toHaveLength(0);
    forgetAsks();
  });

  it("clamps an idle passage to one line and draws the active one only in the tray below 1280", async () => {
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: 960 })} />);
    await settle();
    await hover(chip(2));
    await settle();
    const idle = entry(1).querySelector(".font-reading");
    // `block` would undo the clamp's own display.
    expect(idle?.className).toContain("line-clamp-1");
    expect(idle?.className.split(" ")).not.toContain("block");
    // The active entry shows no passage: its text lives in the tray alone.
    expect(entry(2).querySelector(".font-reading")).toBeNull();
    expect(tray()?.textContent).toContain("fills the space");
  });

  it("offers another route after a route failure, in Settings", async () => {
    const failed = applyStatus(streamFor(request), {
      requestId: request,
      stage: "failed",
      error: "The provider returned an error."
    });
    const view = snapshot(questionFixture("running"), failed);
    expect(questionState(view)).toBe("error");
    await dom.render(<QuestionPageView {...props(view)} />);
    expect(dom.document.body.textContent).toContain("The AI route did not answer.");
    const other = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Use another route"
    ) as HTMLElement;
    // The retry and the other route sit on one row.
    const retry = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Retry"
    ) as HTMLElement;
    expect(retry.parentElement).toBe(other.parentElement);
    await dom.act(() => other.click());
    expect(opened).toEqual(["memora://settings/ai"]);
  });

  it("gives every chip the same lead and puts no margin after it", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    const classes = [1, 2, 3].map((number) => chip(number).className);
    expect(
      new Set(classes.map((value) => value.replace(/border-\S+|bg-\S+|text-\S+/g, ""))).size
    ).toBe(1);
    expect(classes.join(" ")).not.toContain("mx-px");
  });

  it("puts a caret after the last paragraph only while the answer is written", async () => {
    const stream = applyStatus(
      applyDelta(emptyStream, {
        requestId: request,
        paragraphs: deltaParagraphs(2),
        restart: false
      }),
      { requestId: request, stage: "answering" }
    );
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("running"), stream))} />);
    const carets = dom.document.querySelectorAll("[data-answer-caret]");
    expect(carets).toHaveLength(1);
    expect(carets[0]?.closest("p")).toBe(
      dom.document.querySelectorAll("[data-answer-paragraph]")[1]
    );
    await dom.render(<QuestionPageView {...props(done())} />);
    expect(dom.document.querySelector("[data-answer-caret]")).toBeNull();
  });

  it("names the send arrow of the follow-up with a tooltip's label and its key", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    const send = dom.document.querySelector('button[aria-label="Ask"]') as HTMLElement;
    expect(send).not.toBeNull();
    dom.focus(send);
    await settle();
    expect(dom.document.body.textContent).toContain("↵");
  });

  it("draws no tray from 1280 px, where the list is read beside the answer", async () => {
    await dom.render(<QuestionPageView {...props(done(), { viewportWidth: trayBelow })} />);
    await settle();
    await hover(chip(1));
    await settle();
    expect(tray()).toBeNull();
    expect(dom.document.body.textContent).not.toContain("Hover or focus a citation");
  });

  it("numbers the chips in reading order and binds each to the word before it", async () => {
    await dom.render(<QuestionPageView {...props(done())} />);
    await settle();
    const first = dom.document.querySelector("[data-answer-paragraph]");
    expect(first?.textContent).toContain("spoilage organisms 1");
    expect(
      [...dom.document.querySelectorAll("[data-citation]")].map((node) =>
        node.getAttribute("data-citation")
      )
    ).toEqual(["1", "2", "3"]);
  });

  it("says a removed passage is removed and leads to its source", async () => {
    const question = questionFixture("done");
    const answer = question.answers[0];
    if (!answer) throw new Error("fixture has an answer");
    const gone = {
      ...question,
      answers: [
        {
          ...answer,
          paragraphs: answer.paragraphs.map((paragraph) => ({
            ...paragraph,
            citations: paragraph.citations.map((citation) =>
              citation.ordinal === 2 ? { ...citation, unavailable: true } : citation
            )
          }))
        }
      ]
    };
    await dom.render(<QuestionPageView {...props(snapshot(gone))} />);
    await settle();
    expect(entry(2).textContent).toContain("passage removed");
    expect(entry(2).textContent).toContain("see the source");
    await dom.act(() => entry(2).click());
    expect(opened.at(-1)).toMatch(/^memora:\/\/source\/[^#]+$/);
  });
});

describe("the page while the answer is written", () => {
  const stream = (count: number) =>
    applyDelta(applyStatus(streamFor(request), { requestId: request, stage: "answering" }), {
      requestId: request,
      paragraphs: deltaParagraphs(count),
      restart: false
    });
  const paragraphs = () => dom.document.querySelectorAll("[data-answer-paragraph]").length;
  const stage = () => dom.document.querySelector("[data-stage]")?.getAttribute("data-stage");

  it("renders the paragraphs as they arrive and names the stage on the band", async () => {
    const running = questionFixture("running");
    await dom.render(<QuestionPageView {...props(snapshot(running))} />);
    expect(paragraphs()).toBe(0);
    expect(stage()).toBe("retrieving");
    await dom.render(<QuestionPageView {...props(snapshot(running, stream(1)))} />);
    expect(paragraphs()).toBe(1);
    expect(stage()).toBe("answering");
    await dom.render(<QuestionPageView {...props(snapshot(running, stream(2)))} />);
    expect(paragraphs()).toBe(2);
    // The band counts the sources cited so far, and the sources list follows the answer.
    expect(
      dom.document.querySelector("[data-stage]")?.textContent?.replaceAll("\u00a0", " ")
    ).toContain("2 sources cited so far");
    expect(dom.document.querySelectorAll("[data-source-entry]")).toHaveLength(3);
    const ended = applyStatus(stream(3), { requestId: request, stage: "done" });
    await dom.render(<QuestionPageView {...props(snapshot(running, ended))} />);
    expect(paragraphs()).toBe(3);
    expect(stage()).toBe("done");
  });

  it("says the provider is being waited on, and that Stop needs a request to stop", async () => {
    const running = questionFixture("running");
    const waiting = applyStatus(streamFor(request), {
      requestId: request,
      stage: "waitingForProvider"
    });
    await dom.render(<QuestionPageView {...props(snapshot(running, waiting))} />);
    expect(stage()).toBe("waitingForProvider");
    expect(dom.document.body.textContent).toContain("Waiting for the cloud AI to answer");
    const stop = [...dom.document.querySelectorAll("button")].find((node) =>
      node.textContent?.startsWith("Stop")
    ) as HTMLElement;
    await dom.act(() => stop.click());
    expect(calls.stop).toBe(1);
    // A page that does not know the request cannot stop it: no Stop is offered.
    await dom.render(<QuestionPageView {...props(snapshot(running, emptyStream))} />);
    expect(
      [...dom.document.querySelectorAll("button")].some((node) =>
        node.textContent?.startsWith("Stop")
      )
    ).toBe(false);
  });
});

describe("the page after the answer", () => {
  it("offers Ask again on a finished answer, and says it may be outdated when a source changed", async () => {
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("stale")))} />);
    // The band says it itself, with the date after it and Ask again at its end: one status line.
    const band = dom.document.querySelector("[data-stage]") as HTMLElement;
    expect(band.textContent).toContain("May be outdated: a cited source changed");
    expect(band.textContent).toContain("Answered");
    expect(dom.document.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(dom.document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("done");
    const again = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Ask again"
    ) as HTMLElement;
    await dom.act(() => again.click());
    expect(calls.again).toBe(1);
  });

  it("says what was stopped, keeps the paragraphs, and Continue asks again", async () => {
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("canceled")))} />);
    expect(dom.document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("canceled");
    expect(dom.document.body.textContent).toContain("Stopped by you");
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(2);
    const next = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Continue"
    ) as HTMLElement;
    await dom.act(() => next.click());
    expect(calls.again).toBe(1);
  });

  it("says one failure in place, keeps what was written, and offers one retry", async () => {
    const failed = applyStatus(
      applyDelta(streamFor(request), {
        requestId: request,
        paragraphs: deltaParagraphs(1),
        restart: false
      }),
      {
        requestId: request,
        stage: "failed",
        error: "consultation.errors.rateLimited"
      }
    );
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("failed"), failed))} />);
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(dom.document.body.textContent).toContain(
      "The AI provider is limiting requests right now"
    );
    expect(dom.document.body.textContent).toContain(
      "What was written before it stopped is kept below."
    );
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(1);
    const retries = [...dom.document.querySelectorAll("button")].filter(
      (node) => node.textContent === "Retry"
    );
    expect(retries).toHaveLength(1);
    await dom.act(() => (retries[0] as HTMLElement).click());
    expect(calls.again).toBe(1);
  });

  it("says an answer that found nothing in the library, with what to do next", async () => {
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("noGrounding")))} />);
    expect(dom.document.body.textContent).toContain("I found nothing in your library about this.");
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(0);
    const field = dom.document.querySelector("textarea") as HTMLTextAreaElement;
    const rephrase = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Rephrase"
    ) as HTMLElement;
    await dom.act(() => rephrase.click());
    expect(field.value).toBe("Why do fermented foods keep longer outside the fridge?");
    const add = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Add a source"
    ) as HTMLElement;
    await dom.act(() => add.click());
    expect(opened).toEqual(["memora://import"]);
  });

  it("draws the no-evidence failure as the nothing-found page, with no failure and no retry", async () => {
    // The backend stores it as a failed Question: its retry would fail the same way.
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("noGrounding")))} />);
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(dom.document.body.textContent).not.toContain("Retry");
    expect(dom.document.body.textContent).not.toContain("No relevant original passages");
    expect(questionState(snapshot(questionFixture("noGrounding")))).toBe("empty");
    // The same failure heard on the bus, before the stored Question is read.
    const heard = applyStatus(streamFor(request), {
      requestId: request,
      stage: "failed",
      error: "consultation.errors.noTopicEvidence"
    });
    const running = snapshot(questionFixture("running"), heard);
    await dom.render(<QuestionPageView {...props(running)} />);
    expect(dom.document.body.textContent).toContain("I found nothing in your library about this.");
    expect(questionState(running)).toBe("empty");
  });

  it("sends a follow-up with the words in the field, in the same scope", async () => {
    // "Rephrase" puts the question's words in the field: the way to a field with words in it.
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("noGrounding")))} />);
    const send = () => dom.document.querySelector('button[aria-label="Ask"]') as HTMLButtonElement;
    // With no words there is nothing to send.
    expect(send().disabled).toBe(true);
    const rephrase = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Rephrase"
    ) as HTMLElement;
    await dom.act(() => rephrase.click());
    expect(send().disabled).toBe(false);
    await dom.act(() => send().click());
    expect(sends).toEqual(["Why do fermented foods keep longer outside the fridge?"]);
  });

  it("sends on Enter alone, never on Shift-Enter or while a line is being composed", () => {
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(enterSends({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(enterSends({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("steps through the stored versions, newest first", async () => {
    const question = questionFixture("done");
    const first = question.answers[0];
    if (!first) throw new Error("fixture has an answer");
    const two: QuestionView = {
      ...question,
      answers: [
        { ...first, paragraphs: first.paragraphs.slice(0, 1) },
        { ...first, version: 2 }
      ]
    };
    await dom.render(<QuestionPageView {...props(snapshot(two))} />);
    expect(dom.document.body.textContent).toContain("Version 2 of 2");
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(3);
    const previous = dom.document.querySelector('[aria-label="Previous version"]') as HTMLElement;
    await dom.act(() => previous.click());
    expect(dom.document.body.textContent).toContain("Version 1 of 2");
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(1);
  });

  it("goes to the newest version after Ask again, not back to the one picked before", async () => {
    const question = questionFixture("done");
    const first = question.answers[0];
    if (!first) throw new Error("fixture has an answer");
    const two: QuestionView = {
      ...question,
      answers: [
        { ...first, paragraphs: first.paragraphs.slice(0, 1) },
        { ...first, version: 2, paragraphs: first.paragraphs.slice(0, 2) }
      ]
    };
    const three: QuestionView = {
      ...two,
      answers: [...two.answers, { ...first, version: 3 }]
    };
    const running: QuestionView = { ...two, status: "running" };
    await dom.render(<QuestionPageView {...props(snapshot(two))} />);
    const click = async (label: string) =>
      dom.act(() => (dom.document.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await click("Previous version");
    await click("Next version");
    expect(dom.document.body.textContent).toContain("Version 2 of 2");
    // Ask again: the stream writes, then version 3 is stored.
    await dom.render(<QuestionPageView {...props(snapshot(running, streamFor(request)))} />);
    await dom.render(<QuestionPageView {...props(snapshot(three))} />);
    expect(dom.document.body.textContent).toContain("Version 3 of 3");
    expect(dom.document.querySelectorAll("[data-answer-paragraph]")).toHaveLength(3);
  });
});

describe("where the model ran", () => {
  const meta = () => dom.document.querySelector("header")?.textContent ?? "";

  it("says nothing of the AI while the answer is written, whatever the stored privacy says", async () => {
    const running = { ...questionFixture("running"), privacy: "offline_only" as const };
    const writing = applyStatus(streamFor(request), { requestId: request, stage: "answering" });
    await dom.render(<QuestionPageView {...props(snapshot(running, writing))} />);
    expect(meta()).not.toContain("local AI");
    expect(meta()).not.toContain("cloud AI");
    // A Question that failed before any version was stored has no route to name either.
    const failed = { ...questionFixture("failed"), privacy: "offline_only" as const };
    await dom.render(<QuestionPageView {...props(snapshot(failed))} />);
    expect(meta()).not.toContain("local AI");
    // The stored provenance names it.
    await dom.render(<QuestionPageView {...props(snapshot(questionFixture("done")))} />);
    expect(meta()).toContain("cloud AI");
  });
});

describe("the four states", () => {
  const draw = (value: QuestionSnapshot, mode: "full" | "compact" = "full", locale = "en") =>
    renderToString(
      <QuestionPageView {...props(value, { t: createTranslator(locale), mode })} />
    ).replaceAll("<!-- -->", "");

  it("keeps the layout while loading, says one quiet failure, and one missing Question", () => {
    const loading = draw(snapshot(null, emptyStream, { status: "loading" }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');
    const failure = draw(snapshot(null, emptyStream, { status: "error" }));
    expect(failure).toContain("This question could not be opened.");
    expect(failure).toContain("Your library is as it was.");
    expect(failure.match(/Retry/g)).toHaveLength(1);
    // The previous panel reads the same Question: it says one neutral word, with no second retry.
    const quiet = draw(snapshot(null, emptyStream, { status: "error" }), "compact");
    expect(quiet).toContain(">Unavailable<");
    expect(quiet).not.toContain("Retry");
    expect(draw(snapshot(null), "compact")).toContain(">No longer here<");
    const missing = draw(snapshot(null));
    expect(missing).toContain("This question is no longer in the library.");
    // A way out: the stored Questions, in the full form only.
    expect(missing).toContain("See Questions");
    expect(draw(snapshot(null), "compact")).not.toContain("See Questions");
  });

  it("opens Library › Questions from a Question that is gone", async () => {
    await dom.render(<QuestionPageView {...props(snapshot(null))} />);
    const action = [...dom.document.querySelectorAll("button")].find(
      (node) => node.textContent === "See Questions"
    ) as HTMLElement;
    await dom.act(() => action.click());
    expect(opened).toEqual(["memora://library?tab=questions"]);
  });

  it("speaks every language in every state, with no missing message and no raw key", () => {
    const states: QuestionSnapshot[] = [
      snapshot(null, emptyStream, { status: "loading" }),
      snapshot(null, emptyStream, { status: "error" }),
      snapshot(null),
      snapshot(questionFixture("done")),
      snapshot(questionFixture("stale")),
      snapshot(questionFixture("noGrounding")),
      snapshot(questionFixture("canceled")),
      snapshot(questionFixture("failed")),
      snapshot(
        questionFixture("running"),
        applyStatus(streamFor(request), { requestId: request, stage: "waitingForProvider" })
      )
    ];
    for (const locale of supportedLanguageCodes)
      for (const state of states)
        for (const mode of ["full", "compact"] as const) {
          const html = draw(state, mode, locale);
          expect(html, locale).not.toContain("[[missing:");
          expect(html, locale).not.toContain("askPanel.");
        }
  });

  it("shows the question, where the answer stands and its first lines in the compact form", () => {
    const html = draw(done(), "compact");
    expect(html).toContain("Why do fermented foods keep longer outside the fridge?");
    expect(html).toContain("Fermented foods keep because the bacteria");
    expect(html).not.toContain("data-citation");
    expect(html).not.toContain("<textarea");
  });
});
