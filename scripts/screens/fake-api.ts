/**
 * A fake `window.app` for the screens tool, one per mode. It runs inside the fixture bundle (a
 * browser), so it imports nothing.
 *
 * - loading: every call stays pending, so a surface shows what it shows while it waits;
 * - error: every call rejects, so a surface shows its failure and its way back; a screen module that
 *   needs part of the surface to load first lists those calls in `fixtures.error` (the third
 *   argument) and only the others reject;
 * - empty and success: a call is answered from the screen module's fixtures, keyed by the call path
 *   (`"inbox.list"`, or `"onAppEvent"` at the top level). A fixture is a value or a function of the
 *   call's arguments. A call with no fixture rejects and is listed in `missing`, so the check names
 *   a surface whose fixtures do not cover what it asks.
 *
 * Subscriptions (`subscribe…` and `on…`) are no-ops in every mode: they return an unsubscribe
 * function and never deliver an event.
 */
export type FakeMode = "loading" | "empty" | "error" | "success";

export interface FakeCall {
  readonly path: string;
  readonly args: readonly unknown[];
}

export interface FakeApi {
  /** The object to install as `window.app`. */
  readonly app: unknown;
  readonly calls: FakeCall[];
  /** Call paths that a success or empty surface made without a fixture to answer them. */
  missing(): string[];
}

export const isSubscription = (name: string): boolean => /^(subscribe|on)[A-Z]/u.test(name);

const never = (): Promise<never> => new Promise<never>(() => undefined);

export function createFakeApi(
  mode: FakeMode,
  fixtures: Readonly<Record<string, unknown>> = {},
  errorFixtures: Readonly<Record<string, unknown>> = {}
): FakeApi {
  const calls: FakeCall[] = [];
  const missing = new Set<string>();

  const answer = (path: string, args: unknown[]): unknown => {
    calls.push({ path, args });
    if (mode === "loading") return never();
    if (mode === "error" && !Object.hasOwn(errorFixtures, path))
      return Promise.reject(new Error(`fake window.app: ${path} fails`));
    if (mode !== "error" && !Object.hasOwn(fixtures, path)) {
      missing.add(path);
      return Promise.reject(new Error(`fake window.app: no fixture for ${path}`));
    }
    const fixture = (mode === "error" ? errorFixtures : fixtures)[path];
    try {
      return Promise.resolve(typeof fixture === "function" ? fixture(...args) : fixture);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const node = (path: string): unknown =>
    new Proxy(function fakeCall() {}, {
      get(_target, key) {
        // Never thenable, never a symbol lookup: `await window.app.topics` must not hang.
        if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined;
        return node(path === "" ? key : `${path}.${key}`);
      },
      apply(_target, _this, args: unknown[]) {
        const name = path.slice(path.lastIndexOf(".") + 1);
        if (isSubscription(name)) {
          calls.push({ path, args });
          return () => undefined;
        }
        return answer(path, args);
      }
    });

  return { app: node(""), calls, missing: () => [...missing].sort() };
}
