/**
 * A bounded error reporter for dispatch loops (#1558).
 *
 * A dispatcher that calls many callbacks many times a second (the SDK controller
 * delivers about 60 ticks a second to every subscriber) must not let one callback's
 * throw stop the others, and must not let a callback that throws on every tick flood
 * the log. This reporter is the logging half of that boundary: the error boundary
 * (`error-boundary.ts`) catches, hands the throw here, and the dispatch carries on.
 *
 * The rules, from `docs/superpowers/specs/2026-10-31-issue-1558-sdk-subscriber-isolation.md`:
 *
 * - **Key** is `(id, throw site)`. The site is the error's first stack frame; with no
 *   stack frame it is the error's name plus its message with digits normalised, so a
 *   message that carries data ("index 37 out of range") is one key, not one per tick.
 * - **First occurrence** of a key writes one `error` line with the stack.
 * - **Repeats** are counted. Each key writes one `warn` line per window while it keeps
 *   throwing, with the count since its last line.
 * - **Recovery** is declared only after an id has thrown nothing for a whole window:
 *   one `info` line with the total count, then the id's keys are forgotten. A throw
 *   after a clean call inside the window is a repeat, not a new first occurrence.
 * - **Caps**: a limited number of keys per id and in all. A new key past either cap is
 *   counted as that id's overflow, announced by one `warn` line, so one noisy id cannot
 *   hide another id's first error.
 * - **`forget(id)`** flushes the id's pending counts as one final `warn` line and drops
 *   its keys, so dead ids (action contexts come and go) do not fill the table.
 *
 * No timers: a quiet id is noticed on its next `succeeded` or `report` call.
 */
import type { ILogger } from "./index.js";

/**
 * What a dispatcher does with a callback's throw. The error boundary applies it, and
 * its options document it: see `ErrorBoundaryOptions.policy` in `error-boundary.ts`.
 */
export type ErrorPolicy = "report" | "rethrow";

/** Spec defaults (#1558). */
export const DEFAULT_ERROR_REPORT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_ERROR_KEYS_PER_ID = 4;
export const DEFAULT_MAX_ERROR_KEYS = 32;

/** The longest error description a `warn` or `info` line carries. Stacks go on the `error` line only. */
const MAX_SUMMARY_LENGTH = 200;

export interface BoundedErrorReporterOptions {
  /** Where the lines go. */
  logger: ILogger;
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** The summary interval and the quiet window before recovery. Defaults to 60 s. */
  windowMs?: number;
  /** Distinct throw sites tracked per id before the rest count as overflow. Defaults to 4. */
  maxKeysPerId?: number;
  /** Distinct throw sites tracked across all ids. Defaults to 32. */
  maxKeys?: number;
}

export interface BoundedErrorReporter {
  /** Record a throw from the callback registered as `id`. Never throws. */
  report(id: string, error: unknown): void;
  /**
   * Note a clean call for `id`. Declares recovery once the id has been quiet for a
   * whole window. Constant time and allocation-free for an id with nothing recorded,
   * since a dispatcher calls it for every callback on every tick. Never throws.
   */
  succeeded(id: string): void;
  /** Flush `id`'s unreported counts as one `warn` line and drop its keys. Never throws. */
  forget(id: string): void;
}

/** A counter that writes a summary line at most once per window. */
interface Counter {
  /** Throws since this counter's last line. */
  pending: number;
  /** When this counter last wrote a line. */
  lastLineAt: number;
  /** The site, for the summary line. */
  site: string;
  /** One line describing the most recent error, never a stack. */
  summary: string;
}

interface IdState {
  /** Tracked keys by throw site. */
  keys: Map<string, Counter>;
  /** Throws past a cap, counted together. */
  overflow: Counter | undefined;
  /** When the id last threw. */
  lastThrowAt: number;
  /** Every throw since the id was first recorded. */
  total: number;
}

interface Described {
  site: string;
  /** The full stack, or the one-line description when there is none. */
  detail: string;
  /** One line, no stack. */
  summary: string;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`createBoundedErrorReporter: ${name} must be a positive integer, got ${String(value)}`);
  }
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");

  return newline === -1 ? text : text.slice(0, newline);
}

function normaliseDigits(text: string): string {
  return text.replace(/\d+/g, "#");
}

/** A string property of `value`, or `undefined` when it is missing, not a string, or its getter throws. */
function stringProperty(value: object, key: "name" | "message" | "stack"): string | undefined {
  try {
    const property = (value as Record<string, unknown>)[key];

    return typeof property === "string" ? property : undefined;
  } catch {
    return undefined;
  }
}

function isError(value: object): boolean {
  try {
    return value instanceof Error;
  } catch {
    // A Proxy whose getPrototypeOf trap throws.
    return false;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/** A thrown non-Error object, as JSON when it has any, so `{ code: 3 }` reads better than `[object Object]`. */
function describeObject(value: object): string {
  try {
    const json = JSON.stringify(value);

    if (typeof json === "string" && json !== "{}") return truncate(json);
  } catch {
    // A cycle, a BigInt or a throwing getter: fall through.
  }

  return safeString(value);
}

/**
 * The first `at …` line of a V8 stack, trimmed and without its `at ` (the log lines say
 * "at <site>" themselves), or `undefined` when there is none.
 */
function firstFrame(stack: string): string | undefined {
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("at ")) return trimmed.slice(3);
  }

  return undefined;
}

/**
 * The key and the text for a throwable of any shape. An `Error` (or anything with a
 * string `stack`) is keyed on its first frame; anything else on its name and message
 * with the digits normalised.
 *
 * @internal Exported for testing
 */
export function describeThrowable(error: unknown): Described {
  if (typeof error === "object" && error !== null) {
    const errorInstance = isError(error);
    const name = stringProperty(error, "name") ?? (errorInstance ? "Error" : "object");
    const message = stringProperty(error, "message") ?? (errorInstance ? "" : describeObject(error));
    const stack = stringProperty(error, "stack");
    const heading = message === "" ? name : `${name}: ${message}`;
    const summary = truncate(firstLine(heading));
    const frame = stack === undefined ? undefined : firstFrame(stack);

    return {
      site: frame ?? normaliseDigits(heading),
      detail: stack ?? heading,
      summary,
    };
  }

  // A primitive: a string, a number, undefined, a symbol. Its type stands in for a name.
  const heading = `${typeof error}: ${safeString(error)}`;

  return { site: normaliseDigits(heading), detail: heading, summary: truncate(firstLine(heading)) };
}

function times(count: number): string {
  return count === 1 ? "1 time" : `${count} times`;
}

function moreTimes(count: number): string {
  return count === 1 ? "1 more time" : `${count} more times`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Create a reporter. See the module comment for the rules; the ids are opaque strings
 * the caller chooses (a dispatcher prefixes its own, such as `controller:update`).
 */
export function createBoundedErrorReporter(options: BoundedErrorReporterOptions): BoundedErrorReporter {
  const {
    logger,
    now = Date.now,
    windowMs = DEFAULT_ERROR_REPORT_WINDOW_MS,
    maxKeysPerId = DEFAULT_MAX_ERROR_KEYS_PER_ID,
    maxKeys = DEFAULT_MAX_ERROR_KEYS,
  } = options;

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`createBoundedErrorReporter: windowMs must be a positive number, got ${String(windowMs)}`);
  }

  assertPositiveInteger("maxKeysPerId", maxKeysPerId);
  assertPositiveInteger("maxKeys", maxKeys);

  const ids = new Map<string, IdState>();
  let keyCount = 0;

  const log = (level: "error" | "warn" | "info", message: string): void => {
    try {
      logger[level](message);
    } catch {
      // A throwing logger must not turn a reported error into an escaped one.
    }
  };

  const drop = (id: string, state: IdState): void => {
    keyCount -= state.keys.size;
    ids.delete(id);
  };

  const recover = (id: string, state: IdState, at: number): void => {
    log(
      "info",
      `${id} recovered: no errors for ${seconds(at - state.lastThrowAt)}, after ${times(state.total)} in all`,
    );
    drop(id, state);
  };

  /** Count a throw on a counter that already wrote its first line, summarising once per window. */
  const repeat = (id: string, counter: Counter, at: number, pastCap: boolean): void => {
    counter.pending++;

    if (at - counter.lastLineAt < windowMs) return;

    log(
      "warn",
      `${id} threw ${moreTimes(counter.pending)}${pastCap ? " past the cap" : ""} in the last ${seconds(at - counter.lastLineAt)}, latest at ${counter.site}: ${counter.summary}`,
    );
    counter.pending = 0;
    counter.lastLineAt = at;
  };

  const record = (id: string, error: unknown): void => {
    const at = now();
    let state = ids.get(id);

    // The quiet window ended before this throw: the old episode is over.
    if (state !== undefined && at - state.lastThrowAt >= windowMs) {
      recover(id, state, at);
      state = undefined;
    }

    if (state === undefined) {
      state = { keys: new Map(), overflow: undefined, lastThrowAt: at, total: 0 };
      ids.set(id, state);
    }

    state.lastThrowAt = at;
    state.total++;

    const described = describeThrowable(error);
    const known = state.keys.get(described.site);

    if (known !== undefined) {
      known.summary = described.summary;
      repeat(id, known, at, false);

      return;
    }

    if (state.keys.size < maxKeysPerId && keyCount < maxKeys) {
      state.keys.set(described.site, { pending: 0, lastLineAt: at, site: described.site, summary: described.summary });
      keyCount++;
      log("error", `${id} threw: ${described.detail}`);

      return;
    }

    if (state.overflow !== undefined) {
      state.overflow.site = described.site;
      state.overflow.summary = described.summary;
      repeat(id, state.overflow, at, true);

      return;
    }

    state.overflow = { pending: 0, lastLineAt: at, site: described.site, summary: described.summary };

    const cap =
      state.keys.size >= maxKeysPerId
        ? `the cap of ${maxKeysPerId} error sites per id`
        : `the cap of ${maxKeys} error sites in all`;

    log(
      "warn",
      `${id} reached ${cap}; further new sites are counted, not logged. First past the cap: ${described.summary} at ${described.site}`,
    );
  };

  return {
    report(id: string, error: unknown): void {
      try {
        record(id, error);
      } catch {
        // The reporter sits inside a catch block; it must never throw out of one.
      }
    },

    succeeded(id: string): void {
      const state = ids.get(id);

      if (state === undefined) return;

      try {
        const at = now();

        if (at - state.lastThrowAt >= windowMs) recover(id, state, at);
      } catch {
        // See report.
      }
    },

    forget(id: string): void {
      const state = ids.get(id);

      if (state === undefined) return;

      try {
        let pending = state.overflow?.pending ?? 0;

        for (const counter of state.keys.values()) pending += counter.pending;

        if (pending > 0) {
          log("warn", `${id} forgotten with ${times(pending)} not yet reported (${times(state.total)} in all)`);
        }
      } catch {
        // See report.
      } finally {
        drop(id, state);
      }
    },
  };
}
