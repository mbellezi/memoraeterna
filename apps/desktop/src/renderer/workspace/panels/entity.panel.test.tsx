import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import type { PanelProps } from "../PanelStack";
import { entityFixture } from "./entity/entity-fixtures";

// Server rendering does not run effects: the effect that reports the panel's state and place runs
// as the panel renders, and the bus hooks are not under test here.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => unknown) => {
    effect();
  }
}));
vi.mock("../../lib/app-events", () => ({ useAppEvent: () => undefined }));
vi.mock("../../lib/object-events", () => ({
  useObjectChanged: () => undefined,
  useObjectKindChanged: () => undefined
}));

const { Component, kind, match } = await import("./entity.panel");

describe("the Entity panel", () => {
  it("registers for entity addresses only", () => {
    expect(kind).toBe("entity");
    expect(match(entityFixture.address)).toBe(true);
    expect(match(entityFixture.noteAddress)).toBe(false);
  });

  it("tells its frame the ribbon reads where the entity is most cited", () => {
    const onPlace = vi.fn();
    const props = {
      t: createTranslator("pt-BR"),
      address: entityFixture.address,
      mode: "full",
      active: true,
      onState: vi.fn(),
      onPlace,
      onOpen: vi.fn(),
      current: null
    } as unknown as PanelProps;
    renderToString(<Component {...props} />);
    expect(onPlace).toHaveBeenCalledWith({ place: "mostCited" });
  });
});
