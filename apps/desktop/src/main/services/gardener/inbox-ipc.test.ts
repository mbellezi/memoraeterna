import { describe, expect, it, vi } from "vitest";

import { emptyInboxCounts } from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerInboxIpc, type InboxPort } from "./inbox-ipc.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function register() {
  const handlers = new Map<string, Handler>();
  const service = {
    list: vi.fn<InboxPort["list"]>(async () => ({ items: [], nextCursor: null })),
    counts: vi.fn<InboxPort["counts"]>(async () => emptyInboxCounts()),
    act: vi.fn<InboxPort["act"]>(async () => ({ status: "done", undoable: false }))
  };
  registerInboxIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
    service
  );
  return {
    handlers,
    service,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  };
}

describe("inbox.* handlers", () => {
  it("registers the three channels and no others", () => {
    expect([...register().handlers.keys()].sort()).toEqual(
      [ipcChannels.inboxAct, ipcChannels.inboxCounts, ipcChannels.inboxList].sort()
    );
  });

  it("lists with the defaults of a request that names nothing, and passes a valid one on", async () => {
    const { service, call } = register();
    await call(ipcChannels.inboxList);
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50 });
    await call(ipcChannels.inboxList, { kinds: ["review"], risk: "high", limit: 10 });
    expect(service.list).toHaveBeenLastCalledWith({ kinds: ["review"], risk: "high", limit: 10 });
  });

  it("refuses a request that does not match its contract before the service sees it", () => {
    const { service, call } = register();
    expect(() => call(ipcChannels.inboxList, { limit: 500 })).toThrow();
    expect(() => call(ipcChannels.inboxList, { kinds: ["mystery"] })).toThrow();
    expect(() => call(ipcChannels.inboxList, { extra: true })).toThrow();
    expect(() => call(ipcChannels.inboxCounts, "unexpected")).toThrow();
    expect(() =>
      call(ipcChannels.inboxAct, { kind: "review", id: "x", action: "merge" })
    ).toThrow();
    expect(() => call(ipcChannels.inboxAct, undefined)).toThrow();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.counts).not.toHaveBeenCalled();
    expect(service.act).not.toHaveBeenCalled();
  });

  it("reads the counts and carries a verb out through the service", async () => {
    const { service, call } = register();
    expect(await call(ipcChannels.inboxCounts)).toEqual(emptyInboxCounts());
    expect(
      await call(ipcChannels.inboxAct, { kind: "duplicate", id: "abc", action: "dismiss" })
    ).toEqual({
      status: "done",
      undoable: false
    });
    expect(service.act).toHaveBeenCalledWith({ kind: "duplicate", id: "abc", action: "dismiss" });
  });
});
