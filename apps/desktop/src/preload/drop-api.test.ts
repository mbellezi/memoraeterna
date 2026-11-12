import { describe, expect, it, vi } from "vitest";

import { dropChannels } from "../shared/ipc-drop.js";
import { createDropApi } from "./drop-api.js";

const token = "8f2f9a3e-6a64-4c24-9b4a-0c2f5b6f3b11";
const ready = (name: string) => ({
  status: "ready" as const,
  fileToken: token,
  name,
  size: 10,
  kind: "pdf" as const,
  mimeType: "application/pdf",
  draft: { sourceType: "GenericDocument", values: {}, provenance: {}, warnings: [] }
});
const file = (name: string) => ({ name }) as File;

describe("the drop bridge (T150)", () => {
  it("sends only the resolved paths to main and returns the results in the files' order", async () => {
    const invoke = vi.fn(async (_channel: string, payload: unknown) => {
      const { paths } = payload as { paths: string[] };
      return paths.map((path) => ready(path.split("/").pop()!));
    });
    const pathOf = (item: File) => `/Users/a/${item.name}`;
    const results = await createDropApi({ invoke }, pathOf)([file("a.pdf"), file("b.pdf")]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(dropChannels.prepare, {
      paths: ["/Users/a/a.pdf", "/Users/a/b.pdf"]
    });
    expect(results.map((result) => (result.status === "ready" ? result.name : null))).toEqual([
      "a.pdf",
      "b.pdf"
    ]);
  });

  it("returns no path to the page", async () => {
    const invoke = vi.fn(async () => [ready("a.pdf")]);
    const results = await createDropApi({ invoke }, () => "/Users/segredo/a.pdf")([file("a.pdf")]);
    expect(JSON.stringify(results)).not.toContain("segredo");
  });

  it("refuses an item that is not a file on disk without asking main", async () => {
    const invoke = vi.fn(async () => []);
    const results = await createDropApi({ invoke }, () => "")([file("colada.png")]);
    expect(invoke).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "refused", name: "colada.png", reason: "notAFile" }]);
  });

  it("refuses an item whose path cannot be read and sends the rest", async () => {
    const invoke = vi.fn(async () => [ready("b.pdf")]);
    const pathOf = (item: File) => {
      if (item.name === "a.pdf") throw new Error("not a file");
      return `/Users/a/${item.name}`;
    };
    const results = await createDropApi({ invoke }, pathOf)([file("a.pdf"), file("b.pdf")]);
    expect(invoke).toHaveBeenCalledWith(dropChannels.prepare, { paths: ["/Users/a/b.pdf"] });
    expect(results[0]).toEqual({ status: "refused", name: "a.pdf", reason: "notAFile" });
    expect(results[1]).toMatchObject({ status: "ready", name: "b.pdf" });
  });

  it("never sends more files than one call takes", async () => {
    const invoke = vi.fn(async (_channel: string, payload: unknown) =>
      (payload as { paths: string[] }).paths.map(() => ready("x.pdf"))
    );
    const many = Array.from({ length: 30 }, (_, index) => file(`f${index}.pdf`));
    const results = await createDropApi({ invoke }, (item) => `/a/${item.name}`)(many);
    expect((invoke.mock.calls[0]![1] as { paths: string[] }).paths).toHaveLength(20);
    expect(results).toHaveLength(20);
  });

  it("rejects a response that does not match its schema", async () => {
    const invoke = vi.fn(async () => [{ status: "ready", fileToken: "not-a-uuid" }]);
    await expect(createDropApi({ invoke }, () => "/a/b.pdf")([file("b.pdf")])).rejects.toThrow();
  });
});
