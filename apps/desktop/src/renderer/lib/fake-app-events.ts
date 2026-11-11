import {
  createAppEventDispatcher,
  type AppEvent,
  type AppEventHandler,
  type AppEventType
} from "../../shared/app-events";
import type { AppEventApi } from "./app-events";

/**
 * A bus for the tests of a view or a controller (a fake `window.app`): it is the real dispatcher,
 * so an event that does not match the contract is dropped exactly as in the preload, over a wire
 * the test drives. `emit` delivers one event to the handlers of its type; `listening` counts them.
 */
export interface FakeAppEvents {
  api: AppEventApi;
  emit(event: AppEvent): void;
  listening(type: AppEventType): number;
  /** Whether the wire is attached: the preload listens only while something subscribes. */
  attached(): boolean;
}

export function createFakeAppEvents(): FakeAppEvents {
  let deliver: ((payload: unknown) => void) | null = null;
  const counts = new Map<AppEventType, number>();
  const dispatcher = createAppEventDispatcher({
    attach(next) {
      deliver = next;
      return () => {
        deliver = null;
      };
    }
  });
  return {
    api: {
      onAppEvent<T extends AppEventType>(type: T, handler: AppEventHandler<T>) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
        const stop = dispatcher.subscribe(type, handler);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          counts.set(type, (counts.get(type) ?? 1) - 1);
          stop();
        };
      }
    },
    emit: (event) => deliver?.(event),
    listening: (type) => counts.get(type) ?? 0,
    attached: () => deliver !== null
  };
}
