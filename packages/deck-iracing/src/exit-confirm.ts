/**
 * How long a lost SDK connection must stay lost before iRacing counts as gone.
 *
 * A leaf, so both of its users can import it: `app-monitor.ts` already imports
 * `sdk-singleton.ts`, and the reverse import would be a source cycle, which the
 * plugin builds refuse (#1599).
 */

/**
 * How long a lost SDK connection must stay lost before it counts as an
 * iRacing exit (issue #870). Ulanzi maps no app-monitoring events at all, so
 * a sustained SDK disconnect is the only exit signal there (Stream Deck and
 * Mirabox both deliver applicationDidTerminate, verified in #1347 and #1419).
 * The window is well above the controller's 2 s reconnect poll, so a
 * transient shared-memory blip reconnects and cancels the confirmation
 * instead of mis-reading as an exit.
 *
 * It is also the sim's absent delay for the deck's disconnected key look
 * (#1599): `initializeSDK` hands it to `initializeSimConnection`, so iRacing
 * has one answer to "how long before a lost connection counts as gone".
 */
export const IRACING_EXIT_SDK_CONFIRM_MS = 5000;
