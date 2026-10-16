import { describe, expect, it } from "vitest";

import { gateDeciderKey } from "@app/domain/topic-tree";

import {
  AdoptedFileSchema,
  parseSaveCalibrationArgs,
  planCalibrations
} from "./save-calibration.js";

const hash = (text: string): string => `h${text.length}`;
const mlx = {
  catalogId: "mlx-qwen3-reranker-0.6b",
  runtime: "mlx",
  repository: "Qwen/Qwen3-Reranker-0.6B",
  revision: "abc",
  quantization: "bf16"
};
const offlineKey = gateDeciderKey({ ...mlx, instruction: "rank" }, hash);
const adopted = AdoptedFileSchema.parse({
  task: "T29a",
  spaceKey: "space",
  dataset: "env-c:calibration-seeds-7-12",
  gates: [
    {
      catalogId: mlx.catalogId,
      runtime: "mlx",
      deciderKey: offlineKey,
      temperature: 1,
      tau: 2,
      theta: 0.6,
      how: "eligible",
      metrics: { medianAcceptedPrecision: 0.91 }
    },
    {
      catalogId: "gguf-qwen3-reranker-0.6b-q8-0",
      runtime: "gguf",
      deciderKey: "other",
      temperature: 1,
      tau: 1,
      theta: 0.5,
      how: "eligible",
      metrics: {}
    }
  ]
});

describe("save-calibration", () => {
  it("plans one row per installed decider, keyed as the gate keys it", () => {
    const plan = planCalibrations(adopted, [mlx], "rank", hash);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      catalogId: mlx.catalogId,
      deciderKey: offlineKey,
      params: { gate: { temperature: 1, tau: 2, theta: 0.6 } }
    });
    expect(plan.skipped).toEqual([
      { catalogId: "gguf-qwen3-reranker-0.6b-q8-0", reason: "not-installed" }
    ]);
    expect(plan.keyChanged).toEqual([]);
  });

  it("uses the installed artifact's key and reports a change", () => {
    const plan = planCalibrations(adopted, [{ ...mlx, revision: "def" }], "rank", hash);
    expect(plan.rows[0]?.deciderKey).toBe(
      gateDeciderKey({ ...mlx, revision: "def", instruction: "rank" }, hash)
    );
    expect(plan.keyChanged).toEqual([mlx.catalogId]);
  });

  it("parses the arguments", () => {
    expect(parseSaveCalibrationArgs(["--help"])).toEqual({ kind: "help" });
    expect(() => parseSaveCalibrationArgs([])).toThrow(/--db/u);
    const command = parseSaveCalibrationArgs([
      "--db",
      "conn.json",
      "--dry-run",
      "--file",
      "a.json"
    ]);
    expect(command).toMatchObject({ kind: "run", db: "conn.json", dryRun: true });
  });
});
