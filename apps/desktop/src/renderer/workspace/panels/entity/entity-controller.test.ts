import { describe, expect, it, vi } from "vitest";

import type { EntitiesPageInput, EntityPage } from "../../../../shared/ipc-entities";
import { EntityPageController } from "./entity-controller";
import { entityFirstPage, entitySecondPage } from "./entity-fixtures";

const id = entityFirstPage.entity.id;

/** An `entities.page` whose every call waits until the test answers it. */
function deferredApi() {
  const calls: {
    input: EntitiesPageInput;
    resolve: (page: EntityPage | null) => void;
    reject: () => void;
  }[] = [];
  const page = vi.fn(
    (input: EntitiesPageInput) =>
      new Promise<EntityPage | null>((resolve, reject) => {
        calls.push({ input, resolve, reject: () => reject(new Error("fails")) });
      })
  );
  return { api: { page }, calls, page };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function make() {
  const fake = deferredApi();
  const controller = new EntityPageController({ api: () => fake.api });
  return { ...fake, controller };
}

describe("EntityPageController", () => {
  it("reads the first page when it is shown and says ready", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    expect(controller.getSnapshot()).toEqual({ status: "loading" });
    expect(calls.map((call) => call.input)).toEqual([{ id }]);
    calls[0]?.resolve(entityFirstPage);
    await settle();
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      page: entityFirstPage,
      more: "idle"
    });
  });

  it("reads nothing while hidden, and reads once when first shown", async () => {
    const { controller, page } = make();
    controller.show(id, false);
    controller.reread();
    expect(page).not.toHaveBeenCalled();
    controller.show(id, true);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("says a gone entity is missing and a failed first read is an error that retries from the skeleton", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    calls[0]?.resolve(null);
    await settle();
    expect(controller.getSnapshot()).toEqual({ status: "missing" });

    const other = make();
    other.controller.show(id, true);
    other.calls[0]?.reject();
    await settle();
    expect(other.controller.getSnapshot()).toEqual({ status: "error" });
    other.controller.retry();
    expect(other.controller.getSnapshot()).toEqual({ status: "loading" });
    other.calls[1]?.resolve(entityFirstPage);
    await settle();
    expect(other.controller.getSnapshot().status).toBe("ready");
  });

  it("keeps the page that is shown while it reads again and when that read fails", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    calls[0]?.resolve(entityFirstPage);
    await settle();
    controller.reread();
    expect(controller.getSnapshot().status).toBe("ready");
    calls[1]?.reject();
    await settle();
    expect(controller.getSnapshot()).toEqual({
      status: "ready",
      page: entityFirstPage,
      more: "idle"
    });
  });

  it("asks for one more read, not one per change, while a read is under way, and the newest wins", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    calls[0]?.resolve(entityFirstPage);
    await settle();
    controller.reread();
    controller.reread();
    controller.reread();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(entityFirstPage);
    await settle();
    expect(calls).toHaveLength(3);
    const newer = { ...entityFirstPage, counts: { notes: 12, sources: 4 } };
    calls[2]?.resolve(newer);
    await settle();
    expect(controller.getSnapshot()).toEqual({ status: "ready", page: newer, more: "idle" });
  });

  it("leaves a failed first read for its retry when a change arrives", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    calls[0]?.reject();
    await settle();
    controller.reread();
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot()).toEqual({ status: "error" });
  });

  it("reads again in place when shown after a change that came while hidden", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    calls[0]?.resolve(entityFirstPage);
    await settle();
    controller.show(id, false);
    controller.reread();
    expect(calls).toHaveLength(1);
    controller.show(id, true);
    expect(calls).toHaveLength(2);
    expect(controller.getSnapshot().status).toBe("ready");
  });

  it("starts over for another entity and drops the answer of the one before", async () => {
    const { controller, calls } = make();
    controller.show(id, true);
    controller.show("00000000-0000-4000-8000-000000000099", true);
    expect(calls).toHaveLength(2);
    calls[0]?.resolve(entityFirstPage);
    await settle();
    expect(controller.getSnapshot()).toEqual({ status: "loading" });
  });

  describe("more mentions", () => {
    async function loaded() {
      const made = make();
      made.controller.show(id, true);
      made.calls[0]?.resolve(entityFirstPage);
      await settle();
      return made;
    }

    it("reads the next page by the cursor, one request at a time, and appends it", async () => {
      const { controller, calls } = await loaded();
      controller.loadMore();
      controller.loadMore();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.input).toEqual({ id, cursor: "cursor-2" });
      expect(controller.getSnapshot()).toMatchObject({ status: "ready", more: "loading" });
      calls[1]?.resolve(entitySecondPage);
      await settle();
      const load = controller.getSnapshot();
      expect(load.status === "ready" && load.page.mentions.items).toHaveLength(11);
      expect(load).toMatchObject({ more: "idle" });
    });

    it("says it failed and lets the person ask again", async () => {
      const { controller, calls } = await loaded();
      controller.loadMore();
      calls[1]?.reject();
      await settle();
      expect(controller.getSnapshot()).toMatchObject({ status: "ready", more: "error" });
      controller.loadMore();
      expect(calls).toHaveLength(3);
    });

    it("does nothing when there is no cursor", async () => {
      const { controller, calls } = await loaded();
      controller.loadMore();
      calls[1]?.resolve(entitySecondPage);
      await settle();
      controller.loadMore();
      expect(calls).toHaveLength(2);
    });

    it("drops an answer that belongs to a page that was read again, and can ask again", async () => {
      const { controller, calls } = await loaded();
      controller.loadMore();
      controller.reread();
      calls[2]?.resolve(entityFirstPage);
      await settle();
      calls[1]?.resolve(entitySecondPage);
      await settle();
      const load = controller.getSnapshot();
      expect(load.status === "ready" && load.page.mentions.items).toHaveLength(8);
      expect(load).toMatchObject({ more: "idle" });
    });
  });
});
