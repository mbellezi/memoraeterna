import { describe, expect, it } from "vitest";

import { formatObjectAddress, inboxKinds } from "@app/domain";

import {
  formatView,
  parseAddress,
  parseViewAddress,
  routeLimits,
  settingsSectionIds,
  type ViewAddress
} from "./route";

const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const topic = "11111111-2222-4333-8444-555555555555";

describe("parseAddress", () => {
  it("reads object addresses through the domain parser", () => {
    expect(parseAddress(`memora://note/${id}`)).toEqual({ object: { kind: "note", id } });
    expect(parseAddress(`memora://source/${id}#relation=${topic}`)).toEqual({
      object: { kind: "source", id, anchor: { relation: topic } }
    });
    // The legacy Obsidian spellings are external links, not workspace addresses.
    expect(parseAddress(`memora://open/source/${id}`)).toBeNull();
  });

  it("reads every view address form", () => {
    const cases: [string, ViewAddress][] = [
      ["memora://home", { view: "home" }],
      ["memora://explore", { view: "explore" }],
      ["memora://library", { view: "library" }],
      ["memora://library?tab=questions", { view: "library", tab: "questions" }],
      ["memora://library?status=needsYou", { view: "library", query: { status: "needsYou" } }],
      ["memora://library?status=storedOnly", { view: "library", query: { status: "storedOnly" } }],
      [
        `memora://library?q=caf%C3%A9%20au%20lait&sort=added&dir=desc&status=ready&topic=${topic.toUpperCase()}`,
        {
          view: "library",
          query: { text: "café au lait", sort: "added", dir: "desc", status: "ready", topic }
        }
      ],
      ["memora://inbox", { view: "inbox" }],
      [`memora://inbox?kind=${inboxKinds[0]}`, { view: "inbox", kind: inboxKinds[0] }],
      ["memora://map/relations", { view: "map", lens: "relations" }],
      [
        `memora://map/shape?scope=${encodeURIComponent(`memora://topic/${topic}`)}`,
        { view: "map", lens: "shape", scope: { kind: "topic", id: topic } }
      ],
      ["memora://settings", { view: "settings" }],
      ["memora://settings/privacy", { view: "settings", section: "privacy" }],
      [
        "memora://settings/ai#ai.route.embed",
        { view: "settings", section: "ai", setting: "ai.route.embed" }
      ],
      ["memora://search?q=a%26b%3Dc%23d", { view: "search", query: "a&b=c#d" }],
      ["memora://ask", { view: "ask" }],
      [
        `memora://ask?scope=${encodeURIComponent(`memora://source/${id}`)}&q=Why%3F`,
        { view: "ask", question: "Why?", scope: { kind: "source", id } }
      ],
      ["memora://import", { view: "import" }],
      [`memora://import?source=${id}`, { view: "import", sourceId: id }]
    ];
    for (const [raw, view] of cases) expect(parseAddress(raw), raw).toEqual({ view });
  });

  it("rejects malformed, unknown and repeated parts", () => {
    const rejected = [
      "",
      "memora://",
      "memora://nowhere",
      "MEMORA://home",
      "memora://home/",
      "memora://home?x=1",
      "memora://home#x",
      "memora://explore/topics",
      "memora://library?tab=notes",
      "memora://library?tab=sources&tab=questions",
      "memora://library?q=",
      "memora://library?q",
      "memora://library?sort=size",
      "memora://library?dir=up",
      "memora://library?status=lost",
      "memora://library?topic=not-a-uuid",
      "memora://library?unknown=1",
      "memora://library?q=%E0%A4%A",
      "memora://inbox?kind=nothing",
      "memora://map",
      "memora://map/atlas",
      "memora://map/relations/extra",
      `memora://map/relations?scope=memora://topic/${topic}#passage=${id}`,
      `memora://map/relations?scope=${encodeURIComponent(`memora://topic/${topic}#passage=${id}`)}`,
      "memora://map/relations?scope=memora%3A%2F%2Fwiki%2Fx",
      "memora://settings/",
      "memora://settings/billing",
      "memora://settings#theme",
      "memora://settings/ai#",
      "memora://settings/ai#bad id",
      "memora://settings/ai?x=1",
      "memora://search",
      "memora://search?q=",
      `memora://search?q=${"a".repeat(routeLimits.maxTextLength + 1)}`,
      "memora://ask?q=a&q=b",
      "memora://ask?scope=memora%3A%2F%2Fsource%2Fnope",
      "memora://import?source=nope",
      `memora://import/${id}`
    ];
    for (const raw of rejected) expect(parseAddress(raw), raw).toBeNull();
    expect(
      parseAddress(`memora://search?q=${"a".repeat(routeLimits.maxAddressLength)}`)
    ).toBeNull();
  });

  it("separates views from objects", () => {
    expect(parseViewAddress("memora://home")).toEqual({ view: "home" });
    expect(parseViewAddress(`memora://topic/${topic}`)).toBeNull();
    expect(parseViewAddress("memora://nowhere")).toBeNull();
  });
});

describe("formatView", () => {
  const views: ViewAddress[] = [
    { view: "home" },
    { view: "explore" },
    { view: "library" },
    { view: "library", tab: "sources" },
    {
      view: "library",
      tab: "questions",
      query: { text: "100% & more?", sort: "title", dir: "asc", status: "failed", topic }
    },
    { view: "inbox" },
    ...inboxKinds.map((kind) => ({ view: "inbox", kind }) as ViewAddress),
    { view: "map", lens: "relations" },
    { view: "map", lens: "relations", scope: { kind: "source", id } },
    { view: "map", lens: "shape", scope: { kind: "topic", id: topic } },
    { view: "settings" },
    ...settingsSectionIds.map((section) => ({ view: "settings", section }) as ViewAddress),
    { view: "settings", section: "advanced", setting: "graphWheelZoomSensitivity" },
    { view: "search", query: "naïve #tags & ?marks" },
    { view: "ask" },
    { view: "ask", question: "What changed?\nAnd why?" },
    { view: "ask", question: "Scoped", scope: { kind: "topic", id: topic } },
    { view: "import" },
    { view: "import", sourceId: id }
  ];

  it("round-trips every view", () => {
    for (const view of views) {
      const text = formatView(view);
      expect(parseAddress(text), text).toEqual({ view });
      expect(formatView(parseViewAddress(text)!)).toBe(text);
    }
  });

  it("writes keys in canonical order whatever order they were read in", () => {
    const scope = encodeURIComponent(`memora://source/${id}`);
    const view = parseViewAddress(`memora://ask?scope=${scope}&q=x`)!;
    expect(formatView(view)).toBe(`memora://ask?q=x&scope=${scope}`);
    expect(formatView({ view: "map", lens: "shape", scope: { kind: "topic", id: topic } })).toBe(
      `memora://map/shape?scope=${encodeURIComponent(formatObjectAddress({ kind: "topic", id: topic }))}`
    );
    expect(formatView({ view: "import", sourceId: id.toUpperCase() })).toBe(
      `memora://import?source=${id}`
    );
  });

  it("refuses to write a view the parser would reject", () => {
    expect(() => formatView({ view: "search", query: "" })).toThrow(TypeError);
    expect(() => formatView({ view: "import", sourceId: "nope" })).toThrow(TypeError);
    expect(() => formatView({ view: "settings", section: "ai", setting: "has space" })).toThrow(
      TypeError
    );
    expect(() =>
      formatView({ view: "ask", question: "a".repeat(routeLimits.maxTextLength + 1) })
    ).toThrow(TypeError);
  });
});
