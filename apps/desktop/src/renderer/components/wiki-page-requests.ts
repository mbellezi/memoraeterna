/** Current-only refreshes may commit only while the same wiki navigation is active. */
export function createWikiPageRequests() {
  let epoch = 0;
  const capture = () => {
    const requestedEpoch = epoch;
    return () => requestedEpoch === epoch;
  };
  return {
    capture,
    begin() { epoch += 1; return capture(); },
    invalidate() { epoch += 1; }
  };
}
