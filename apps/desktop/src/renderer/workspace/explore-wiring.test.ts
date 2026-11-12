import { describe, expect, it, vi } from "vitest";

import {
  viewHistoryListInputSchema,
  viewHistoryPinInputSchema,
  viewHistoryPinLimitMessage,
  viewHistoryRecordInputSchema
} from "../../shared/view-history";

import { followedTopic, hoistAction } from "./destinations/explore/ExploreNavigator";
import {
  historyAddressOf,
  isPinKey,
  isPinned,
  pinFailureOf,
  togglePin,
  topAddress,
  type PinApi
} from "./pin-object";
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

/**
 * A view history that checks what it is given with the schemas the preload runs, as the real one
 * does: a limit past the maximum, an address with an anchor and a pin past the cap are refused.
 */
function checkedHistory(initial: { address: string; pinned: boolean }[] = []) {
  const entries = new Map(initial.map((entry) => [entry.address, entry]));
  const api: PinApi = {
    list: (input = {}) => {
      viewHistoryListInputSchema.parse(input);
      return Promise.resolve([...entries.values()]);
    },
    setPinned: (address, pinned) => {
      const parsed = viewHistoryPinInputSchema.parse({ address, pinned });
      const entry = entries.get(parsed.address);
      if (!entry) return Promise.resolve(null);
      if (pinned && !entry.pinned && [...entries.values()].filter((e) => e.pinned).length >= 10)
        return Promise.reject(new Error(viewHistoryPinLimitMessage));
      entry.pinned = pinned;
      return Promise.resolve(entry);
    },
    record: (input) => {
      const parsed = viewHistoryRecordInputSchema.parse(input);
      const address = `memora://${parsed.kind}/${parsed.id}`;
      entries.set(address, { address, pinned: false });
      return Promise.resolve(null);
    }
  };
  return { api, entries };
}

describe("pinning the top panel's object", () => {
  it("names the top panel's address, or none while the root is on top", () => {
    expect(topAddress(explore())).toBeNull();
    expect(topAddress(explore(`memora://topic/${uuid(4)}`))).toBe(`memora://topic/${uuid(4)}`);
  });

  it("keeps the history's address: the object, never an anchor, and none for a view", () => {
    expect(historyAddressOf(`memora://source/${uuid(11)}#passage=${uuid(5)}`)).toBe(
      `memora://source/${uuid(11)}`
    );
    expect(historyAddressOf("memora://explore")).toBeNull();
    expect(historyAddressOf("memora://search?q=x")).toBeNull();
  });

  it("pins and unpins through a history that refuses what the schema refuses", async () => {
    const address = `memora://note/${uuid(21)}`;
    const { api, entries } = checkedHistory([{ address, pinned: false }]);
    expect(await isPinned(api, address)).toBe(false);
    expect(await togglePin(api, address)).toBe(true);
    expect(entries.get(address)?.pinned).toBe(true);
    expect(await isPinned(api, address)).toBe(true);
    expect(await togglePin(api, address)).toBe(false);
    expect(entries.get(address)?.pinned).toBe(false);
    expect(await togglePin(api, "not an address")).toBeNull();
  });

  it("pins the object of a panel that carries an anchor (a cited passage)", async () => {
    const source = `memora://source/${uuid(11)}`;
    const { api, entries } = checkedHistory([{ address: source, pinned: false }]);
    expect(await togglePin(api, `${source}#passage=${uuid(5)}`)).toBe(true);
    expect(entries.get(source)?.pinned).toBe(true);
  });

  it("records an object the history has not seen yet, a note with its host, then pins it", async () => {
    const topic = `memora://topic/${uuid(4)}`;
    const fresh = checkedHistory();
    expect(await togglePin(fresh.api, topic, { title: "Lactic fermentation" })).toBe(true);
    expect(fresh.entries.get(topic)?.pinned).toBe(true);
    const note = `memora://note/${uuid(21)}`;
    const hosted = checkedHistory();
    const host = vi.fn(() => Promise.resolve(`memora://source/${uuid(11)}`));
    expect(await togglePin(hosted.api, note, { title: "A note", host })).toBe(true);
    expect(hosted.entries.get(note)?.pinned).toBe(true);
    // A note whose source cannot be found cannot be recorded: the pin says so instead of doing nothing.
    const orphan = checkedHistory();
    await expect(
      togglePin(orphan.api, note, { title: "A note", host: () => Promise.resolve(null) })
    ).rejects.toThrow();
  });

  it("tells a pin past the cap apart from any other failure", async () => {
    const pinned = Array.from({ length: 10 }, (_, index) => ({
      address: `memora://note/${uuid(100 + index)}`,
      pinned: true
    }));
    const address = `memora://note/${uuid(21)}`;
    const { api } = checkedHistory([...pinned, { address, pinned: false }]);
    const refused = await togglePin(api, address).catch((error: unknown) => error);
    expect(pinFailureOf(refused)).toBe("limit");
    expect(pinFailureOf(new Error("boom"))).toBe("failed");
  });

  it("answers Cmd-D alone", () => {
    const key = { metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, code: "KeyD" };
    expect(isPinKey(key)).toBe(true);
    expect(isPinKey({ ...key, shiftKey: true })).toBe(false);
    expect(isPinKey({ ...key, metaKey: false })).toBe(false);
    expect(isPinKey({ ...key, code: "KeyF" })).toBe(false);
  });
});
