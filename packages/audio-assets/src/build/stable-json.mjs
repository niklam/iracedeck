/**
 * One JSON serialization for anything whose BYTES matter — the archived
 * `voice-pack.json`, and every identity the pack record hashes (#1034, #1667).
 *
 * A leaf on purpose: `index.mjs` (the `./build` export the plugin builds load)
 * hashes the pipeline identity through this, and must not pull in the packer's
 * `fflate` for it — a devDependency the plugin builds never install.
 */

/**
 * `value` with every object's keys sorted, at every depth. Arrays keep their
 * order: an argument list or an entry list is ordered data.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map(sortKeysDeep));

  if (value !== null && typeof value === "object") {
    return /** @type {T} */ (
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key])]),
      )
    );
  }

  return value;
}

/**
 * JSON with keys sorted at every depth, two-space indent, LF line endings and
 * a trailing newline. `JSON.stringify` writes keys in insertion order, so two
 * code paths building the same object in different orders would otherwise
 * produce two different byte strings — two different archives, or two
 * different digests of one identity.
 *
 * @param {unknown} value
 */
export function serializeSortedJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
