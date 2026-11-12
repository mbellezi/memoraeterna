// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../test-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { entityEmptyPage, entityFirstPage } from "./entity-fixtures";
import { EntityPageView, type EntityPageViewProps } from "./EntityPageView";

// What a click on the entity page does, and what its rows give the Space-bar peek.
let dom: TestDom;
const opened: string[] = [];
let loadMore = 0;

const props = (load: EntityPageViewProps["load"]): EntityPageViewProps => ({
  t: createTranslator("en"),
  load,
  mode: "full",
  onOpen: (address) => void opened.push(address),
  onRetry: () => undefined,
  onLoadMore: () => void (loadMore += 1)
});

const ready = (page: typeof entityFirstPage): EntityPageViewProps["load"] => ({
  status: "ready",
  page,
  more: "idle"
});

beforeEach(() => {
  opened.length = 0;
  loadMore = 0;
  dom = createTestDom();
});

afterEach(async () => {
  await dom.dispose();
});

describe("the entity page, in the DOM", () => {
  it("offers a draft, never a sent question: 'Ask about …' opens the Ask with the name in the field", async () => {
    await dom.render(<EntityPageView {...props(ready(entityEmptyPage))} />);
    const button = [...dom.document.querySelectorAll("button")].find((node) =>
      node.textContent?.startsWith("Ask about")
    ) as HTMLElement;
    await dom.act(() => button.click());
    expect(opened).toEqual([
      `memora://ask?draft=${encodeURIComponent(entityEmptyPage.entity.canonicalName)}`
    ]);
  });

  it("loads more mentions from the quiet button under a partial Fontes list", async () => {
    await dom.render(<EntityPageView {...props(ready(entityFirstPage))} />);
    const button = [...dom.document.querySelectorAll("button")].find((node) =>
      node.textContent?.startsWith("Sources of the mentions loaded so far")
    ) as HTMLElement;
    await dom.act(() => button.click());
    expect(loadMore).toBe(1);
  });
});
