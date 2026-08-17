/**
 * Settings-channel publisher (issue #993, phase 2).
 *
 * The plugin's loopback settings server is the channel every UI reaches the
 * plugin-owned settings store through. Once it is up, two things must happen
 * — and used to be pasted into all three plugin.ts files, inside the startup
 * `ensureStarted().then(...)` only, so a server that came up LATER (a failed
 * startup bind followed by a successful "Open Settings" start) was never
 * published and every Property Inspector stayed on the host fallback path:
 *
 * 1. `_settingsChannel = { port, token }` is written to the store.
 * 2. The ONE host write per start: the whole cache plus the channel, mirrored
 *    to the deck host so PIs can bootstrap the loopback socket from a plain
 *    host read (`hostMirrorPayload` decides when that write must be skipped —
 *    never before the store is ready, never over a host copy the plugin has
 *    not read).
 *
 * `publish()` is idempotent per channel and re-entrant across readiness: the
 * store write happens once per channel, and the mirror is retried on every
 * call until it actually goes out — so a server started before the store was
 * ready (an early `open()`) is mirrored by the store-ready block's own call,
 * and one started after it by the controller's `onStarted` hook. Faults in a
 * settings listener during the store write, or in the host write, are logged
 * here on their own terms instead of being mistaken for a server-start failure.
 */
import type { ILogger } from "@iracedeck/logger";

import { hostMirrorPayload, SETTINGS_CHANNEL_KEY, updateGlobalSettings } from "./global-settings.js";
import type { IDeckPlatformAdapter } from "./types.js";

export interface SettingsChannel {
  port: number;
  token: string;
}

export interface SettingsChannelPublisherDeps {
  adapter: Pick<IDeckPlatformAdapter, "setGlobalSettings">;
  logger: ILogger;
}

export interface SettingsChannelPublisher {
  /** Publish `channel` to the store and mirror the store + channel to the deck host (see module doc). */
  publish(channel: SettingsChannel): void;
}

export function createSettingsChannelPublisher(deps: SettingsChannelPublisherDeps): SettingsChannelPublisher {
  const keyOf = (channel: SettingsChannel): string => `${channel.port}:${channel.token}`;
  let published: string | undefined;
  let mirrored: string | undefined;

  return {
    publish(channel) {
      const key = keyOf(channel);

      try {
        if (published !== key) {
          updateGlobalSettings({ [SETTINGS_CHANNEL_KEY]: { port: channel.port, token: channel.token } });
          published = key;
          mirrored = undefined;
          deps.logger.debug(`Settings channel published on port ${channel.port}`);
        }
      } catch (error: unknown) {
        deps.logger.error("Publishing the settings channel to the store failed");
        deps.logger.debug(String(error));
      }

      if (mirrored === key) return;

      try {
        const mirror = hostMirrorPayload(channel);

        if (mirror === undefined) {
          deps.logger.info("Host mirror skipped: the store holds no host-derived settings yet");

          return;
        }

        deps.adapter.setGlobalSettings(mirror);
        mirrored = key;
        deps.logger.info("Mirrored settings + channel to the deck host");
      } catch (error: unknown) {
        deps.logger.error("Mirroring the settings to the deck host failed");
        deps.logger.debug(String(error));
      }
    },
  };
}
