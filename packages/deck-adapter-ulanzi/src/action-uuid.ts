/**
 * Action-UUID namespacing for Ulanzi.
 *
 * UlanziStudio requires every plugin UUID to be exactly four dot-segments under
 * `com.ulanzi.ulanzistudio.*`, and each action UUID to extend it. iRaceDeck's
 * actions, however, export canonical Elgato-style UUID constants under
 * `com.iracedeck.sd.core.*` (shared verbatim with the Mirabox plugin). Rather
 * than fork the action constants per platform, the Ulanzi plugin rewrites the
 * canonical prefix to the Ulanzi namespace at registration time, and the Ulanzi
 * `manifest.json` declares the same rewritten UUIDs. Actions stay untouched.
 */

/** The Ulanzi plugin's 4-segment main UUID (the manifest `UUID`). */
export const ULANZI_PLUGIN_UUID = "com.ulanzi.ulanzistudio.iracedeck";

/** The canonical plugin-UUID prefix every iRaceDeck action constant shares. */
const CANONICAL_PLUGIN_UUID = "com.iracedeck.sd.core";

/**
 * Map a canonical iRaceDeck action UUID to its Ulanzi equivalent.
 *
 * - `com.iracedeck.sd.core` → `com.ulanzi.ulanzistudio.iracedeck`
 * - `com.iracedeck.sd.core.black-box-selector` → `com.ulanzi.ulanzistudio.iracedeck.black-box-selector`
 *
 * A UUID that does not start with the canonical prefix is returned unchanged, so
 * an already-Ulanzi UUID (or any unexpected value) passes through idempotently.
 */
export function toUlanziActionUuid(canonicalUuid: string): string {
  if (canonicalUuid === CANONICAL_PLUGIN_UUID) {
    return ULANZI_PLUGIN_UUID;
  }

  if (canonicalUuid.startsWith(`${CANONICAL_PLUGIN_UUID}.`)) {
    return `${ULANZI_PLUGIN_UUID}${canonicalUuid.slice(CANONICAL_PLUGIN_UUID.length)}`;
  }

  return canonicalUuid;
}
