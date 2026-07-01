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

/** Switches `deviceId` to a bundled profile by name. Omitting `profile` returns to the default profile. */
export type ProfileSwitcher = (deviceId: string, profile?: string, page?: number) => Promise<void>;

let switcher: ProfileSwitcher | undefined;
let logger: ILogger | undefined;

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

  await switcher(deviceId, profile, page);
}

/** @internal Reset for tests. */
export function _resetProfileSwitcher(): void {
  switcher = undefined;
  logger = undefined;
}
