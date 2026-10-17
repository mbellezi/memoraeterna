import { aiClassIds, presetCatalogIds } from "@app/domain";
import { describe, expect, it } from "vitest";

import { aiWorkloadClassSchema } from "./contracts.js";
import { findLocalModelCatalogEntry } from "./local-model-catalog.js";
import { isRankerCatalogEntry } from "./ranker-validation.js";

describe("the preset catalog entries (domain constants checked against the catalog)", () => {
  it("names the scheduler's workload classes", () => {
    expect([...aiClassIds].toSorted()).toEqual([...aiWorkloadClassSchema.options].toSorted());
  });

  it("names catalog entries of the runtime each preset expects", () => {
    const entry = (id: string) => findLocalModelCatalogEntry(id);
    expect(entry(presetCatalogIds.embedding)).toMatchObject({
      runtime: "gguf",
      capabilities: expect.arrayContaining(["embedding"])
    });
    expect(entry(presetCatalogIds.rankerMlx)).toMatchObject({ runtime: "mlx" });
    expect(entry(presetCatalogIds.rankerGguf)).toMatchObject({ runtime: "gguf" });
    for (const id of [presetCatalogIds.rankerMlx, presetCatalogIds.rankerGguf])
      expect(isRankerCatalogEntry(entry(id)!)).toBe(true);
    for (const id of [presetCatalogIds.writerLarge, presetCatalogIds.writerSmall])
      expect(entry(id)).toMatchObject({
        runtime: "mlx",
        capabilities: expect.arrayContaining(["text-generation", "structured-output"])
      });
  });
});
