/**
 * The sdpi-components Stream Deck client, as the `ird-*` components see it.
 *
 * sdpi-components exposes `window.SDPIComponents.streamDeckClient` once it has
 * loaded; several components (`ird-profile-switch`, `ird-open-settings`,
 * `ird-audio-test`, the external-link handler) send fire-and-forget frames
 * through it. This is the one place that shape and lookup live, so a change —
 * e.g. also accepting the settings-window bridge's socket, or logging a missing
 * client — is made once.
 */

/** Minimal shape of the sdpi-components client the `ird-*` components depend on. */
export interface StreamDeckClientLike {
  send(event: string, payload?: Record<string, unknown>): unknown;
}

interface SDPIComponentsGlobal {
  SDPIComponents?: { streamDeckClient?: StreamDeckClientLike };
}

/** Read the sdpi-components client off the global scope, if it has loaded. */
export function getStreamDeckClient(): StreamDeckClientLike | undefined {
  return (globalThis as SDPIComponentsGlobal).SDPIComponents?.streamDeckClient;
}

/**
 * Send a `sendToPlugin` frame, fire-and-forget: no client (sdpi-components
 * unavailable) is a silent no-op, and a rejected send never surfaces as an
 * unhandled promise rejection. Returns whether a client was there to send to.
 */
export function sendToPlugin(payload: Record<string, unknown>): boolean {
  const client = getStreamDeckClient();

  if (!client) return false;

  void Promise.resolve(client.send("sendToPlugin", payload)).catch(() => {});

  return true;
}
