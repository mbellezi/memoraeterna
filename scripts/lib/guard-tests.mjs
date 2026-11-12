// Tests that read their subject through a path or a spawned process, not through an import, so
// `vitest related` cannot link them to it. `check:changed` runs them by name when a changed file
// matches their pattern (F5 BUILDCHK: a preload change broke the build because nothing selected
// the test that runs the build's own verify script against a freshly bundled preload).
export const guardTests = [
  {
    test: "scripts/lib/verify-sandbox-preload.test.ts",
    subject:
      /^(apps\/desktop\/src\/(preload|shared)\/|apps\/desktop\/electron\.vite\.config\.ts$|packages\/(domain|i18n|integration-contracts)\/src\/|scripts\/verify-sandbox-preload\.mjs$)/u
  }
];

/** The guard tests to add to `vitest related` for these changed files (repository-relative). */
export function guardTestsFor(changed) {
  return guardTests
    .filter(({ subject }) => changed.some((file) => subject.test(file)))
    .map(({ test }) => test);
}
