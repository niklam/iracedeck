/**
 * Profile-switch singleton (issue #736).
 *
 * Lets actions request a Stream Deck profile switch without depending on a
 * platform adapter directly (the same shape as the keyboard / binding-dispatcher
 * singletons). The Elgato plugin registers the concrete switcher — which delegates
 * to `adapter.switchToProfile` → `streamDeck.profiles.switchToProfile` — via
 * `initProfileSwitcher`. Non-Elgato plugins leave it unregistered (profiles are
 * Elgato-only), so `requestProfileSwitch` is a safe no-op there.
 */
import type { ILogger } from "@iracedeck/logger";

/**
 * Switches `deviceId` to a bundled profile by name. Omitting `profile` asks the
 * Stream Deck app to return to the previously active profile — but the app only
 * honors that while the CURRENT profile was switched to by this plugin (a
 * one-shot back-link, consumed on use); in any other state it logs "Profile not
 * found" and does nothing (verified against Stream Deck app logs, app 7.x).
 * Prefer `requestProfileSwitchBack`, which tracks the plugin's own switch
 * history and goes back by name.
 */
export type ProfileSwitcher = (deviceId: string, profile?: string, page?: number) => Promise<void>;

let switcher: ProfileSwitcher | undefined;
let logger: ILogger | undefined;

/**
 * Per-device history of the plugin's own named switches: the profile most
 * recently switched to, and the one before it. Used by
 * `requestProfileSwitchBack` — the plugin cannot query the device's active
 * profile, so its own switches are the only history available.
 */
const switchHistory = new Map<string, { current?: string; previous?: string }>();

/** Register the concrete profile switcher. Call once at plugin startup (Elgato only). */
export function initProfileSwitcher(fn: ProfileSwitcher, log?: ILogger): void {
  switcher = fn;
  logger = log;
}

/** Whether a profile switcher has been registered. */
export function isProfileSwitcherInitialized(): boolean {
  return switcher !== undefined;
}

/**
 * Request a profile switch. Routes to the registered switcher, or logs and no-ops
 * when none is registered (e.g. on Mirabox/Ulanzi, or before startup). A missing
 * `deviceId` is treated as a no-op — there is no device to switch.
 */
export async function requestProfileSwitch(
  deviceId: string | undefined,
  profile?: string,
  page?: number,
): Promise<void> {
  if (!deviceId) {
    logger?.debug("requestProfileSwitch called without a deviceId; ignoring");

    return;
  }

  if (!switcher) {
    logger?.debug("requestProfileSwitch called but no profile switcher is registered");

    return;
  }

  if (profile) {
    const rec = switchHistory.get(deviceId) ?? {};

    if (rec.current !== profile) {
      switchHistory.set(deviceId, { current: profile, previous: rec.current });
    }
  }

  await switcher(deviceId, profile, page);
}

/**
 * Switch back to the previous profile (the Switch Profile "Back to previous"
 * mode). When this plugin has switched the device between two named profiles,
 * go back BY NAME to the earlier one (pressing again toggles between the two —
 * the named re-switch records history like any other switch). Without any
 * history, fall back to the app-level "no profile" pop, which works exactly
 * when the current profile was just pushed by this plugin and can return to a
 * profile we can't name (e.g. the user's own profile); anywhere else the app
 * ignores it ("Profile not found").
 */
export async function requestProfileSwitchBack(deviceId: string | undefined): Promise<void> {
  if (!deviceId) {
    logger?.debug("requestProfileSwitchBack called without a deviceId; ignoring");

    return;
  }

  const previous = switchHistory.get(deviceId)?.previous;

  if (previous) {
    await requestProfileSwitch(deviceId, previous);

    return;
  }

  logger?.debug("No switch history for device; falling back to the app-level previous-profile pop");
  await requestProfileSwitch(deviceId);
}

/** @internal Reset for tests. */
export function _resetProfileSwitcher(): void {
  switcher = undefined;
  logger = undefined;
  switchHistory.clear();
}
