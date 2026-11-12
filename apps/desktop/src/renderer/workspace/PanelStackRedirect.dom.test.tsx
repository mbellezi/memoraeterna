// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "./test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { destinationRoots } from "./destinations";
import { PanelStack, type PanelModule, type PanelProps } from "./PanelStack";
import { defaultWorkspace, reduce, type WorkspaceAction } from "./state";

// A panel whose object lives at another address (a merged topic) swaps its own history entry: the
// host gives it `onRedirect`, which is the reducer's `redirect` for the panel's own index.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const retired = `memora://topic/${uuid(1)}`;
const earlier = `memora://note/${uuid(3)}`;
const current = `memora://topic/${uuid(2)}`;

let dom: TestDom;
let props: PanelProps | null = null;

beforeEach(() => {
  dom = createTestDom();
  props = null;
});
afterEach(async () => {
  await dom.dispose();
});

const registry: readonly PanelModule[] = [
  {
    kind: "topic",
    match: (address) => address.startsWith("memora://topic/"),
    title: () => "",
    Component: (own) => {
      props = own;
      return <p data-surface="topic" />;
    }
  },
  { kind: "root", match: () => true, title: () => "", Component: () => <p data-surface="root" /> }
];

describe("a panel's redirect", () => {
  it("is the redirect action for the panel's own index, and Back does not return to the retired id", async () => {
    const workspace = defaultWorkspace("2026-11-11");
    workspace.destination = "explore";
    workspace.stacks.explore = {
      root: destinationRoots.explore,
      panels: [{ id: "p0", history: [earlier, retired], index: 1 }],
      focus: 0,
      closed: []
    };
    const dispatch = vi.fn();
    await dom.render(
      <PanelStack
        t={createTranslator("en")}
        workspace={workspace}
        dispatch={dispatch}
        viewportWidth={1440}
        chrome={{ navigator: true, context: false }}
        registry={registry}
      />
    );
    expect(typeof props?.onRedirect).toBe("function");
    await dom.act(() => props?.onRedirect?.(current));
    const action = dispatch.mock.calls[0]?.[0] as WorkspaceAction;
    expect(action).toEqual({ type: "redirect", panel: 0, to: current });

    const after = reduce(workspace, action);
    expect(after.stacks.explore.panels[0]).toMatchObject({ history: [earlier, current], index: 1 });
    // Back leaves the retired id out of the trail: it goes to the note, and Forward to the current id.
    const back = reduce(after, { type: "back" });
    expect(back.stacks.explore.panels[0]).toMatchObject({ history: [earlier, current], index: 0 });
    const forward = reduce(back, { type: "forward" });
    expect(forward.stacks.explore.panels[0]).toMatchObject({ index: 1 });
  });
});
