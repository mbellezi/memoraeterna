import { describe, expect, it } from "vitest";

import { standInCopy, standInCopyTables } from "./panel-screen-copy";
import { fixtureAddresses, panelErrorFixtures } from "./panel-screen-fixtures";

const leaves = (value: unknown, prefix = ""): [string, string][] =>
  typeof value === "string"
    ? [[prefix, value]]
    : Object.entries(value as object).flatMap(([key, item]) =>
        leaves(item, prefix === "" ? key : `${prefix}.${key}`)
      );

describe("the stand-in pages' own sentences", () => {
  it("say every sentence in pt-BR where English has one, none left in English", () => {
    const english = leaves(standInCopyTables.en);
    const portuguese = new Map(leaves(standInCopyTables["pt-BR"]));
    expect([...portuguese.keys()].sort()).toEqual(english.map(([key]) => key).sort());
    // The kind-less meta lines share no whole sentence with English.
    for (const [key, value] of english) expect(portuguese.get(key), key).not.toBe(value);
  });

  it("follow the screen's language and fall back to English", () => {
    expect(standInCopy("pt-BR").error.note.message).toBe("Não foi possível abrir esta nota.");
    expect(standInCopy("pt-BR").empty.note.headline).toBe("Esta nota ainda não tem texto.");
    expect(standInCopy("fr")).toBe(standInCopyTables.en);
  });
});

describe("the error set of the panel stack", () => {
  const set = panelErrorFixtures();

  it("fails only the focused panel's object, once, and lets the other panels and spines load", () => {
    expect(() => set["objects.get"]({ address: fixtureAddresses.topNote })).toThrow();
    expect(() => set["objects.locate"]({ address: fixtureAddresses.topNote })).toThrow();
    expect(set["objects.get"]({ address: fixtureAddresses.topic }).title).toBe(
      "Lactic fermentation"
    );
    expect(set["objects.locate"]({ address: fixtureAddresses.topic }).object.kind).toBe("topic");
    const spines = set["objects.resolveMany"]({
      addresses: [fixtureAddresses.source, fixtureAddresses.topNote]
    });
    expect(Object.keys(spines.items)).toEqual([fixtureAddresses.source]);
  });
});
