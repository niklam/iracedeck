/**
 * The host-side global-settings surface the settings layer needs (#1365).
 *
 * `global-settings.ts` reads through {@link SettingsHost.onDidReceiveGlobalSettings},
 * {@link SettingsHost.getGlobalSettings} and the optional
 * {@link SettingsHost.onHostReady}, and the settings-channel publisher writes
 * through {@link SettingsHost.setGlobalSettings}. deck-core's
 * `IDeckPlatformAdapter` extends this interface, so every platform adapter
 * satisfies it without change.
 */
export interface SettingsHost {
  /** Subscribe to global settings changes */
  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void;
  /** Request current global settings (triggers onDidReceiveGlobalSettings callback) */
  getGlobalSettings(): void;
  /** Write/update global settings */
  setGlobalSettings(settings: Record<string, unknown>): void;
  /**
   * Subscribe to the host connection becoming usable — the point from which a
   * {@link getGlobalSettings} read can actually be answered (#1056). A given
   * subscriber is called at most ONCE — immediately if the host is already
   * reachable when you subscribe, otherwise when it becomes so; a later
   * reconnect does not call it again.
   *
   * **Optional on purpose, and absence is a statement rather than a gap.** Only
   * the two WebSocket adapters have anything to report: they drop a frame
   * written before their socket opens, so the one-time migration read is issued
   * into a closed socket and covered by the connect-time reissue. An adapter
   * whose transport queues the read until it can be sent — Elgato, whose SDK
   * awaits the connection inside its own `send` — declares nothing here, and
   * deck-core then keeps the deadline it already armed.
   *
   * Do NOT make this required. A stub that never calls back would satisfy the
   * type while breaking the contract; it happens to be harmless for today's
   * single consumer (never firing means never re-arming, which is right for
   * Elgato) and would silently do the wrong thing for the next one.
   */
  onHostReady?(callback: () => void): void;
}
