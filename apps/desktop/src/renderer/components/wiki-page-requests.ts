/** Current-only refreshes may commit only while the same wiki navigation is active. */
export function createWikiPageRequests() {
  let epoch = 0;
  const capture = () => {
    const requestedEpoch = epoch;
    return () => requestedEpoch === epoch;
  };
  return {
    /** Changes whenever a request begins or is invalidated; anything captured earlier is stale. */
    epoch: () => epoch,
    capture,
    begin() {
      epoch += 1;
      return capture();
    },
    invalidate() {
      epoch += 1;
    }
  };
}
