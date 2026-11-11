import { describe, expect, it } from "vitest";

/**
 * F5 T125: the six push channels the bus replaced are gone from `window.app`, so no renderer
 * source may call what exposed them. A consumer listens through `onAppEvent` (or the helpers of
 * `lib/app-events.ts`) and nothing else.
 */
const sources = import.meta.glob<string>(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true }
);

describe("the renderer's push subscriptions", () => {
  it("name none of the retired window.app subscriptions", () => {
    const retired =
      /\b(?:subscribeExplanationDelta|subscribeLocalEmbeddingLoadStatus|viewHistory\.subscribeChanged|topics\.subscribeChanged|relations\.subscribeChanged)\b/u;
    for (const [file, source] of Object.entries(sources)) expect(source, file).not.toMatch(retired);
  });

  it("pass no progress callback to extractFileMetadata: its progress is import.progress", () => {
    for (const [file, source] of Object.entries(sources)) {
      for (const call of source.matchAll(/extractFileMetadata\(([\s\S]*?)\)/gu))
        expect(call[1], file).not.toMatch(/,\s*\w+\s*$/u);
    }
  });

  it("listen to no Electron channel themselves", () => {
    for (const [file, source] of Object.entries(sources))
      expect(source, file).not.toMatch(/\bipcRenderer\b/u);
  });

  it("have each former consumer listen to its bus type", () => {
    const consumers: Record<string, string[]> = {
      "../components/note-page/NotePage.tsx": ['"explanation.delta"'],
      "../components/RecentObjects.tsx": ['"view.changed"'],
      "../components/topics/TopicNavigator.tsx": ['"tree.changed"', '"view.changed"'],
      "../components/topic-page/topic-page-controller.ts": ["onTreeChanged"],
      "../components/topic-shape/shape-controller.ts": ["onTreeChanged"],
      "../components/activity/activity-controller.ts": ['"model.loading"'],
      "../components/ImportView.tsx": ['"import.progress"'],
      "./topics-pulse.ts": ['"tree.changed"'],
      "./relations-pulse.ts": ['"relation.created"', '"object.changed"']
    };
    for (const [file, needles] of Object.entries(consumers))
      for (const needle of needles) expect(sources[file], `${file} ${needle}`).toContain(needle);
  });
});
