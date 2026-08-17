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
 * 1. Any `_settingsChannel` left in the STORE by an older build is removed —
 *    the channel is per-process (port + token change every start) and nothing
 *    reads it from the store, so persisting it only ever offered stale
 *    bootstrap data to whoever looked at the file. The removal is issued
 *    UNCONDITIONALLY (no "is it in the cache?" pre-check): before the store is
 *    ready the cache is schema defaults and cannot show a key that lives only
 *    in the file, so a pre-check would wrongly conclude there is nothing to do
 *    — `deleteGlobalSettings` records an early delete instead and applies it
 *    over the loaded file; once ready it is a no-op when the key is absent.
 * 2. The ONE host write per start: the whole cache plus the channel, mirrored
 *    to the deck host so PIs can bootstrap the loopback socket from a plain
 *    host read (`hostMirrorPayload` decides when that write must be skipped —
 *    never before the store is ready, never over a host copy the plugin has
 *    not read). Until this mirror lands, the host copy still carries the
 *    PREVIOUS run's channel; a PI that bootstraps in that window is refused
 *    and switches over when the fresh mirror is pushed (router late switch).
 *
 * `publish()` is idempotent per channel and re-entrant across readiness: the
 * store cleanup is issued once (retried on a later call if it threw), and the
 * mirror is retried on every call until it actually goes out — so a server started before the store was ready (an early
 * `open()`) is mirrored by the store-ready block's own call, and one started
 * after it by the controller's `onStarted` hook. Faults in a settings listener
 * during the store cleanup, or in the host write, are logged here on their own
 * terms instead of being mistaken for a server-start failure.
 */
import type { ILogger } from "@iracedeck/logger";

import { deleteGlobalSettings, hostMirrorPayload, SETTINGS_CHANNEL_KEY } from "./global-settings.js";
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
  /** Mirror the store + `channel` to the deck host, dropping any stale persisted channel first (see module doc). */
  publish(channel: SettingsChannel): void;
}

export function createSettingsChannelPublisher(deps: SettingsChannelPublisherDeps): SettingsChannelPublisher {
  const keyOf = (channel: SettingsChannel): string => `${channel.port}:${channel.token}`;
  let announced: string | undefined;
  let cleaned = false;
  let mirrored: string | undefined;

  return {
    publish(channel) {
      const key = keyOf(channel);

      if (announced !== key) {
        announced = key;
        deps.logger.debug(`Settings channel published on port ${channel.port}`);
      }

      if (!cleaned) {
        try {
          // Older builds persisted the channel into the settings file; drop it so
          // the file never advertises a dead port/token. No cache pre-check (see
          // module doc): before the store is ready this is recorded as an early
          // delete and applied over the loaded file; afterwards it is a no-op
          // when the key is absent. `cleaned` flips only once the call succeeded,
          // so a throwing settings listener here is retried by the next publish.
          deleteGlobalSettings([SETTINGS_CHANNEL_KEY]);
          cleaned = true;
        } catch (error: unknown) {
          deps.logger.error("Cleaning the stale settings channel from the store failed");
          deps.logger.debug(String(error));
        }
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
