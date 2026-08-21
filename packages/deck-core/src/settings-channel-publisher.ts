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
 *
 * `publishUnavailable()` is the same mirror for the run where the server never
 * came up at all (#1005) — everything above minus the channel. It is the only
 * write the host copy gets in that case, and therefore the only way anything
 * the plugin has written reaches a Property Inspector, which by then has
 * nothing to connect to and is reading the host copy. The two are deduped
 * against each other, so a failed startup bind followed by a successful "Open
 * Settings" mirrors twice — once without a channel, then again with the real
 * one — and never more.
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
  /**
   * Mirror the store to the deck host with NO channel — the settings server
   * failed to start this run (#1005).
   *
   * Without it that failure is invisible exactly where it must be seen: no
   * server means no loopback channel, so every Property Inspector falls back
   * to the deck host's copy, and the host copy is written ONLY from here. The
   * `_warnings` banner explaining why the settings window will not open would
   * otherwise never leave the plugin's own memory — since #1014 it is not even
   * in the settings file for someone to find there. Deduped like
   * `publish`, and superseded by the real thing if a later "Open Settings"
   * brings the server up after all — never the other way round: once a real
   * channel has been mirrored this is ignored, since sending it would strip
   * that channel back off the host copy.
   */
  publishUnavailable(): void;
}

/** Mirror-dedup key for the channel-less mirror. No `port:token` can collide with it. */
const NO_CHANNEL_KEY = "none";

export function createSettingsChannelPublisher(deps: SettingsChannelPublisherDeps): SettingsChannelPublisher {
  const keyOf = (channel: SettingsChannel | undefined): string =>
    channel === undefined ? NO_CHANNEL_KEY : `${channel.port}:${channel.token}`;
  let announced: string | undefined;
  let cleaned = false;
  let mirrored: string | undefined;

  /** Both entry points differ only in whether a channel goes into the mirror. */
  function mirrorToHost(channel: SettingsChannel | undefined): void {
    const key = keyOf(channel);

    // A channel-less mirror can only ever ADD to what the host knows — the
    // store, minus a channel there is none of. Once a REAL channel has gone
    // out, sending one would take it away again and drop every Property
    // Inspector that bootstraps afterwards onto the fallback path for the rest
    // of the run. Today's plugins cannot call it in that order (the startup
    // `ensureStarted()` settles exactly one way), but this is a public API and
    // that failure would be silent and total, so it is refused here rather
    // than left to every caller's ordering.
    if (channel === undefined && mirrored !== undefined && mirrored !== NO_CHANNEL_KEY) {
      deps.logger.debug("Channel-less mirror skipped: a live settings channel is already mirrored");

      return;
    }

    if (announced !== key) {
      announced = key;
      deps.logger.debug(
        channel === undefined
          ? "Settings channel unavailable; mirroring the store to the deck host without one"
          : `Settings channel published on port ${channel.port}`,
      );
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
      deps.logger.info(
        channel === undefined
          ? "Mirrored settings to the deck host (no settings channel this run)"
          : "Mirrored settings + channel to the deck host",
      );
    } catch (error: unknown) {
      deps.logger.error("Mirroring the settings to the deck host failed");
      deps.logger.debug(String(error));
    }
  }

  return {
    publish(channel) {
      mirrorToHost(channel);
    },

    publishUnavailable() {
      mirrorToHost(undefined);
    },
  };
}
