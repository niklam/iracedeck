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
 * here runs per tick: a reader is called only when a snapshot is taken. A
 * reader that returns a promise has failed, since what it would resolve to is
 * no longer the state at the press.
 *
 * **A broken section never costs the rest.** Each section is read and encoded
 * on its own. One that throws, or whose result the JSON-safe encoder cannot
 * finish (a getter that throws, more values than its budget), is replaced by
 * `{ error: "<reason>" }` and named in `failed`; one `WARN` naming it is
 * logged, with the reason at debug. A `headline` that throws, or returns
 * anything but rows of two cells, costs that section's summary and nothing
 * else, at debug only.
 *
 * **The headline rows say so themselves.** A failed section, and a section
 * whose headline failed, each leave one row in their own place, so the caller
 * passes `headline` to the report unchanged and every cell in it is a string.
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
  /**
   * Label/value rows for the snapshot's Markdown report, from the object `read` returned.
   * A number, BigInt or boolean cell is converted to text and a `null` or `undefined` one
   * becomes "n/a"; any other shape fails the headline, which costs this section's rows only.
   */
  headline?: (state: T) => readonly HeadlineRow[];
};

export type CollectedState = {
  /** `{ schema, collectedAt, <section>: … }`, plain JSON data. */
  state: { [key: string]: JsonValue };
  /**
   * The report's rows, in registration order: each section's own rows, or a single
   * `[<section>, <what is missing>]` row where the section or its headline failed.
   */
  headline: HeadlineRow[];
  /** Names of the sections replaced by an error entry. A failed headline does not put a section here. */
  failed: string[];
};

/** The value cell of the row standing in for a section that has an error entry instead of state. */
const SECTION_UNAVAILABLE = "unavailable (see the JSON file)";
/** The value cell of the row standing in for a section whose state is in the file but whose headline failed. */
const SUMMARY_UNAVAILABLE = "summary unavailable";
/** A headline cell that was `null` or `undefined`. */
const NO_VALUE = "n/a";
/** The reason given when what was thrown says nothing usable about itself. */
const UNKNOWN_REASON = "unknown error";
const NOT_SYNCHRONOUS = "the reader returned a promise; state readers must be synchronous";

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

/** The text of a primitive, or `""` for a blank string and for anything that is not one. Cannot throw. */
function textOf(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value.trim();
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return String(value);
    default:
      // An object's own conversion can throw, and "[object Object]" would be a reason that says nothing.
      return "";
  }
}

/**
 * Why something failed, as a string that is never empty. Total: it runs inside
 * a `catch`, where a second throw would lose the whole collection, and anything
 * can be thrown and anything assigned to an Error's `message`.
 */
function messageOf(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null) return textOf(error) || UNKNOWN_REASON;

    const { message, name } = error as { message?: unknown; name?: unknown };

    return textOf(message) || textOf(name) || UNKNOWN_REASON;
  } catch {
    // A getter or a Proxy trap on the thrown value.
    return UNKNOWN_REASON;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Marks a promise nobody will await as handled, so its rejection does not end the process. */
function ignoreOutcome(promise: PromiseLike<unknown>): void {
  try {
    void Promise.resolve(promise).then(undefined, () => {});
  } catch {
    // A thenable that breaks on being adopted has no rejection left to report.
  }
}

function toHeadlineCell(cell: unknown, row: number): string {
  switch (typeof cell) {
    case "string":
      return cell;
    case "number":
    case "bigint":
    case "boolean":
      return String(cell);
    case "undefined":
      return NO_VALUE;
    default:
      if (cell === null) return NO_VALUE;

      throw new TypeError(`row ${row} holds a cell that is not text, a number or a boolean`);
  }
}

/**
 * Checks what a headline produced and returns rows of this module's own making,
 * every cell a string. Throws on any other shape, before a single row is kept.
 */
function toHeadlineRows(produced: unknown): HeadlineRow[] {
  // Spreading throws on what is not iterable, and turns a string into characters, none of which is a row.
  return [...(produced as Iterable<unknown>)].map((row, index) => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError(`row ${index + 1} is not a [label, value] pair`);

    return [toHeadlineCell(row[0], index + 1), toHeadlineCell(row[1], index + 1)];
  });
}

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

      if (isThenable(raw)) {
        ignoreOutcome(raw);

        throw new Error(NOT_SYNCHRONOUS);
      }

      state[name] = toJsonSafe(raw);
    } catch (error) {
      // What must be on record comes first; nothing below it throws either, but nothing above depends on that.
      failed.push(name);
      logger.warn(`Snapshot state section "${name}" failed`);

      const reason = messageOf(error);

      state[name] = { error: reason };
      headline.push([name, SECTION_UNAVAILABLE]);
      logger.debug(`Section "${name}": ${reason}`);
      continue;
    }

    if (!section.headline) continue;

    try {
      headline.push(...toHeadlineRows(section.headline(raw)));
    } catch (error) {
      headline.push([name, SUMMARY_UNAVAILABLE]);
      logger.debug(`Section "${name}" headline failed: ${messageOf(error)}`);
    }
  }

  return { state, headline, failed };
}

/** @internal Exported for testing */
export function _resetStateSections(): void {
  sections.clear();
}
