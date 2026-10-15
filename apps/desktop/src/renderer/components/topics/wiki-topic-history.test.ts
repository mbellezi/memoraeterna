import { describe, expect, it } from "vitest";
import {
  currentWikiTopic,
  showInWiki,
  startWikiTopicHistory,
  stepWikiTopicHistory,
  wikiNavigationStep,
  wikiTopicHistoryMax,
  type WikiTopicHistory
} from "./wiki-topic-history";

const topic = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Opens the topics in order from where the Wiki starts. */
const opened = (...ids: (string | null)[]): WikiTopicHistory =>
  ids.reduce<WikiTopicHistory>((history, id) => showInWiki(history, id), startWikiTopicHistory);

const back = (history: WikiTopicHistory) => stepWikiTopicHistory(history, "back");
const forward = (history: WikiTopicHistory) => stepWikiTopicHistory(history, "forward");

describe("the Wiki's topic history", () => {
  it("starts where the Wiki starts, with nowhere to go", () => {
    expect(currentWikiTopic(startWikiTopicHistory)).toBeNull();
    expect(back(startWikiTopicHistory)).toBeNull();
    expect(forward(startWikiTopicHistory)).toBeNull();
  });

  it("shows each opened topic, from the tree, a link or the Library, after the one before", () => {
    const history = opened(topic(1), topic(2), topic(3));
    expect(currentWikiTopic(history)).toBe(topic(3));
    expect(history.entries).toEqual([null, topic(1), topic(2), topic(3)]);
  });

  it("adds no step when the open topic is opened again", () => {
    const history = opened(topic(1));
    expect(showInWiki(history, topic(1))).toBe(history);
    expect(showInWiki(startWikiTopicHistory, null)).toBe(startWikiTopicHistory);
  });

  it("goes back and forward through what it showed, and leaves the step to others at either end", () => {
    const history = opened(topic(1), topic(2));
    const one = back(history)!;
    expect(currentWikiTopic(one)).toBe(topic(1));
    const start = back(one)!;
    expect(currentWikiTopic(start)).toBeNull();
    expect(back(start)).toBeNull();
    expect(currentWikiTopic(forward(forward(start)!)!)).toBe(topic(2));
    expect(forward(history)).toBeNull();
  });

  it("drops the forward steps when a topic is opened after going back", () => {
    const history = showInWiki(back(back(opened(topic(1), topic(2), topic(3)))!)!, topic(4));
    expect(history.entries).toEqual([null, topic(1), topic(4)]);
    expect(forward(history)).toBeNull();
    expect(currentWikiTopic(back(history)!)).toBe(topic(1));
  });

  it("makes closing a topic a step: Back opens it again", () => {
    const closed = showInWiki(opened(topic(1)), null);
    expect(currentWikiTopic(closed)).toBeNull();
    expect(currentWikiTopic(back(closed)!)).toBe(topic(1));
  });

  it("keeps a bounded number of steps, dropping the oldest", () => {
    const ids = Array.from({ length: wikiTopicHistoryMax + 10 }, (_, index) => topic(index + 1));
    const history = opened(...ids);
    expect(history.entries).toHaveLength(wikiTopicHistoryMax);
    expect(history.entries[0]).toBe(topic(11));
    expect(currentWikiTopic(history)).toBe(ids.at(-1));
    let walked: WikiTopicHistory | null = history;
    let steps = 0;
    while ((walked = back(walked!)) !== null) steps += 1;
    expect(steps).toBe(wikiTopicHistoryMax - 1);
  });

  it("takes Back and Forward only while the Wiki is on screen and has somewhere to go", () => {
    const history = opened(topic(1), topic(2));
    expect(currentWikiTopic(wikiNavigationStep(true, history, "back")!)).toBe(topic(1));
    // A hidden Wiki ignores history events; the Library or another listener takes them.
    expect(wikiNavigationStep(false, history, "back")).toBeNull();
    expect(wikiNavigationStep(true, history, "forward")).toBeNull();
    expect(wikiNavigationStep(true, startWikiTopicHistory, "back")).toBeNull();
  });

  it("never changes a history it is given", () => {
    const history = opened(topic(1), topic(2));
    const entries = [...history.entries];
    showInWiki(back(history)!, topic(3));
    back(history);
    expect(history.entries).toEqual(entries);
    expect(Object.isFrozen(startWikiTopicHistory.entries)).toBe(true);
  });
});
