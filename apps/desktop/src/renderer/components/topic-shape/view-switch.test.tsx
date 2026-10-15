import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { nextTab, ViewSwitch } from "./ViewSwitch";

const items = [{}, { disabled: true }, {}, {}];

describe("moving between tabs", () => {
  it("steps to the next and previous enabled tab, wrapping round", () => {
    expect(nextTab(items, 0, "ArrowRight")).toBe(2);
    expect(nextTab(items, 2, "ArrowRight")).toBe(3);
    expect(nextTab(items, 3, "ArrowRight")).toBe(0);
    expect(nextTab(items, 0, "ArrowLeft")).toBe(3);
    expect(nextTab(items, 2, "ArrowLeft")).toBe(0);
  });

  it("goes to the first and last enabled tab with Home and End", () => {
    expect(nextTab(items, 2, "Home")).toBe(0);
    expect(nextTab([{ disabled: true }, {}, {}], 2, "Home")).toBe(1);
    expect(nextTab(items, 0, "End")).toBe(3);
    expect(nextTab([{}, {}, { disabled: true }], 0, "End")).toBe(1);
  });

  it("leaves every other key alone and has nowhere to go without an enabled tab", () => {
    expect(nextTab(items, 0, "ArrowDown")).toBeNull();
    expect(nextTab(items, 0, "Enter")).toBeNull();
    expect(nextTab([{ disabled: true }], 0, "ArrowRight")).toBeNull();
    expect(nextTab([], 0, "Home")).toBeNull();
  });
});

describe("the tab list", () => {
  const html = renderToString(
    <ViewSwitch
      label="Lens"
      value="shape"
      idPrefix="lens"
      onChange={() => undefined}
      items={[
        { id: "shape", label: "Shape" },
        { id: "atlas", label: "Atlas", note: "later", disabled: true }
      ]}
    />
  );

  it("is one tab stop with the selected tab in it, controlling its panel", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Lens"');
    expect(html).toMatch(
      /id="lens-tab-shape"[^>]*aria-selected="true"[^>]*aria-controls="lens-panel-shape"[^>]*tabindex="0"/
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it("shows a tab that is not available yet as disabled, with the reason beside its label", () => {
    expect(html).toMatch(/id="lens-tab-atlas"[^>]*aria-selected="false"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Atlas/);
    expect(html).toContain("· later");
    expect(html).not.toContain("lens-panel-atlas");
  });
});
