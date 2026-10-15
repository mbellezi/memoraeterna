// The Topic Tree Engine (docs/plan.md 4.1): pure TypeScript plus Zod, exported only through
// `@app/domain/topic-tree` for the main process, workers and scripts. Nothing here may be
// imported by the preload or the renderer; the browser-safe vocabulary is `@app/domain`'s
// `topics.ts`.
export * from "./build.js";
export * from "./config.js";
export * from "./events.js";
export * from "./ids.js";
export * from "./invariants.js";
export * from "./kmeans.js";
export * from "./knn.js";
export * from "./metrics.js";
export * from "./rng.js";
export * from "./state.js";
export * from "./stats.js";
export * from "./vectors.js";
export * from "./fixtures/synthetic.js";
