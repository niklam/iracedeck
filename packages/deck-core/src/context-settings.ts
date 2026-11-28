/**
 * The per-context, write-through settings record an action keeps (#1761).
 *
 * A host stores a context's settings as one whole object, so a plugin write
 * built from an event's snapshot replaces whatever the host holds. Since #1597
 * a Property Inspector change made while a lifecycle handler awaits is queued
 * behind that handler rather than run inside it, so at the moment the handler
 * writes, the plugin holds nothing newer, and a write from the event's own
 * settings reverts the change the user has just made. Two things close that:
 *
 * - **The record.** For each context it holds the newest settings the plugin
 *   knows: what the host last delivered (`willAppear`, `didReceiveSettings`),
 *   or what the plugin last wrote, whichever came last. A write merges onto the
 *   record, never onto the event's payload, so two writes in one handler both
 *   survive.
 * - **The arrival token.** Every event carries `isSuperseded` from the
 *   adapter's `ContextEventOrder`. When a newer settings event has already
 *   arrived for the context, a write is not sent; its updater is parked and
 *   re-run on the newer settings when that event's `didReceiveSettings` runs.
 *
 * Whether a host echoes the plugin's own write back as a `didReceiveSettings`
 * differs between hosts, and nothing here depends on it: an echo is a newer
 * settings arrival, so a later write in the same handler is parked and re-run
 * on the echo, where its updater returns `undefined` once its change is
 * present, and the exchange stops there.
 *
 * Updaters must be pure: they may run again on newer settings. One that throws
 * on a re-run is logged and skipped, so the others still run.
 *
 * Design record: docs/superpowers/specs/2026-11-28-issue-1761-settings-writes-against-newest.md.
 */
import { type ILogger, silentLogger } from "@iracedeck/logger";

import type { IDeckEvent } from "./types.js";

/**
 * What a write computes from the context's newest settings: the whole new
 * object to store, or `undefined` when the record already holds the change and
 * nothing need be written. Receives the record itself, read-only; return a new
 * object. An updater rather than a partial patch, so a migration can delete a
 * key.
 */
export type ContextSettingsUpdater = (
  current: Readonly<Record<string, unknown>>,
) => Record<string, unknown> | undefined;

/** The settings a host event carries, as an object; anything else counts as none. */
function settingsOf(ev: IDeckEvent<unknown>): Record<string, unknown> {
  const settings = ev.payload.settings;

  return settings !== null && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

/**
 * One action's settings record per live context, and the writes parked behind
 * a newer settings event. `BaseAction` keeps one and drives it from its
 * lifecycle handlers; a test double of an action can keep the real one the
 * same way (it is on `@iracedeck/deck-core/testing` as well as the barrel):
 *
 * ```ts
 * const settings = new ContextSettings(logger);
 * settings.appear(ev);                 // onWillAppear, first
 * await settings.receive(ev);          // onDidReceiveSettings, first
 * settings.disappear(ev.action.id);    // onWillDisappear
 * await settings.update(ev, (s) => (s.addedWithVersion ? undefined : { ...s, addedWithVersion: "1.0.0" }));
 * ```
 */
export class ContextSettings {
  private readonly records = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly parked = new Map<string, ContextSettingsUpdater[]>();
  private readonly logger: () => ILogger;

  /**
   * @param logger - The logger to write to, or a function returning it, read
   *   at each line, for an owner whose logger may be replaced after
   *   construction (`BaseAction.logger` is a protected field).
   */
  constructor(logger: ILogger | (() => ILogger) = silentLogger) {
    this.logger = typeof logger === "function" ? logger : () => logger;
  }

  /**
   * The newest settings the plugin holds for `contextId`: what the host last
   * delivered or what the plugin last wrote, whichever came last;
   * `undefined` for a context that has not appeared or has disappeared.
   */
  get(contextId: string): Readonly<Record<string, unknown>> | undefined {
    return this.records.get(contextId);
  }

  /**
   * The context appeared: its record starts as the settings the host
   * delivered, and any write still parked for it is dropped, since it was
   * computed for an earlier appearance.
   */
  appear(ev: IDeckEvent<unknown>): void {
    this.records.set(ev.action.id, settingsOf(ev));
    this.parked.delete(ev.action.id);
  }

  /**
   * The host delivered new settings: they replace the record, then every
   * write parked for the context is re-run against them, in the order it was
   * parked, through {@link update} with `ev` — so one that is superseded again
   * parks again for the next settings event. Resolves when the re-runs have
   * been sent; never rejects.
   */
  async receive(ev: IDeckEvent<unknown>): Promise<void> {
    const contextId = ev.action.id;

    this.records.set(contextId, settingsOf(ev));

    const waiting = this.parked.get(contextId);

    if (waiting === undefined) return;

    this.parked.delete(contextId);
    this.logger().debug(`Re-running ${waiting.length} parked settings write(s) for ${contextId} on its new settings`);

    for (const updater of waiting) {
      try {
        await this.update(ev, updater);
      } catch (err) {
        this.logger().warn(`A parked settings write for ${contextId} failed on its new settings: ${err}`);
      }
    }
  }

  /** The context disappeared: its record and any parked write are dropped. */
  disappear(contextId: string): void {
    this.records.delete(contextId);
    this.parked.delete(contextId);
  }

  /**
   * Write the context's settings as `updater` computes them from the newest
   * record, unless that would overwrite a newer change. Resolves to `true`
   * only when it wrote now; never rejects for the write itself (a throw from
   * `updater` is the caller's).
   *
   * 1. No record — the context never appeared or has disappeared: nothing is
   *    written.
   * 2. `next = updater(record)`; `undefined` means the record already holds
   *    the change: nothing is written.
   * 3. `ev.isSuperseded?.()` — a newer settings event of the context has
   *    already arrived: nothing is written now; the updater is parked and
   *    re-run by {@link receive} on the newer settings, or dropped by
   *    {@link appear} / {@link disappear}.
   * 4. Otherwise the record becomes `next` synchronously, before the write
   *    is awaited, so a write that starts meanwhile merges onto it; then
   *    `ev.action.setSettings(next)` is awaited. A failed write is warned and
   *    the record kept, so the next write carries the change again.
   */
  async update(ev: IDeckEvent<unknown>, updater: ContextSettingsUpdater): Promise<boolean> {
    const contextId = ev.action.id;
    const current = this.records.get(contextId);

    if (current === undefined) {
      this.logger().debug(`Settings write for ${contextId} skipped: it has no settings record (not live)`);

      return false;
    }

    const next = updater(current);

    if (next === undefined) return false;

    if (ev.isSuperseded?.() === true) {
      const waiting = this.parked.get(contextId);

      if (waiting === undefined) this.parked.set(contextId, [updater]);
      else waiting.push(updater);

      this.logger().debug(`Settings write for ${contextId} parked: newer settings have arrived and run next`);

      return false;
    }

    this.records.set(contextId, next);

    try {
      await ev.action.setSettings(next);

      return true;
    } catch (err) {
      this.logger().warn(`Failed to write settings for ${contextId}: ${err}`);

      return false;
    }
  }

  /**
   * The number of contexts with a write parked.
   *
   * @internal
   */
  get parkedCount(): number {
    return this.parked.size;
  }
}
