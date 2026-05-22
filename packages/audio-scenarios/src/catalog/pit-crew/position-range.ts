/**
 * Speakable position-number range — leaf module (no intra-catalog deps).
 *
 * Extracted from position.ts (issue #566) so both position.ts and the shared
 * position-readout.ts (issue #574) can import the range primitives without a
 * circular dependency (position.ts ↔ position-readout.ts). position.ts
 * re-exports these for backward compatibility.
 */

/**
 * Inclusive announceable range. The voice config ships `position-number/1..64`
 * to cover the full iRacing field-size spectrum (the largest oval splits sit
 * around 60 cars). Positions outside this range cause the readout to stay
 * silent rather than produce a partial line. Expand the bounds together with
 * the voice config group.
 */
export const POSITION_NUMBER_MIN = 1;
export const POSITION_NUMBER_MAX = 64;

/** Whether `n` is inside the speakable clip range. */
export function positionNumberIsSpeakable(n: number): boolean {
  return Number.isInteger(n) && n >= POSITION_NUMBER_MIN && n <= POSITION_NUMBER_MAX;
}
