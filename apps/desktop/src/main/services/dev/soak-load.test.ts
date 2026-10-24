import { describe, expect, it } from "vitest";

import {
  descendantsOf,
  parseMemoryFreePercent,
  parseMemoryPressureLevel,
  parseProcessTable,
  readLoad,
  topForeignProcesses
} from "./soak-load.js";

const table = [
  "    1     0   0.0   9000 /sbin/launchd",
  "  500     1   2.0 800000 /Applications/Memora Eterna.app/Contents/MacOS/Memora Eterna",
  "  501   500  35.5 600000 /Applications/Memora Eterna.app/Helper (Renderer)",
  "  502   500  80.0 2400000 /opt/memora/mlx-helper",
  "  503   502   1.0  90000 /opt/memora/postgres",
  "  900     1  95.2 1500000 /usr/local/bin/node",
  "  901   900  60.1  700000 /Users/me/.nvm/bin/node",
  "  950     1   3.0  100000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "  960     1   7.4  250000 /usr/bin/swift-build"
].join("\n");

describe("the load ledger", () => {
  it("reads the memory pressure level and the free percentage", () => {
    expect(parseMemoryPressureLevel("1\n")).toBe("normal");
    expect(parseMemoryPressureLevel("2")).toBe("warn");
    expect(parseMemoryPressureLevel("4")).toBe("critical");
    expect(parseMemoryPressureLevel("")).toBeNull();
    expect(parseMemoryFreePercent("System-wide memory free percentage: 62%\n")).toBe(62);
    expect(parseMemoryFreePercent("nothing")).toBeNull();
  });

  it("reads a process table, commands with spaces included", () => {
    const rows = parseProcessTable(table);
    expect(rows).toHaveLength(9);
    expect(rows[1]).toEqual({
      pid: 500,
      ppid: 1,
      cpuPercent: 2,
      rssKb: 800000,
      command: "/Applications/Memora Eterna.app/Contents/MacOS/Memora Eterna"
    });
  });

  it("leaves out the soak's own processes: the app and everything it started", () => {
    const rows = parseProcessTable(table);
    expect([...descendantsOf(rows, 500)].sort()).toEqual([500, 501, 502, 503]);
    expect(topForeignProcesses(rows, 500).map((row) => [row.command, row.cpuPercent])).toEqual([
      ["node", 95.2],
      ["node", 60.1],
      ["swift-build", 7.4]
    ]);
  });

  it("keeps the busiest few and drops quiet ones", () => {
    const rows = parseProcessTable(table);
    expect(topForeignProcesses(rows, 500, { limit: 1 })).toHaveLength(1);
    expect(
      topForeignProcesses(rows, 500, { minCpuPercent: 50 }).map((row) => row.cpuPercent)
    ).toEqual([95.2, 60.1]);
  });

  it("reads all three commands and survives one that fails", async () => {
    const outputs: Record<string, string> = {
      "/bin/ps": table,
      "/usr/sbin/sysctl": "2\n",
      "/usr/bin/memory_pressure": "System-wide memory free percentage: 41%\n"
    };
    const reading = await readLoad({
      ownPid: 500,
      loadAverage: () => [1.234, 2.5, 3],
      exec: async (file) => {
        if (file === "/usr/bin/memory_pressure") throw new Error("not found");
        return { stdout: outputs[file] ?? "" };
      }
    });
    expect(reading).toMatchObject({
      loadAverage: [1.23, 2.5, 3],
      memoryPressure: "warn",
      memoryFreePercent: null
    });
    expect(reading.top[0]).toMatchObject({ command: "node", cpuPercent: 95.2, rssMb: 1464.8 });
  });
});
