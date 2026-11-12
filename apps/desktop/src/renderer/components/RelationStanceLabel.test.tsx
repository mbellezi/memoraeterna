import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { RelationStanceLabel } from "./RelationStanceLabel";

const pt = createTranslator("pt-BR");

describe("the stance label", () => {
  it("keeps the directional phrase from 480 px and lets it wrap at a word, the bare verb only below", () => {
    const html = renderToString(
      <RelationStanceLabel type="supports" t={pt} phrase="esta nota apoia" />
    );
    // The phrase may take two lines ("esta nota / apoia"), so it wraps and the glyph stays on the first.
    expect(html).toContain("whitespace-normal @min-[480px]:inline");
    expect(html).toContain("esta nota apoia");
    expect(html).toContain("@min-[480px]:hidden");
    expect(html).toContain("items-start");
  });

  it("is one line of glyph and word without a phrase", () => {
    const html = renderToString(<RelationStanceLabel type="supports" t={pt} />);
    expect(html).toContain("items-center");
    expect(html).not.toContain("@min-[480px]");
  });
});
