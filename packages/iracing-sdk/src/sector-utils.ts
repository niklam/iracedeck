/**
 * The track's SECTORS, as iRacing publishes them in session YAML (issue #1573).
 *
 * `SplitTimeInfo.Sectors` is a top-level session-YAML key (a sibling of
 * `WeekendInfo`): one `{ SectorNum, SectorStartPct }` entry per sector, where
 * `SectorStartPct` is the lap fraction (`LapDistPct`) at which the sector
 * begins. These are the sectors iRacing's own timing splits use. Measured
 * across 21 track configurations (2026-11-01): every one starts its first
 * sector at 0.0000, the start/finish line, with two sectors on an oval up to
 * seven at Le Mans.
 *
 * The translator caches the result per `(TrackID, SessionNum)` and serves it
 * through `getTrackSectors()` (`@iracedeck/sim-events-iracing`), the one place
 * any feature reads the sectors.
 */

/**
 * How far from 0 the first sector may start and still count as starting at the
 * start/finish line: iRacing prints the fraction with six decimals, so this
 * absorbs only a print or parse artefact, never a real offset.
 */
const FIRST_SECTOR_AT_LINE_TOLERANCE = 1e-6;

/**
 * Read the sector start fractions from parsed session info, ordered by
 * `SectorNum` (index 0 is the sector that starts at the line).
 *
 * Returns `null`, and no sector feature runs, unless the data describes a lap
 * that can be counted from the start/finish line:
 *
 * - `SplitTimeInfo.Sectors` is a non-empty list of records, each with a
 *   numeric `SectorNum` and a finite `SectorStartPct` in `[0, 1)`;
 * - sorted by `SectorNum`, the start fractions strictly ascend (no repeated or
 *   backwards start);
 * - the first start is 0, within {@link FIRST_SECTOR_AT_LINE_TOLERANCE}
 *   (returned as exactly 0).
 *
 * A track whose first sector does not start at the line gets `null` rather
 * than a sector model nobody has measured. Never throws: session YAML can hold
 * null list items and junk values, and this runs from the translator's tick.
 *
 * @param sessionInfo the parsed session YAML (`SDKController.getSessionInfo()`)
 * @returns the sector start fractions, `[0]` for a one-sector track, or `null`
 */
export function extractSectorStarts(sessionInfo: unknown): number[] | null {
  const splitTimeInfo = (sessionInfo as Record<string, unknown> | null | undefined)?.SplitTimeInfo as
    Record<string, unknown> | null | undefined;
  const sectors = splitTimeInfo?.Sectors;

  if (!Array.isArray(sectors) || sectors.length === 0) return null;

  const entries: { num: number; start: number }[] = [];

  for (const raw of sectors as unknown[]) {
    if (raw === null || typeof raw !== "object") return null;

    const { SectorNum: num, SectorStartPct: start } = raw as Record<string, unknown>;

    if (typeof num !== "number" || !Number.isFinite(num)) return null;

    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || start >= 1) return null;

    entries.push({ num, start });
  }

  entries.sort((a, b) => a.num - b.num);

  const starts = entries.map((e) => e.start);

  if (Math.abs(starts[0]!) > FIRST_SECTOR_AT_LINE_TOLERANCE) return null;

  // At the line, exactly: a consumer counting sectors from the start/finish
  // line compares against 0, not against a print artefact.
  starts[0] = 0;

  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! <= starts[i - 1]!) return null;
  }

  return starts;
}
