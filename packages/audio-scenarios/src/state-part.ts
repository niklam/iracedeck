/**
 * Reading one part of the Race Engineer's snapshot state on its own (issue
 * #1387).
 *
 * The Telemetry Snapshot's collector isolates per SECTION: a throw out of the
 * `raceEngineer` reader replaces the whole section with an error entry. The
 * section is many independent reads — the engine, two closures it was handed,
 * eleven families — so one of them throwing would take the buses, the queue
 * and every other family out of the one file a support case has. Each part is
 * therefore read through {@link readStatePart}: it is its state, or an
 * `{ error }` entry saying why it is not.
 *
 * A leaf, importing nothing: the interpreter and the catalog both read parts.
 * The reason text restates the collector's `describeThrown`
 * (`@iracedeck/diagnostics`, which this package does not import), so an error
 * entry reads the same whoever wrote it.
 */

/**
 * What stands in for a part that could not be read. Never a healthy shape:
 * no part's own state has an `error` key, and the reason is never empty.
 */
export type StatePartError = { error: string };

/** The reason given when what was thrown says nothing usable about itself. */
const UNKNOWN_REASON = "unknown error";

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
 * Why something failed, as a string that is never empty: a thrown primitive's
 * own text, else the thrown object's `message`, else its `name`, else a fixed
 * text. Total — it runs inside a `catch`, where a second throw would lose the
 * part it is reporting, and anything can be thrown.
 *
 * @internal Exported for testing
 */
export function describeThrownValue(thrown: unknown): string {
  try {
    if (typeof thrown !== "object" || thrown === null) return textOf(thrown) || UNKNOWN_REASON;

    const { message, name } = thrown as { message?: unknown; name?: unknown };

    return textOf(message) || textOf(name) || UNKNOWN_REASON;
  } catch {
    // A getter or a Proxy trap on the thrown value.
    return UNKNOWN_REASON;
  }
}

/**
 * Run one read and return what it returns, or — when it throws — the error
 * entry that takes the part's place. Never throws and never logs: a reader
 * runs at a key press, and the failure is in the data.
 */
export function readStatePart<T>(read: () => T): T | StatePartError {
  try {
    return read();
  } catch (thrown) {
    return { error: describeThrownValue(thrown) };
  }
}

/** Whether a part is the error entry of a failed read rather than its state. Never throws. */
export function isStatePartError(part: unknown): part is StatePartError {
  try {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return false;

    const { error } = part as { error?: unknown };

    return typeof error === "string" && error !== "";
  } catch {
    return false;
  }
}
