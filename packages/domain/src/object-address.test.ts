import { describe, expect, it } from "vitest";

import {
  ObjectLocateInputSchema,
  ObjectLocateResultSchema,
  formatObjectAddress,
  objectKinds,
  parseObjectAddress
} from "./object-address.js";

const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const chunk = "11111111-2222-4333-8444-555555555555";
const span = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const section = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

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
      { section, span, passage: chunk }
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
    primaryPath: [ref("source", 1), ref("source", 2), ref("note", 3)],
    alsoIn: [{ ...ref("topic", 4), legacy: true }],
    citedBy: [],
    counts: { alsoIn: 1, citedBy: 0, notes: 0, passages: 2, children: 0 }
  };

  it("accepts the stable shape and keeps it closed", () => {
    expect(ObjectLocateResultSchema.parse(result)).toEqual(result);
    expect(ObjectLocateResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(ObjectLocateResultSchema.safeParse({ ...result, primaryPath: [] }).success).toBe(false);
    expect(
      ObjectLocateResultSchema.safeParse({ ...result, alsoIn: [ref("topic", 4)] }).success
    ).toBe(false);
    expect(
      ObjectLocateResultSchema.safeParse({
        ...result,
        counts: { ...result.counts, children: -1 }
      }).success
    ).toBe(false);
  });
});
