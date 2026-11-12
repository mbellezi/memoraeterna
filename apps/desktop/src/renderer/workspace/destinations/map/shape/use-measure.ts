import { useEffect, useState } from "react";

import { createMeasure, type MeasureText } from "./icicle-fit";

/**
 * The text measuring function of an icicle's labels, in the font they are drawn in. It is built
 * again once the fonts are loaded, because the fallback font is not as wide as the one that
 * replaces it: a label that fit before the fonts came must be fitted again after (design record
 * §18, "all measure after fonts load").
 */
export function useMeasure(font: string): MeasureText {
  const [measure, setMeasure] = useState<MeasureText>(() => createMeasure(font));
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return undefined;
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setMeasure(() => createMeasure(font));
    });
    return () => {
      live = false;
    };
  }, [font]);
  return measure;
}
