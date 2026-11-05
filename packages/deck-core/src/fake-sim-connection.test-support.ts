import type { OverlayFlag, SimConnection } from "./sim-connection.js";

/**
 * @internal A scriptable {@link SimConnection} for tests. Not exported from the
 * barrel; tests import it by relative path.
 */
export interface FakeSimConnection {
  connection: SimConnection;
  state: { connected: boolean; flags: OverlayFlag[]; resolve: (text: string) => string };
  subscribers: Map<string, (isConnected: boolean) => void>;
  /** Delivers one tick to every subscriber. */
  tick(): void;
}

export function createFakeSimConnection(): FakeSimConnection {
  const subscribers = new Map<string, (isConnected: boolean) => void>();
  const state: FakeSimConnection["state"] = { connected: true, flags: [], resolve: (text) => text };
  const connection: SimConnection = {
    isConnected: () => state.connected,
    subscribe: (id, onTick) => {
      subscribers.set(id, onTick);
    },
    unsubscribe: (id) => {
      subscribers.delete(id);
    },
    activeFlags: () => state.flags,
    resolveTitleTemplate: (text) => state.resolve(text),
  };

  return {
    connection,
    state,
    subscribers,
    tick: () => {
      for (const onTick of [...subscribers.values()]) onTick(state.connected);
    },
  };
}
