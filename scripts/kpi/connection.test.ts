import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeConnectionString, parseKpiArgs, resolveConnection } from "./connection.js";

describe("parseKpiArgs", () => {
  it("parses a full command", () => {
    expect(
      parseKpiArgs([
        "--db",
        "conn.json",
        "--out",
        "kpi.md",
        "--json",
        "kpi.json",
        "--label",
        "owner",
        "--as-of",
        "2026-09-12T06:00:00Z",
        "--stuck-minutes",
        "30"
      ])
    ).toEqual({
      kind: "run",
      db: "conn.json",
      out: "kpi.md",
      json: "kpi.json",
      label: "owner",
      asOf: new Date("2026-09-12T06:00:00Z"),
      stuckMinutes: 30
    });
  });

  it("defaults to stdout, the latest recorded activity and a 15 minute threshold", () => {
    expect(parseKpiArgs(["--db", "postgres://u@h/d"])).toMatchObject({
      out: null,
      json: null,
      label: null,
      asOf: null,
      stuckMinutes: 15
    });
  });

  it("accepts the keyword now and shows help", () => {
    expect(parseKpiArgs(["--db", "x", "--as-of", "now"])).toMatchObject({ asOf: "now" });
    expect(parseKpiArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("rejects a missing database, bad numbers, bad dates and unknown flags", () => {
    expect(() => parseKpiArgs([])).toThrow("--db is required");
    expect(() => parseKpiArgs(["--db", "x", "--stuck-minutes", "0"])).toThrow("--stuck-minutes");
    expect(() => parseKpiArgs(["--db", "x", "--stuck-minutes", "abc"])).toThrow("--stuck-minutes");
    expect(() => parseKpiArgs(["--db", "x", "--as-of", "yesterday"])).toThrow("--as-of");
    expect(() => parseKpiArgs(["--db", "x", "--bogus"])).toThrow();
  });
});

describe("describeConnectionString", () => {
  it("returns host, port and database without the credentials", () => {
    const info = describeConnectionString(
      "postgresql://memora_app:s3cret@127.0.0.1:61108/memora_app"
    );
    expect(info).toEqual({ host: "127.0.0.1", port: 61108, name: "memora_app" });
    expect(JSON.stringify(info)).not.toContain("s3cret");
  });

  it("rejects other schemes and garbage", () => {
    expect(() => describeConnectionString("mysql://u@h/d")).toThrow("postgres://");
    expect(() => describeConnectionString("not a url")).toThrow("not a valid");
  });
});

describe("resolveConnection", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "kpi-connection-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const write = async (name: string, content: unknown) => {
    const path = join(directory, name);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };

  it("accepts a postgres URL", async () => {
    const result = await resolveConnection("postgres://user:pw@127.0.0.1:5999/db");
    expect(result.connectionString).toBe("postgres://user:pw@127.0.0.1:5999/db");
    expect(result.info).toEqual({ host: "127.0.0.1", port: 5999, name: "db", provenance: null });
    expect(result.label).toBeNull();
  });

  it("reads a scratch connection file with its provenance", async () => {
    const path = await write("running.json", {
      slug: "owner",
      status: "running",
      connectionString: "postgresql://memora_app:pw@127.0.0.1:61108/memora_app",
      restored: {
        sourcePath:
          "/home/someone/repo/.cache/automatic-wiki-20260912/dev-clean-wiki-before-a8.dump",
        sha256: "a".repeat(64),
        dumpCreatedAt: "2026-09-12 23:39:28 BST"
      }
    });
    const result = await resolveConnection(path);
    expect(result.label).toBe("owner");
    expect(result.info).toEqual({
      host: "127.0.0.1",
      port: 61108,
      name: "memora_app",
      provenance: {
        sourceName: "automatic-wiki-20260912/dev-clean-wiki-before-a8.dump",
        sha256: "a".repeat(64),
        dumpCreatedAt: "2026-09-12 23:39:28 BST"
      }
    });
    expect(JSON.stringify(result.info)).not.toContain("pw");
  });

  it("refuses a stopped cluster because its port is stale", async () => {
    const path = await write("stopped.json", {
      status: "stopped",
      connectionString: "postgresql://u:pw@127.0.0.1:1/d"
    });
    await expect(resolveConnection(path)).rejects.toThrow("is stopped");
  });

  it("reports unreadable, malformed and incomplete files without echoing their content", async () => {
    await expect(resolveConnection(join(directory, "missing.json"))).rejects.toThrow("Cannot read");
    await expect(resolveConnection(await write("bad.json", "{ nope"))).rejects.toThrow(
      "not valid JSON"
    );
    await expect(resolveConnection(await write("empty.json", {}))).rejects.toThrow(
      'no "connectionString"'
    );
  });
});
