import { describe, expect, it, vi } from "vitest";
import { formatObjectAddress } from "@app/domain";
import { createTranslator } from "@app/i18n";
import { parseObsidianDeepLink, type ObsidianDeepLink } from "../../shared/obsidian-deep-link";
import { FakeTopics, id as topicId, settle } from "../components/topics/topic-fixtures";
import {
  currentWikiTopic,
  showInWiki,
  startWikiTopicHistory
} from "../components/topics/wiki-topic-history";
import {
  TopicPageController,
  type TopicPageApi
} from "../components/topic-page/topic-page-controller";
import { topicPage } from "../components/topic-page/topic-page-fixtures";
import {
  createObsidianLinkOpener,
  followObsidianLink,
  routeObsidianLink,
  type ObsidianLinkActions
} from "./obsidian-link";

const id = "00000000-0000-4000-8000-0000000000a1";
const relation = "00000000-0000-4000-8000-0000000000b1";

describe("a link from Obsidian", () => {
  it("to a wiki page leads to the Wiki with the notice, whatever the page was", () => {
    expect(routeObsidianLink({ kind: "wiki", id })).toEqual({ type: "removedWikiPage" });
    expect(routeObsidianLink({ kind: "wiki", id, revision: relation })).toEqual({
      type: "removedWikiPage"
    });
  });

  it("to a source opens it in the Library, coming from the Wiki, with its relation if it names one", () => {
    expect(routeObsidianLink({ kind: "source", id })).toEqual({
      type: "source",
      target: { sourceItemId: id, origin: "wiki" }
    });
    expect(routeObsidianLink({ kind: "source", id, relation })).toEqual({
      type: "source",
      target: { sourceItemId: id, origin: "wiki", sourceRelationId: relation }
    });
  });

  it("to a topic names that topic", () => {
    expect(routeObsidianLink({ kind: "topic", id })).toEqual({ type: "topic", topicId: id });
  });
});

// The tree: Memory > Forgetting curve, plus two retired topics. `old` was merged into `merged`,
// which was merged into `curve`; `orphan` is retired with no successor left in the tree.
const [root, memory, curve, old, merged, orphan, unknown] = [1, 2, 3, 4, 5, 6, 7].map(topicId) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string
];
const tree = () =>
  new FakeTopics({
    rootId: root,
    topics: [
      { id: root, parentId: null, title: null, children: [memory] },
      { id: memory, parentId: root, title: "Memory", children: [curve] },
      { id: curve, parentId: memory, title: "Forgetting curve" },
      { id: merged, parentId: memory, title: "Merged", redirectTo: curve },
      { id: old, parentId: memory, title: "Old", redirectTo: merged },
      { id: orphan, parentId: memory, title: "Orphan", redirectTo: unknown }
    ]
  });

/** The link a topic map carries for `topic`, as Obsidian hands it to the app. */
const mocLink = (topic: string): ObsidianDeepLink => {
  const parsed = parseObsidianDeepLink(formatObjectAddress({ kind: "topic", id: topic }));
  if (!parsed) throw new Error("the map link must parse");
  return parsed;
};

describe("following a topic link", () => {
  it("opens the topic a map link names", async () => {
    const topics = tree();
    expect(await followObsidianLink(mocLink(curve), topics.api)).toEqual({
      type: "topic",
      topicId: curve,
      redirected: false
    });
    expect(topics.calls.path).toEqual([{ id: curve }]);
  });

  it("opens the successor of a merged or retired topic, however many merges it went through", async () => {
    const topics = tree();
    expect(await followObsidianLink(mocLink(merged), topics.api)).toEqual({
      type: "topic",
      topicId: curve,
      redirected: true
    });
    expect(await followObsidianLink(mocLink(old), topics.api)).toEqual({
      type: "topic",
      topicId: curve,
      redirected: true
    });
  });

  it("reports a topic the tree does not have, or whose successor is gone, as not found", async () => {
    const topics = tree();
    expect(await followObsidianLink(mocLink(unknown), topics.api)).toEqual({
      type: "topicNotFound"
    });
    expect(await followObsidianLink(mocLink(orphan), topics.api)).toEqual({
      type: "topicNotFound"
    });
  });

  it("opens the topic as named when the tree cannot be asked: the Topic page has its own states", async () => {
    const topics = tree();
    topics.failNext.path = "not ready";
    expect(await followObsidianLink(mocLink(old), topics.api)).toEqual({
      type: "topic",
      topicId: old,
      redirected: false
    });
  });

  it("leaves the tree alone for links to wiki pages and sources", async () => {
    const topics = tree();
    expect(await followObsidianLink({ kind: "wiki", id }, topics.api)).toEqual({
      type: "removedWikiPage"
    });
    expect(await followObsidianLink({ kind: "source", id }, topics.api)).toEqual({
      type: "source",
      target: { sourceItemId: id, origin: "wiki" }
    });
    expect(topics.calls.path).toEqual([]);
  });
});

function actions() {
  const calls = {
    removedWikiPage: vi.fn<ObsidianLinkActions["removedWikiPage"]>(),
    source: vi.fn<ObsidianLinkActions["source"]>(),
    topic: vi.fn<ObsidianLinkActions["topic"]>(),
    topicNotFound: vi.fn<ObsidianLinkActions["topicNotFound"]>()
  };
  return calls satisfies ObsidianLinkActions;
}

describe("opening the links Obsidian sends", () => {
  it("opens the Topic page of a map link: the Wiki shows the topic and the page reads it", async () => {
    const topics = tree();
    const act = actions();
    let history = startWikiTopicHistory;
    act.topic.mockImplementation((topic) => {
      history = showInWiki(history, topic);
    });
    const open = createObsidianLinkOpener({ topics: () => topics.api, actions: () => act });
    await open(mocLink(curve));

    expect(act.topic).toHaveBeenCalledExactlyOnceWith(curve, false);
    expect(currentWikiTopic(history)).toBe(curve);

    // The Topic page of the Wiki then reads exactly that topic.
    const page = vi.fn<TopicPageApi["page"]>(async (input) =>
      topicPage({ topic: { ...topicPage().topic, id: input.id } })
    );
    const record = vi.fn();
    const controller = new TopicPageController({
      api: () => ({ page, subscribeChanged: () => () => undefined }) as unknown as TopicPageApi,
      record
    });
    controller.show(currentWikiTopic(history)!, true, createTranslator("en"));
    await settle();
    const load = controller.getSnapshot().load;
    expect(load.status).toBe("ready");
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ id: curve }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: "topic", id: curve }));
    controller.dispose();
  });

  it("opens the successor of a redirected id, and says the topic was merged", async () => {
    const topics = tree();
    const act = actions();
    let history = startWikiTopicHistory;
    act.topic.mockImplementation((topic) => {
      history = showInWiki(history, topic);
    });
    const open = createObsidianLinkOpener({ topics: () => topics.api, actions: () => act });
    await open(mocLink(old));

    expect(act.topic).toHaveBeenCalledExactlyOnceWith(curve, true);
    // The Wiki holds the successor, not the retired ID, so Back and the navigator agree with the page.
    expect(currentWikiTopic(history)).toBe(curve);
    expect(act.topicNotFound).not.toHaveBeenCalled();
  });

  it("shows the not-found state for an unknown topic and opens no topic", async () => {
    const topics = tree();
    const act = actions();
    const open = createObsidianLinkOpener({ topics: () => topics.api, actions: () => act });
    await open(mocLink(unknown));
    expect(act.topicNotFound).toHaveBeenCalledOnce();
    expect(act.topic).not.toHaveBeenCalled();
  });

  it("keeps the old behavior for wiki pages and sources", async () => {
    const topics = tree();
    const act = actions();
    const open = createObsidianLinkOpener({ topics: () => topics.api, actions: () => act });
    await open({ kind: "wiki", id });
    await open({ kind: "source", id, relation });
    expect(act.removedWikiPage).toHaveBeenCalledOnce();
    expect(act.source).toHaveBeenCalledExactlyOnceWith({
      sourceItemId: id,
      origin: "wiki",
      sourceRelationId: relation
    });
    expect(act.topic).not.toHaveBeenCalled();
  });

  it("follows only the newest link: a slower answer to an earlier one is dropped", async () => {
    const act = actions();
    const answers: Array<() => void> = [];
    const slow = tree();
    const open = createObsidianLinkOpener({
      topics: () => ({
        path: (input) =>
          new Promise((resolve) => {
            answers.push(() => resolve(slow.api.path(input)));
          })
      }),
      actions: () => act
    });
    const first = open(mocLink(memory));
    const second = open(mocLink(curve));
    // The second link is answered first, then the first one arrives late.
    answers[1]?.();
    await second;
    answers[0]?.();
    await first;
    expect(act.topic).toHaveBeenCalledExactlyOnceWith(curve, false);
  });

  it("reads the actions when the link arrives, not when the opener was made", async () => {
    const topics = tree();
    const early = actions();
    const late = actions();
    let current: ObsidianLinkActions = early;
    const open = createObsidianLinkOpener({ topics: () => topics.api, actions: () => current });
    current = late;
    await open(mocLink(curve));
    expect(late.topic).toHaveBeenCalledOnce();
    expect(early.topic).not.toHaveBeenCalled();
  });
});
