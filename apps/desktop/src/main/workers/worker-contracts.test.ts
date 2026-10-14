import { describe, expect, it } from "vitest";

import { workerErrorMessage, workerFailure, workerMessageSchema } from "./worker-contracts.js";

describe("worker failure messages", () => {
  it("carry the message and the error code of a filesystem or database failure", () => {
    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    expect(workerMessageSchema.parse(workerErrorMessage(busy))).toEqual({
      kind: "error",
      error: "EBUSY: resource busy or locked",
      code: "EBUSY"
    });
    expect(workerErrorMessage(Object.assign(new Error("deadlock"), { code: "40P01" }))).toEqual({
      kind: "error",
      error: "deadlock",
      code: "40P01"
    });
  });

  it("find the code on the cause of a wrapping error", () => {
    const failure = new Error("sync failed", {
      cause: Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" })
    });
    expect(workerErrorMessage(failure)).toMatchObject({ error: "sync failed", code: "EMFILE" });
  });

  it("leave out a code that is not a short string and name a failure that has no message", () => {
    expect(workerErrorMessage(Object.assign(new Error("x"), { code: 12 }))).toEqual({
      kind: "error",
      error: "x"
    });
    expect(workerErrorMessage(Object.assign(new Error("x"), { code: "E".repeat(65) }))).toEqual({
      kind: "error",
      error: "x"
    });
    expect(workerErrorMessage(new Error(""))).toEqual({ kind: "error", error: "worker_failed" });
    expect(workerErrorMessage("text")).toEqual({ kind: "error", error: "worker_failed" });
  });

  it("rebuild an error whose code survives the boundary", () => {
    const rebuilt = workerFailure({ error: "EAGAIN: try again", code: "EAGAIN" });
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt).toMatchObject({ message: "EAGAIN: try again", code: "EAGAIN" });
    expect(workerFailure({ error: "plain" })).not.toHaveProperty("code");
  });
});
