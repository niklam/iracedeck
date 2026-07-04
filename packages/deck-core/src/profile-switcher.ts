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
 * Prefer `requestProfileSwitchBack`, which tracks the plugin's own profile
 * history and goes back by name.
 */
export type ProfileSwitcher = (deviceId: string, profile?: string, page?: number) => Promise<void>;

let switcher: ProfileSwitcher | undefined;
let logger: ILogger | undefined;

/** Oldest entries are dropped once a device's history grows past this depth. */
const MAX_PROFILE_HISTORY = 10;

/**
 * Per-device history of the profiles this plugin knows the device visited, as a
 * stack whose last entry is the current profile (issue #762). Fed by the
 * plugin's own named switches AND by `notifyProfileVisible` reports from keys
 * that carry a host-profile marker — the Elgato SDK cannot query the active
 * profile, so these are the only observations available. Used by
 * `requestProfileSwitchBack` to walk back by name.
 */
const switchHistory = new Map<string, string[]>();

/**
 * Record that `profile` became (or is) the device's current profile. Matching
 * the top is a no-op; a profile already deeper in the stack unwinds to it (the
 * user navigated back); anything else is pushed, dropping the oldest entry past
 * `MAX_PROFILE_HISTORY`.
 */
function recordProfileVisit(deviceId: string, profile: string): void {
  const stack = switchHistory.get(deviceId) ?? [];

  if (stack[stack.length - 1] === profile) {
    return;
  }

  const existing = stack.indexOf(profile);

  if (existing >= 0) {
    stack.length = existing + 1;
  } else {
    stack.push(profile);

    if (stack.length > MAX_PROFILE_HISTORY) {
      stack.shift();
    }
  }

  switchHistory.set(deviceId, stack);
}

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
 * Report that a profile is visible on a device — called by keys that carry a
 * host-profile marker when they appear (issue #762). This is how the plugin
 * learns the profile the user is standing on when it didn't perform the switch
 * itself (manual navigation, app-level pop, plugin restart), so that
 * `requestProfileSwitchBack` can return there by name. Safe no-op without a
 * registered switcher, a device, or a profile name.
 */
export function notifyProfileVisible(deviceId: string | undefined, profile: string | undefined): void {
  if (!deviceId || !profile) {
    logger?.debug("notifyProfileVisible called without a deviceId or profile; ignoring");

    return;
  }

  if (!switcher) {
    return;
  }

  recordProfileVisit(deviceId, profile);
  logger?.debug(`Profile "${profile}" reported visible on device ${deviceId}`);
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
    recordProfileVisit(deviceId, profile);
  }

  await switcher(deviceId, profile, page);
}

/**
 * Switch back to the previous profile (the Switch Profile "Back to previous"
 * mode). Pops the device's profile history and switches BY NAME to the entry
 * below, so repeated presses walk back through the visited profiles (issue
 * #762). With nothing left to pop, switch to `fallbackProfile` (typically the
 * device's bundled Default profile) and make it the new history root; without a
 * fallback, fall back to the app-level "no profile" pop, which works exactly
 * when the current profile was just pushed by this plugin — anywhere else the
 * app ignores it ("Profile not found").
 */
export async function requestProfileSwitchBack(deviceId: string | undefined, fallbackProfile?: string): Promise<void> {
  if (!deviceId) {
    logger?.debug("requestProfileSwitchBack called without a deviceId; ignoring");

    return;
  }

  const stack = switchHistory.get(deviceId);

  if (stack && stack.length >= 2) {
    stack.pop();
    await requestProfileSwitch(deviceId, stack[stack.length - 1]);

    return;
  }

  if (fallbackProfile) {
    logger?.debug(`No profile to walk back to on device ${deviceId}; switching to fallback "${fallbackProfile}"`);
    switchHistory.set(deviceId, [fallbackProfile]);
    await requestProfileSwitch(deviceId, fallbackProfile);

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
