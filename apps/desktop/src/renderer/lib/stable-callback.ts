import { useLayoutEffect, useState } from "react";

/**
 * A function with a fixed identity that always calls the latest implementation. Long-lived
 * resources (WebGL renderers, workers, listeners) can depend on it without being rebuilt when the
 * parent re-renders with a new inline callback.
 */
export function createStableCallback<Args extends unknown[], Result>(
  initial: (...args: Args) => Result
) {
  let latest = initial;
  return {
    call: (...args: Args): Result => latest(...args),
    update(next: (...args: Args) => Result) {
      latest = next;
    }
  };
}

export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const [stable] = useState(() => createStableCallback(callback));
  useLayoutEffect(() => {
    stable.update(callback);
  });
  return stable.call;
}
