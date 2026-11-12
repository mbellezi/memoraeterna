import { describe, expect, it } from "vitest";

import { fixtureAddresses } from "../panel-screen-fixtures";
import { matchPanel, registerPanels } from "../PanelStack";
import * as note from "./note.panel";
import * as topic from "./topic.panel";
import { addressForNavigation, addressForPassage, frameState } from "./object-open";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const registry = registerPanels({ "./note.panel.tsx": note, "./topic.panel.tsx": topic });

describe("the Note and Topic panels register by file", () => {
  it("each takes its own kind of address, anchored or not, and nothing else", () => {
    expect(matchPanel(registry, fixtureAddresses.note)?.kind).toBe("note");
    expect(matchPanel(registry, `${fixtureAddresses.note}#relation=${uuid(9)}`)?.kind).toBe("note");
    expect(matchPanel(registry, fixtureAddresses.topic)?.kind).toBe("topic");
    expect(matchPanel(registry, fixtureAddresses.source)).toBeNull();
    expect(matchPanel(registry, fixtureAddresses.question)).toBeNull();
    expect(matchPanel(registry, "memora://explore")).toBeNull();
    expect(matchPanel(registry, "memora://note/not-a-uuid")).toBeNull();
  });

  it("names the panel by the object's title, empty until it is read", () => {
    expect(note.title({ title: "A note" } as never)).toBe("A note");
    expect(topic.title(null)).toBe("");
  });
});

describe("what a page opens from a panel", () => {
  it("opens every navigation as an address beside the panel, never as a screen", () => {
    expect(addressForNavigation({ type: "topic", topicId: uuid(4) })).toBe(
      `memora://topic/${uuid(4)}`
    );
    expect(addressForNavigation({ type: "note", path: [uuid(1)], noteId: uuid(21) })).toBe(
      `memora://note/${uuid(21)}`
    );
    // A source is the last of its path of source IDs.
    expect(addressForNavigation({ type: "source", path: [uuid(1), uuid(11)] })).toBe(
      `memora://source/${uuid(11)}`
    );
    expect(addressForNavigation({ type: "source", path: [] })).toBeNull();
  });

  it("opens a cited passage with its anchors, so the source shows it highlighted", () => {
    expect(
      addressForPassage(uuid(11), {
        chunkId: uuid(501),
        sourceSpanId: uuid(502),
        documentId: uuid(3)
      })
    ).toBe(`memora://source/${uuid(11)}#passage=${uuid(501)}&span=${uuid(502)}`);
    expect(
      addressForPassage(uuid(11), { chunkId: null, sourceSpanId: null, documentId: null })
    ).toBe(`memora://source/${uuid(11)}`);
  });
});

describe("the four states of the frame", () => {
  it("reads the page's own load: a missing object is the empty state", () => {
    expect(frameState("loading")).toBe("loading");
    expect(frameState("error")).toBe("error");
    expect(frameState("missing")).toBe("empty");
    expect(frameState("ready")).toBe("success");
  });
});
