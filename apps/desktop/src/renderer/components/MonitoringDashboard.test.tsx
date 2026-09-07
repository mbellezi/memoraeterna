import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import { CodePanel, MonitoringDashboard } from "./MonitoringDashboard";
const t = createTranslator("en");
describe("Monitoring dashboard", () => {
  it("starts on AI usage with accessible tabs, filters and an explicit loading state", () => {
    const html = renderToString(<MonitoringDashboard enabled={false} fullCapture={false} t={t} onCaptureChange={async () => {}} onOpenSource={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("AI usage");
    expect(html).toContain("Cached input");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No AI calls in this filter");
  });
  it("highlights JSON safely without interpreting model output as HTML", () => {
    const html = renderToString(<CodePanel title="Output" value={'{"html":"<script>alert(1)</script>","count":42,"valid":true}'} tone="output" t={t} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("text-sky-300");
    expect(html).toContain("text-emerald-300");
    expect(html).toContain("text-amber-300");
    expect(html).toContain("text-fuchsia-300");
  });
  it("bounds initial rendering for large content while offering access to the rest", () => {
    const html = renderToString(<CodePanel title="Prompt" value={"x".repeat(100_000)} tone="input" t={t} />);
    expect(html.length).toBeLessThan(34_000);
    expect(html).toContain("Show more");
  });
});
