import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import type { TopicTreeEditor } from "./events.js";
import { uuidOf } from "./fixtures/placement-world.js";
import {
  TopicOperationError,
  createTopic,
  humanPlaceItem,
  moveTopic,
  pinTopic,
  renameTopic,
  unpinTopic
} from "./human-ops.js";
import type { HumanOperationContext, TopicOperationErrorCode } from "./human-ops.js";
import { itemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import {
  TopicTreeStateError,
  canonicalStateDump,
  createTopicTreeState,
  getTopic,
  placementRecord,
  placementsOf,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";

const t = (n: number): string => uuidOf(n);
const config = topicTreeConfigWith({ depth: { target: 3, cap: 4 } });
const items = [1, 2, 3].map((n) => itemKey("note", uuidOf(500 + n)));

/**
 * root(0) ── 1 "Ciência" ── 2 "Física" ── 3 "Óptica"
 *        │              └── 4 "Química"
 *        └── 5 "Artes"
 * items[0] primary on 3 with a secondary on 5; items[1] primary on 4; items[2] unplaced.
 */
function world(): {
  state: TopicTreeState;
  editor: TopicTreeEditor;
  context: HumanOperationContext;
} {
  const state = createTopicTreeState({ dim: 2, rootId: t(0) });
  const setup = createTopicTreeEditor(state, { record: false });
  const titles: Record<number, [number, string]> = {
    1: [0, "Ciência"],
    2: [1, "Física"],
    3: [2, "Óptica"],
    4: [1, "Química"],
    5: [0, "Artes"]
  };
  for (const [id, [parent, title]] of Object.entries(titles)) {
    setup.createTopic(t(Number(id)), t(parent), { title, nameState: "named", nameSource: "llm" });
  }
  items.forEach((key, index) =>
    registerItem(state, { key, kind: "note", contentHash: `h${index}`, rootSource: null })
  );
  setup.placeItem(items[0] as string, placementRecord(t(3)));
  setup.placeItem(items[0] as string, placementRecord(t(5), { rank: 1 }));
  setup.placeItem(items[1] as string, placementRecord(t(4)));
  const editor = createTopicTreeEditor(state);
  return { state, editor, context: { state, config, editor } };
}

function refused(
  context: HumanOperationContext,
  code: TopicOperationErrorCode,
  operation: () => unknown
): void {
  const dump = canonicalStateDump(context.state);
  const events = context.editor.events.length;
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TopicOperationError);
  expect((error as TopicOperationError).code).toBe(code);
  expect(canonicalStateDump(context.state)).toBe(dump);
  expect(context.editor.events).toHaveLength(events);
}

describe("human topic operations", () => {
  it("renames a topic as a human name and protects it", () => {
    const { state, editor, context } = world();
    expect(
      renameTopic(context, t(2), "  Física moderna ", { language: "pt-BR", changeSetId: t(900) })
    ).toBe(2);
    expect(getTopic(state, t(2))).toMatchObject({
      title: "Física moderna",
      nameState: "named",
      nameSource: "human",
      nameLanguage: "pt-BR",
      namedChangeSetId: t(900),
      management: "human"
    });
    expect(editor.events.map((event) => event.op)).toEqual(["topic.rename", "topic.manage"]);
    expect(
      renameTopic(context, t(2), "Física moderna", { language: "pt-BR", changeSetId: t(900) })
    ).toBe(0);
    refused(context, "duplicateTitle", () => renameTopic(context, t(2), "química"));
    refused(context, "invalidTitle", () => renameTopic(context, t(2), "   "));
    refused(context, "invalidTitle", () => renameTopic(context, t(2), "x".repeat(121)));
    refused(context, "invalidLanguage", () =>
      renameTopic(context, t(2), "Mecânica", { language: "x".repeat(17) })
    );
    refused(context, "root", () => renameTopic(context, t(0), "Tudo"));
    refused(context, "notFound", () => renameTopic(context, t(99), "Nada"));
  });

  it("moves a topic with a cycle check, the depth cap and I2 clean-up", () => {
    const { state, editor, context } = world();
    refused(context, "cycle", () => moveTopic(context, t(1), t(3)));
    refused(context, "cycle", () => moveTopic(context, t(2), t(2)));
    refused(context, "root", () => moveTopic(context, t(0), t(5)));
    refused(context, "notFound", () => moveTopic(context, t(2), t(99)));
    refused(context, "invalidPosition", () => moveTopic(context, t(2), t(5), { position: -1 }));
    expect(moveTopic(context, t(2), t(1))).toBe(0);
    // Moving "Física" (holding items[0]) under "Artes" puts items[0]'s secondary on its path.
    expect(moveTopic(context, t(2), t(5))).toBe(3);
    expect(editor.events.map((event) => event.op)).toEqual([
      "item.unplace",
      "topic.move",
      "topic.manage"
    ]);
    expect(getTopic(state, t(2))).toMatchObject({ parentId: t(5), management: "human" });
    expect(placementsOf(state, items[0] as string).map((placement) => placement.rank)).toEqual([0]);
    expect(checkInvariants(state, config).violations.filter((v) => v.code === "I2")).toEqual([]);
    // A deep chain: 3 is at depth 3; a child under it would sit at 4 (the cap); 2's subtree has
    // height 1, so moving it under 3's new child would cross the cap.
    createTopic(context, t(6), t(3), "Lentes");
    refused(context, "depthCap", () => createTopic(context, t(7), t(6), "Vidro"));
    refused(context, "cycle", () => moveTopic(context, t(2), t(6)));
    refused(context, "depthCap", () => moveTopic(context, t(4), t(6)));
  });

  it("refuses a move that would duplicate a sibling title", () => {
    const { context } = world();
    createTopic(context, t(6), t(5), "Química");
    refused(context, "duplicateTitle", () => moveTopic(context, t(4), t(5)));
  });

  it("creates a protected human topic", () => {
    const { state, context } = world();
    expect(createTopic(context, t(6), t(5), "Música", { changeSetId: t(901) })).toBe(1);
    expect(getTopic(state, t(6))).toMatchObject({
      parentId: t(5),
      title: "Música",
      nameSource: "human",
      management: "human",
      createdChangeSetId: t(901)
    });
    refused(context, "duplicateTitle", () => createTopic(context, t(7), t(5), "MÚSICA"));
    refused(context, "notFound", () => createTopic(context, t(7), t(99), "Teatro"));
    expect(() => createTopic(context, t(6), t(5), "Teatro")).toThrow(TopicTreeStateError);
  });

  it("pins and unpins (D28)", () => {
    const { state, context } = world();
    expect(pinTopic(context, t(2))).toBe(1);
    expect(pinTopic(context, t(2))).toBe(0);
    expect(getTopic(state, t(2)).management).toBe("pinned");
    expect(unpinTopic(context, t(2))).toBe(1);
    expect(getTopic(state, t(2)).management).toBe("human");
    expect(unpinTopic(context, t(2))).toBe(0);
    pinTopic(context, t(2));
    unpinTopic(context, t(2), { restore: "ai" });
    expect(getTopic(state, t(2)).management).toBe("ai");
    refused(context, "root", () => pinTopic(context, t(0)));
  });

  it("places items by hand as primary or secondary", () => {
    const { state, context } = world();
    // A primary move drops the secondaries on the new path.
    expect(humanPlaceItem(context, items[0] as string, t(5), "primary")).toBe(2);
    expect(placementsOf(state, items[0] as string)).toEqual([
      expect.objectContaining({ rank: 0, topicId: t(5), management: "human", decidedBy: "human" })
    ]);
    expect(humanPlaceItem(context, items[0] as string, t(5), "primary")).toBe(0);
    refused(context, "noPrimary", () =>
      humanPlaceItem(context, items[2] as string, t(3), "secondary")
    );
    expect(humanPlaceItem(context, items[2] as string, t(3), "primary")).toBe(1);
    refused(context, "onPrimaryPath", () =>
      humanPlaceItem(context, items[2] as string, t(1), "secondary")
    );
    expect(humanPlaceItem(context, items[2] as string, t(4), "secondary")).toBe(1);
    expect(humanPlaceItem(context, items[2] as string, t(4), "secondary")).toBe(0);
    expect(humanPlaceItem(context, items[2] as string, t(5), "secondary")).toBe(1);
    expect(humanPlaceItem(context, items[1] as string, t(3), "secondary")).toBe(1);
    expect(humanPlaceItem(context, items[1] as string, t(5), "secondary")).toBe(1);
    refused(context, "secondariesFull", () =>
      humanPlaceItem(context, items[1] as string, t(2), "secondary")
    );
    refused(context, "root", () => humanPlaceItem(context, items[1] as string, t(0), "primary"));
    refused(context, "notFound", () =>
      humanPlaceItem(context, itemKey("note", uuidOf(999)), t(3), "primary")
    );
    expect(checkInvariants(state, config).violations.filter((v) => v.code === "I2")).toEqual([]);
  });

  it("replaces the highest-ranked AI secondary when the secondaries are full", () => {
    const { state, editor, context } = world();
    const item = items[1] as string;
    editor.placeItem(item, placementRecord(t(3), { rank: 1 }));
    editor.placeItem(item, placementRecord(t(5), { rank: 2 }));
    expect(humanPlaceItem(context, item, t(2), "secondary")).toBe(1);
    expect(
      placementsOf(state, item).map((placement) => [
        placement.rank,
        placement.topicId,
        placement.management
      ])
    ).toEqual([
      [0, t(4), "ai"],
      [1, t(3), "ai"],
      [2, t(2), "human"]
    ]);
    // An existing AI secondary is adopted instead of duplicated.
    expect(humanPlaceItem(context, item, t(3), "secondary")).toBe(1);
    expect(placementsOf(state, item)[1]).toMatchObject({ topicId: t(3), management: "human" });
  });
});
