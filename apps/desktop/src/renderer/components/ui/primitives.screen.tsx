import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { PrimitivesSheet, type PrimitiveSample } from "./primitives-sheet";

export const surface = "primitives";

const t = screenTranslator();

const samples: PrimitiveSample[] = [
  { id: "s1", title: "Lactic fermentation", meta: "Note · 3 min" },
  { id: "s2", title: "Salt, acid and the cold chain", meta: "Source · PDF" },
  { id: "s3", title: "Food preservation", meta: "Topic · 32 notes" },
  { id: "s4", title: "Microbiology of foods, chapter 3", meta: "Source · EPUB" },
  { id: "s5", title: "Why vinegar keeps", meta: "Question" },
  { id: "s6", title: "Brine concentration", meta: "Note · yesterday" }
];

export const fixtures: ScreenModule["fixtures"] = {
  success: { "primitives.samples": samples },
  empty: { "primitives.samples": [] }
};

/** A call path the typed `window.app` does not have: only the fake one of the screens tool answers it. */
const load = (): Promise<readonly PrimitiveSample[]> =>
  (
    window.app as unknown as { primitives: { samples(): Promise<readonly PrimitiveSample[]> } }
  ).primitives.samples();

export function render() {
  return <PrimitivesSheet t={t} load={load} />;
}
