import { describe, expect, it, vi } from "vitest";

import { followedTopic, hoistAction } from "./destinations/explore/ExploreNavigator";
import { pinOf, togglePin, topAddress } from "./pin-object";
import { defaultWorkspace, reduce } from "./state";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function explore(...addresses: string[]) {
  let state = reduce(defaultWorkspace("2026-11-12"), { type: "go", destination: "explore" });
  addresses.forEach((address, index) => {
    state = reduce(state, { type: "open", address, from: index - 1, mode: "push" });
  });
  return state;
}

describe("the tree follows the top panel", () => {
  it("follows a topic, and nothing for another kind or an empty stack", () => {
    expect(followedTopic(explore())).toBeNull();
    expect(followedTopic(explore(`memora://note/${uuid(21)}`))).toBeNull();
    expect(followedTopic(explore(`memora://note/${uuid(21)}`, `memora://topic/${uuid(4)}`))).toBe(
      uuid(4)
    );
  });

  it("hoists only to a topic that is the top panel", () => {
    expect(hoistAction(explore(`memora://source/${uuid(11)}`))).toBeNull();
    expect(hoistAction(explore(`memora://topic/${uuid(4)}`))).toEqual({
      type: "hoist",
      topicId: uuid(4)
    });
  });

  it("keeps the hoist in the workspace until the whole tree is asked for", () => {
    let state = explore(`memora://topic/${uuid(4)}`);
    state = reduce(state, hoistAction(state)!);
    expect(state.hoist).toBe(uuid(4));
    state = reduce(state, { type: "hoist", topicId: null });
    expect(state.hoist).toBeNull();
  });
});

describe("pinning the top panel's object", () => {
  it("names the top panel's address, or none while the root is on top", () => {
    expect(topAddress(explore())).toBeNull();
    expect(topAddress(explore(`memora://topic/${uuid(4)}`))).toBe(`memora://topic/${uuid(4)}`);
  });

  it("offers a pin for an object address and none for a view", () => {
    expect(pinOf(`memora://note/${uuid(21)}`)).toBeTypeOf("function");
    expect(pinOf("memora://explore")).toBeUndefined();
    expect(pinOf("memora://search?q=x")).toBeUndefined();
  });

  it("pins an object that is not pinned and unpins one that is", async () => {
    const address = `memora://note/${uuid(21)}`;
    const setPinned = vi.fn(() => Promise.resolve(null));
    const list = vi.fn(() => Promise.resolve([{ address, pinned: false }]));
    expect(await togglePin({ list, setPinned }, address)).toBe(true);
    expect(setPinned).toHaveBeenLastCalledWith(address, true);
    list.mockResolvedValueOnce([{ address, pinned: true }]);
    expect(await togglePin({ list, setPinned }, address)).toBe(false);
    expect(setPinned).toHaveBeenLastCalledWith(address, false);
    // An object the history has not recorded yet is pinned too.
    list.mockResolvedValueOnce([]);
    expect(await togglePin({ list, setPinned }, address)).toBe(true);
    expect(await togglePin({ list, setPinned }, "not an address")).toBeNull();
  });
});
