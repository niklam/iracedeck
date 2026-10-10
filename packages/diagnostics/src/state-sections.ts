/**
 * Plugin state for the Telemetry Snapshot (#1387): a registry of named
 * sections, and the collector Take Snapshot runs at the press.
 *
 * A section is a name and a reader. The package that owns a piece of state
 * exports the reader, and `plugin-runtime` registers it here, so this package
 * keeps importing nothing sim-shaped: it learns what the plugin has computed
 * the way the resource monitor learns about iRacing, by injection.
 *
 * **Readers are synchronous and side-effect-free.** The press is handled
 * between SDK ticks, so a synchronous collection describes one tick; a reader
 * that awaited would let a tick land in between, and one that wrote anything
 * would make taking a snapshot change the behaviour being reported. Nothing
 * here runs per tick: a reader is called only when a snapshot is taken.
 *
 * **A broken section never costs the rest.** Each section is read and encoded
 * on its own. One that throws, or whose result the JSON-safe encoder cannot
 * finish (a getter that throws), is replaced by `{ error: "<message>" }` and
 * named in `failed`; one `WARN` is logged for it, with the name and the reason
 * at debug. A `headline` that throws drops that section's rows and nothing else.
 *
 * Decision record: `docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md`.
 */
import type { ILogger } from "@iracedeck/logger";

import { type JsonValue, toJsonSafe } from "./json-safe.js";

/** Version of the curated sections' shape. Bumped on a rename or removal, never for an addition. */
export const PLUGIN_STATE_SCHEMA = 1;

/** One line of the snapshot's Markdown report. */
export type HeadlineRow = readonly [label: string, value: string];

export type StateSection<T = unknown> = {
  /** Returns the subsystem's state as it stands. Synchronous and side-effect-free. */
  read: () => T;
  /** Label/value rows for the snapshot's Markdown report, from the object `read` returned. */
  headline?: (state: T) => readonly HeadlineRow[];
};

export type CollectedState = {
  /** `{ schema, collectedAt, <section>: … }`, plain JSON data. */
  state: { [key: string]: JsonValue };
  /** Headline rows of every section whose read and headline both succeeded, in registration order. */
  headline: HeadlineRow[];
  /** Names of the sections replaced by an error entry. */
  failed: string[];
};

/** The collector's own keys, and the key an error entry is recognised by. */
const RESERVED = new Set(["schema", "collectedAt", "error"]);
const sections = new Map<string, StateSection>();

/**
 * Registers a named section of plugin state for the Telemetry Snapshot
 * (issue #1387). Stores the reader only; nothing runs until a snapshot is taken.
 *
 * Throws on an empty or reserved name, and on a name that is already
 * registered: two owners for one section is a wiring bug.
 */
export function registerStateSection<T>(name: string, section: StateSection<T>): void {
  if (!name || RESERVED.has(name)) throw new Error(`Invalid state section name: "${name}"`);

  if (sections.has(name)) throw new Error(`State section "${name}" is already registered`);

  sections.set(name, section as StateSection);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reads every registered section and encodes each on its own, so one broken
 * section becomes an error entry instead of costing the rest.
 *
 * @param now The clock `collectedAt` is read from; `Date.now`, the clock the sections' own stamps use.
 */
export function collectStateSections(logger: ILogger, now: () => number = Date.now): CollectedState {
  const state: { [key: string]: JsonValue } = { schema: PLUGIN_STATE_SCHEMA, collectedAt: now() };
  const headline: HeadlineRow[] = [];
  const failed: string[] = [];

  for (const [name, section] of sections) {
    let raw: unknown;

    try {
      raw = section.read();
      state[name] = toJsonSafe(raw);
    } catch (error) {
      state[name] = { error: messageOf(error) };
      failed.push(name);
      logger.warn("Snapshot state section failed");
      logger.debug(`Section "${name}": ${messageOf(error)}`);
      continue;
    }

    if (!section.headline) continue;

    try {
      // Spread before the push, so a headline that fails part-way contributes no row at all.
      headline.push(...section.headline(raw));
    } catch (error) {
      logger.debug(`Section "${name}" headline failed: ${messageOf(error)}`);
    }
  }

  return { state, headline, failed };
}

/** @internal Exported for testing */
export function _resetStateSections(): void {
  sections.clear();
}
