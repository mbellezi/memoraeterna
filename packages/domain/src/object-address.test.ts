import { describe, expect, it } from "vitest";

import {
  ObjectLocateInputSchema,
  ObjectLocateResultSchema,
  formatObjectAddress,
  normalizeMemoraLink,
  objectAnchorKeys,
  objectKinds,
  objectLocatePathLimit,
  objectLocateTopicPathLimit,
  parseObjectAddress
} from "./object-address.js";
import { topicReadLimits } from "./topics.js";

const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const chunk = "11111111-2222-4333-8444-555555555555";
const span = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const section = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const relation = "cccccccc-dddd-4eee-8fff-000000000000";

describe("object addresses", () => {
  it("parses every visible kind into its kind and identity", () => {
    for (const kind of objectKinds)
      expect(parseObjectAddress(`memora://${kind}/${id}`)).toEqual({ kind, id });
  });

  it("parses the passage, span and section anchors alone and together", () => {
    expect(parseObjectAddress(`memora://source/${id}#passage=${chunk}`)).toEqual({
      kind: "source",
      id,
      anchor: { passage: chunk }
    });
    expect(parseObjectAddress(`memora://note/${id}#span=${span}`)?.anchor).toEqual({ span });
    expect(parseObjectAddress(`memora://topic/${id}#section=${section}`)?.anchor).toEqual({
      section
    });
    expect(
      parseObjectAddress(`memora://source/${id}#section=${section}&span=${span}&passage=${chunk}`)
        ?.anchor
    ).toEqual({ passage: chunk, span, section });
  });

  it("parses the relation anchor and keeps it last in the canonical order", () => {
    expect(objectAnchorKeys).toEqual(["passage", "span", "section", "relation"]);
    expect(parseObjectAddress(`memora://source/${id}#relation=${relation}`)).toEqual({
      kind: "source",
      id,
      anchor: { relation }
    });
    expect(formatObjectAddress({ kind: "source", id, anchor: { relation, passage: chunk } })).toBe(
      `memora://source/${id}#passage=${chunk}&relation=${relation}`
    );
    for (const value of [
      `memora://source/${id}#relation=`,
      `memora://source/${id}#relation=not-a-uuid`,
      `memora://source/${id}#relation=${relation}&relation=${relation}`,
      `memora://source/${id}?relation=${relation}`
    ])
      expect(parseObjectAddress(value), value).toBeNull();
  });

  it("normalizes identifiers to lower case but keeps the scheme exact", () => {
    expect(parseObjectAddress(`MEMORA://source/${id.toUpperCase()}`)).toBeNull();
    expect(
      parseObjectAddress(`memora://source/${id.toUpperCase()}#passage=${chunk.toUpperCase()}`)
    ).toEqual({ kind: "source", id, anchor: { passage: chunk } });
  });

  it("rejects anything that is not a well-formed address", () => {
    const rejected = [
      "",
      id,
      `memora:source/${id}`,
      `memora:/source/${id}`,
      `http://source/${id}`,
      `memora://wiki/${id}`,
      `memora://atomic_note/${id}`,
      `memora://source/${id.slice(1)}`,
      `memora://source/${id}x`,
      `memora://source/${id}/extra`,
      `memora://source/${id}/`,
      `memora://source/`,
      `memora://source`,
      `memora:///${id}`,
      `memora://source/${id}#`,
      `memora://source/${id}#passage`,
      `memora://source/${id}#passage=`,
      `memora://source/${id}#passage=not-a-uuid`,
      `memora://source/${id}#unknown=${chunk}`,
      `memora://source/${id}#passage=${chunk}&passage=${chunk}`,
      `memora://source/${id}#passage=${chunk}&`,
      `memora://source/${id}#passage=${chunk}#span=${span}`,
      `memora://source/${id}?passage=${chunk}`,
      `memora://source/${id} `,
      ` memora://source/${id}`,
      `memora://source/${id}#passage=${chunk}${"a".repeat(400)}`
    ];
    for (const value of rejected) expect(parseObjectAddress(value), value).toBeNull();
  });

  it("formats canonically and round-trips every kind and anchor combination", () => {
    const anchors = [
      undefined,
      { passage: chunk },
      { span },
      { section },
      { span, passage: chunk },
      { section, span, passage: chunk },
      { relation },
      { relation, section, span, passage: chunk }
    ];
    for (const kind of objectKinds) {
      for (const anchor of anchors) {
        const address = anchor ? { kind, id, anchor } : { kind, id };
        const text = formatObjectAddress(address);
        expect(parseObjectAddress(text)).toEqual(address);
        expect(formatObjectAddress(parseObjectAddress(text)!)).toBe(text);
      }
    }
    expect(
      formatObjectAddress({ kind: "source", id, anchor: { section, span, passage: chunk } })
    ).toBe(`memora://source/${id}#passage=${chunk}&span=${span}&section=${section}`);
    expect(formatObjectAddress({ kind: "note", id: id.toUpperCase() })).toBe(`memora://note/${id}`);
  });

  it("refuses to format an address the parser would reject", () => {
    expect(() => formatObjectAddress({ kind: "source", id: "not-a-uuid" })).toThrow(TypeError);
    expect(() => formatObjectAddress({ kind: "wiki" as never, id })).toThrow(TypeError);
    expect(() => formatObjectAddress({ kind: "source", id, anchor: { passage: "nope" } })).toThrow(
      TypeError
    );
  });
});

describe("objects.locate contract", () => {
  it("validates the address at the boundary", () => {
    expect(ObjectLocateInputSchema.parse({ address: `memora://source/${id}` })).toEqual({
      address: `memora://source/${id}`
    });
    expect(ObjectLocateInputSchema.safeParse({ address: "memora://source/nope" }).success).toBe(
      false
    );
    expect(
      ObjectLocateInputSchema.safeParse({ address: `memora://source/${id}`, extra: 1 }).success
    ).toBe(false);
    expect(ObjectLocateInputSchema.safeParse({}).success).toBe(false);
  });

  const ref = (kind: "source" | "note" | "topic", n: number) => ({
    kind,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `${kind} ${n}`
  });
  const result = {
    object: ref("note", 3),
    primaryPath: [
      { ...ref("topic", 5), title: "" },
      ref("topic", 6),
      ref("source", 1),
      ref("source", 2),
      ref("note", 3)
    ],
    alsoIn: [ref("topic", 4)],
    citedBy: [ref("note", 7)],
    counts: { alsoIn: 1, citedBy: 1, notes: 0, passages: 2, children: 0 }
  };

  it("accepts the stable shape and keeps it closed", () => {
    expect(ObjectLocateResultSchema.parse(result)).toEqual(result);
    expect(ObjectLocateResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(ObjectLocateResultSchema.safeParse({ ...result, primaryPath: [] }).success).toBe(false);
    expect(
      ObjectLocateResultSchema.safeParse({
        ...result,
        counts: { ...result.counts, children: -1 }
      }).success
    ).toBe(false);
  });

  it("has no legacy flag: a placement or a citation is a plain object reference", () => {
    expect(
      ObjectLocateResultSchema.safeParse({
        ...result,
        alsoIn: [{ ...ref("topic", 4), legacy: true }]
      }).success
    ).toBe(false);
    expect(
      ObjectLocateResultSchema.safeParse({
        ...result,
        citedBy: [{ ...ref("note", 7), legacy: false }]
      }).success
    ).toBe(false);
  });

  it("lists only topics as other places, and any object kind as a citation", () => {
    expect(
      ObjectLocateResultSchema.safeParse({ ...result, alsoIn: [ref("note", 4)] }).success
    ).toBe(false);
    expect(
      ObjectLocateResultSchema.safeParse({ ...result, citedBy: [ref("topic", 8)] }).success
    ).toBe(true);
  });

  it("bounds the path by the topic path and the source chain together", () => {
    const topics = Array.from({ length: objectLocateTopicPathLimit }, (_, n) =>
      ref("topic", 100 + n)
    );
    const sources = Array.from({ length: objectLocatePathLimit }, (_, n) => ref("source", 200 + n));
    const fits = { ...result, primaryPath: [...topics, ...sources] };
    expect(ObjectLocateResultSchema.safeParse(fits).success).toBe(true);
    expect(
      ObjectLocateResultSchema.safeParse({
        ...fits,
        primaryPath: [...fits.primaryPath, ref("note", 3)]
      }).success
    ).toBe(false);
  });

  it("keeps the topic path limit equal to the longest path the topic reads return", () => {
    expect(objectLocateTopicPathLimit).toBe(topicReadLimits.pathMax);
  });
});

describe("normalizeMemoraLink", () => {
  it("reads every canonical address, anchors included, exactly as the parser does", () => {
    for (const kind of objectKinds) {
      const text = `memora://${kind}/${id}`;
      expect(normalizeMemoraLink(text)).toEqual({ kind: "object", address: { kind, id } });
    }
    const anchored = `memora://source/${id}#passage=${chunk}&span=${span}&section=${section}&relation=${relation}`;
    expect(normalizeMemoraLink(anchored)).toEqual({
      kind: "object",
      address: parseObjectAddress(anchored)
    });
    expect(normalizeMemoraLink(`memora://topic/${id}`)).toEqual({
      kind: "object",
      address: { kind: "topic", id }
    });
  });

  it("maps the legacy open/source forms onto the source address", () => {
    expect(normalizeMemoraLink(`memora://open/source/${id}`)).toEqual({
      kind: "object",
      address: { kind: "source", id },
      legacy: "open-source"
    });
    const link = normalizeMemoraLink(`memora://open/source/${id}?relation=${relation}`);
    expect(link).toEqual({
      kind: "object",
      address: { kind: "source", id, anchor: { relation } },
      legacy: "open-source-relation"
    });
    if (link.kind !== "object") throw new Error("expected an object");
    expect(formatObjectAddress(link.address)).toBe(`memora://source/${id}#relation=${relation}`);
  });

  it("reads a legacy wiki link as retired, ignoring its revision and evidence", () => {
    const retired = { kind: "retired-wiki", id };
    expect(normalizeMemoraLink(`memora://open/wiki/${id}`)).toEqual(retired);
    expect(normalizeMemoraLink(`memora://open/wiki/${id}?revision=${chunk}`)).toEqual(retired);
    expect(normalizeMemoraLink(`memora://open/wiki/${id}?evidence=${span}`)).toEqual(retired);
    expect(
      normalizeMemoraLink(`memora://open/wiki/${id}?revision=${chunk}&evidence=${span}`)
    ).toEqual(retired);
    expect(
      normalizeMemoraLink(`memora://open/wiki/${id}?evidence=${span}&revision=${chunk}`)
    ).toEqual(retired);
  });

  it("lowers identifiers and reads the scheme and first segment case-insensitively", () => {
    const upper = id.toUpperCase();
    expect(normalizeMemoraLink(`MEMORA://Source/${upper}#Passage=${chunk}`)).toEqual({
      kind: "invalid",
      reason: "anchor"
    });
    expect(normalizeMemoraLink(`MEMORA://Source/${upper}#passage=${chunk.toUpperCase()}`)).toEqual({
      kind: "object",
      address: { kind: "source", id, anchor: { passage: chunk } }
    });
    expect(
      normalizeMemoraLink(`Memora://OPEN/source/${upper}?relation=${relation.toUpperCase()}`)
    ).toEqual({
      kind: "object",
      address: { kind: "source", id, anchor: { relation } },
      legacy: "open-source-relation"
    });
    expect(normalizeMemoraLink(`memora://open/wiki/${upper}`)).toEqual({
      kind: "retired-wiki",
      id
    });
    // Below the first segment the spelling is exact.
    expect(normalizeMemoraLink(`memora://open/SOURCE/${id}`)).toEqual({
      kind: "invalid",
      reason: "kind"
    });
    expect(normalizeMemoraLink(`memora://open/source/${id}?RELATION=${relation}`)).toEqual({
      kind: "invalid",
      reason: "query"
    });
  });

  it("names the first part that fails", () => {
    const cases: [string, string][] = [
      ["", "scheme"],
      [id, "scheme"],
      [`https://source/${id}`, "scheme"],
      [`memora:source/${id}`, "scheme"],
      [` memora://source/${id}`, "scheme"],
      [`memora://source/${id}#passage=${chunk}${"a".repeat(400)}`, "scheme"],
      ["memora://", "kind"],
      [`memora://wiki/${id}`, "kind"],
      [`memora://topics/${id}`, "kind"],
      [`memora://topic:80/${id}`, "kind"],
      [`memora://user@topic/${id}`, "kind"],
      ["memora://home", "kind"],
      ["memora://settings/privacy", "kind"],
      [`memora://open/topic/${id}`, "kind"],
      [`memora://open/settings/${id}`, "kind"],
      [`memora://open/note/${id}`, "kind"],
      ["memora://open", "kind"],
      ["memora://source", "id"],
      ["memora://source/", "id"],
      ["memora://source/not-a-uuid", "id"],
      [`memora://source/${id}/`, "id"],
      [`memora://source/${id}/extra`, "id"],
      [`memora://source/${id} `, "id"],
      [`memora://source/${id.slice(1)}`, "id"],
      ["memora://open/source", "id"],
      ["memora://open/source/not-a-uuid", "id"],
      [`memora://open/source/${id}/extra`, "id"],
      [`memora://open/wiki/${id}/`, "id"],
      [`memora://source/${id}#`, "anchor"],
      [`memora://source/${id}#unknown=${chunk}`, "anchor"],
      [`memora://source/${id}#passage=${chunk}&passage=${chunk}`, "anchor"],
      [`memora://source/${id}#relation=not-a-uuid`, "anchor"],
      [`memora://source/${id}#passage=${chunk}?x=1`, "anchor"],
      [`memora://open/source/${id}#relation=${relation}`, "anchor"],
      [`memora://topic/${id}?revision=${id}`, "query"],
      [`memora://source/${id}?relation=${relation}`, "query"],
      [`memora://open/source/${id}?`, "query"],
      [`memora://open/source/${id}?relation`, "query"],
      [`memora://open/source/${id}?relation=`, "query"],
      [`memora://open/source/${id}?relation=not-a-uuid`, "query"],
      [`memora://open/source/${id}?relation=${relation}&relation=${relation}`, "query"],
      [`memora://open/source/${id}?revision=${chunk}`, "query"],
      [`memora://open/source/${id}?relation=${relation}&delete=true`, "query"],
      [`memora://open/wiki/${id}?relation=${relation}`, "query"],
      [`memora://open/wiki/${id}?delete=true`, "query"],
      [`memora://open/wiki/${id}?revision=${chunk}&revision=${chunk}`, "query"],
      [`memora://open/wiki/${id}?revision=not-a-uuid`, "query"]
    ];
    for (const [raw, reason] of cases)
      expect(normalizeMemoraLink(raw), raw).toEqual({ kind: "invalid", reason });
  });
});
