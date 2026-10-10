/**
 * JSON-safe encoder (#1387): turns any value into plain JSON data before it is
 * written into a Telemetry Snapshot.
 *
 * `JSON.stringify` never emits invalid JSON, but on live plugin state it either
 * throws (a `BigInt`, a cycle), which would lose the whole file, or silently
 * misreports (`Set` and `Map` become `{}`, `NaN` becomes `null`). The encoder
 * runs first, so what it returns is exactly what the file holds:
 *
 * | Value | Encoded as |
 * | --- | --- |
 * | Finite number, string, boolean, `null` | Itself (`-0` as `0`, which is all JSON text keeps of it) |
 * | `NaN`, `Infinity`, `-Infinity` | The strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
 * | `undefined`, function, symbol | Omitted as a property, `null` as an array element or hole |
 * | `BigInt` | Its decimal string |
 * | `Date` | ISO string (`"Invalid Date"` for an invalid one) |
 * | `Set` | Array of its members |
 * | `Map` | Array of `[key, value]` pairs |
 * | Typed array | Plain array |
 * | `Error` | `{ name, message }` |
 * | Any other non-plain object | The string `"[<constructor name>]"` |
 * | A reference to one of its own ancestors | `"[Circular]"` |
 * | A container more than {@link JSON_SAFE_MAX_DEPTH} levels below the root | `"[MaxDepth]"` |
 *
 * Only ancestors count as a cycle: the same object reached twice by different
 * paths is encoded twice.
 *
 * **It can throw**, in two cases, and the caller isolates the failure, as
 * `collectStateSections` does per section:
 *
 * - It reads the value's own enumerable properties, so a getter that throws (or
 *   a Proxy trap) throws out of {@link toJsonSafe}. The encoder does not guess
 *   a placeholder for state it could not read.
 * - A value of more than {@link JSON_SAFE_MAX_VALUES} values is refused with a
 *   `RangeError`. Depth and the ancestor check bound neither a wide value nor
 *   a graph of objects that reference each other: every path through such a
 *   graph is encoded, and the paths multiply by about the node count per node
 *   added, so nine cross-linked objects already take most of a second. The
 *   encoder runs on the plugin's main thread at a key press, so it stops
 *   counting instead of finishing.
 *
 * Decision record: `docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md`.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Containers nested more than this many levels below the root are replaced by a marker. */
export const JSON_SAFE_MAX_DEPTH = 32;

/**
 * The most values one {@link toJsonSafe} call visits before it throws: every
 * container and every primitive counts, array holes included. The largest real
 * section is about 150,000 (the gap traces of a 64-car field), and a field can
 * be larger than that.
 */
export const JSON_SAFE_MAX_VALUES = 2_000_000;

const OMIT = Symbol("omit");
type Encoded = JsonValue | typeof OMIT;

const orNull = (value: Encoded): JsonValue => (value === OMIT ? null : value);

/** One call's bookkeeping. Made per call, so a call that throws leaves nothing for the next one. */
type Run = {
  /** The containers being encoded, outermost first. */
  ancestors: object[];
  /** How many values have been visited so far. */
  visited: number;
};

/**
 * Turns any value into plain JSON data: nothing it returns can make
 * `JSON.stringify` throw or silently misreport (issue #1387).
 *
 * The result shares no container with the input. A value with no JSON form at
 * the top level (`undefined`, a function, a symbol) is `null`.
 *
 * @throws Whatever a getter of the value throws, and a `RangeError` past {@link JSON_SAFE_MAX_VALUES} values.
 */
export function toJsonSafe(value: unknown): JsonValue {
  return orNull(encode(value, { ancestors: [], visited: 0 }, 0));
}

/** The name a non-plain object is reported under. */
function constructorName(obj: object): string {
  const name: unknown = (obj as { constructor?: { name?: unknown } }).constructor?.name;

  // A class may shadow `name` with a static of any type.
  return typeof name === "string" && name ? name : "Object";
}

function encode(value: unknown, run: Run, depth: number): Encoded {
  if (++run.visited > JSON_SAFE_MAX_VALUES) {
    throw new RangeError(
      `State holds more than ${JSON_SAFE_MAX_VALUES} values: it is too large to snapshot, or its objects reference each other`,
    );
  }

  const { ancestors } = run;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // A non-finite figure is usually the defect being hunted; `null` would hide it.
      if (!Number.isFinite(value)) return String(value);

      // JSON text has no negative zero, so the value in hand would differ from the one in the file.
      return value === 0 ? 0 : value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return OMIT;
  }

  if (value === null) return null;

  const obj = value as object;

  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();

  // Both are strings on any Error the language makes, but they are assignable to anything.
  if (obj instanceof Error) return { name: String(obj.name), message: String(obj.message) };

  if (ancestors.includes(obj)) return "[Circular]";

  if (depth > JSON_SAFE_MAX_DEPTH) return "[MaxDepth]";

  ancestors.push(obj);

  try {
    const member = (m: unknown): JsonValue => orNull(encode(m, run, depth + 1));

    // Array.from visits holes as undefined, so a sparse array keeps its length and index alignment.
    if (Array.isArray(obj)) return Array.from(obj, member);

    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      return Array.from(obj as unknown as ArrayLike<unknown>, member);
    }

    if (obj instanceof Set) return Array.from(obj, member);

    if (obj instanceof Map) return Array.from(obj, ([k, v]) => [member(k), member(v)]);

    const proto: unknown = Object.getPrototypeOf(obj);

    if (proto !== Object.prototype && proto !== null) return `[${constructorName(obj)}]`;

    const out: { [key: string]: JsonValue } = {};

    for (const key of Object.keys(obj)) {
      const encoded = encode((obj as Record<string, unknown>)[key], run, depth + 1);

      if (encoded === OMIT) continue;

      // Assigning to `__proto__` would set the prototype and drop the key; `JSON.parse` makes it an own key.
      if (key === "__proto__") {
        Object.defineProperty(out, key, { value: encoded, enumerable: true, writable: true, configurable: true });
      } else {
        out[key] = encoded;
      }
    }

    return out;
  } finally {
    ancestors.pop();
  }
}
