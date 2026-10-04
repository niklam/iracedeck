/**
 * Template Context Reference (#1339) — TEST-ONLY ORACLE
 *
 * The eager ASSEMBLY of the template context as it stood before #1339 made it
 * lazy: every namespace built up front, telemetry and session info flattened
 * whole, and the lot prefixed into one display map and one raw map. The
 * equivalence test compares every key it produces with what the lazy context
 * answers for the same path.
 *
 * #1339 changed only the assembly, so only the assembly is copied here, verbatim:
 * the eager orchestration of `buildTemplateContextFromData`, `prefixKeys`, and
 * `flattenContext` with its per-leaf rule and its own `BOOLEAN_INT_FIELDS`. The
 * field builders it composes (driver, self, session and track fields, the driver
 * finders, `fieldsToMaps`) are the unchanged production ones, imported from
 * `template-context.ts`, so the comparison tests how they are assembled rather
 * than repeating them. It deliberately imports nothing from the lazy path — not
 * `formatLeaf`, not the walk, not the namespace builders — so a drift in the
 * walk's leaf formatting shows up as a failing comparison instead of moving both
 * sides together. One adjustment: `session.sof` has had its own builder since
 * #1339, and is still computed eagerly here.
 *
 * Never import it from production code, and never export it from `index.ts`.
 * Freeze it: a change to template output is made in `template-context.ts` and
 * the comparison then fails until the expectation is updated deliberately.
 */
import type { ExpressionValue } from "./expression-evaluator.js";
import { extractQualifyResults } from "./grid-utils.js";
import { estimateIRatingChanges, type IRatingEstimates, resolveIRatingEstimateOrder } from "./irating-utils.js";
import {
  buildDriverFields,
  buildSelfFields,
  buildSessionFields,
  buildSessionSofFields,
  buildTrackFields,
  type DriverEntry,
  EMPTY_DRIVER_FIELDS,
  extractDrivers,
  extractPlayerCarIdx,
  type FieldMaps,
  fieldsToMaps,
  findDriverByCamCarIdx,
  findDriverByRacePosition,
  findNearestDriverOnTrack,
  getCurrentSession,
} from "./template-context.js";
import type { SessionInfo, TelemetryData } from "./types.js";

/** Value type for raw template-context entries. */
type TemplateValue = ExpressionValue;

/**
 * Flat template maps — all keys use dot-notation (e.g., "self.name", "telemetry.Speed").
 */
export interface ReferenceTemplateMaps {
  /** Display-formatted strings used by plain {{var}} placeholders. */
  display: Record<string, string>;
  /** Full-precision raw values used by {{= expr }} expressions. */
  raw: Record<string, TemplateValue>;
}

/**
 * Field names that are integers (0/1) but represent boolean values.
 * These get converted to "Yes"/"No" instead of "0"/"1".
 */
const BOOLEAN_INT_FIELDS = new Set([
  "IsOnTrack",
  "IsOnTrackCar",
  "IsReplayPlaying",
  "IsInGarage",
  "IsDiskLoggingEnabled",
  "IsDiskLoggingActive",
  "PlayerCarDryTireSetAvailable",
  "DriverMarker",
  "PushToPass",
  "PushToTalk",
  "OnPitRoad",
  "PitstopActive",
  "PlayerCarInPitStall",
]);

interface FlattenOptions {
  excludePrefix?: string;
}

/**
 * Flattens a nested object into dot-notation keys, producing both maps in one walk:
 * display-formatted strings (floats rounded to 2 decimals, booleans and known
 * boolean-semantic integers as Yes/No) and full-precision raw values (numbers stay
 * numbers — including BOOLEAN_INT_FIELDS, which stay 0/1 — booleans stay booleans,
 * strings stay strings). Skips arrays and filters keys by prefix.
 */
function flattenContext(obj: Record<string, unknown>, options?: FlattenOptions): FieldMaps {
  const display: Record<string, string> = {};
  const raw: Record<string, TemplateValue> = {};
  const prefix = options?.excludePrefix;

  function walk(current: Record<string, unknown>, path: string): void {
    for (const key of Object.keys(current)) {
      if (prefix && key.startsWith(prefix)) continue;

      const value = current[key];
      const fullKey = path ? `${path}.${key}` : key;

      if (Array.isArray(value)) continue;

      if (value !== null && value !== undefined && typeof value === "object") {
        walk(value as Record<string, unknown>, fullKey);
        continue;
      }

      if (typeof value === "boolean") {
        display[fullKey] = value ? "Yes" : "No";
        raw[fullKey] = value;
      } else if (typeof value === "number") {
        const leafKey = fullKey.includes(".") ? fullKey.substring(fullKey.lastIndexOf(".") + 1) : fullKey;

        if (BOOLEAN_INT_FIELDS.has(leafKey) && (value === 0 || value === 1)) {
          display[fullKey] = value === 1 ? "Yes" : "No";
        } else {
          display[fullKey] = Number.isInteger(value) ? String(value) : value.toFixed(2);
        }

        raw[fullKey] = value;
      } else if (typeof value === "string") {
        display[fullKey] = value;
        raw[fullKey] = value;
      } else if (value !== null && value !== undefined) {
        // Exotic primitive (e.g. bigint): display only — not a valid expression value.
        display[fullKey] = String(value);
      }
    }
  }

  walk(obj, "");

  return { display, raw };
}

/**
 * Prefixes all keys in a record with a given prefix.
 */
function prefixKeys<T>(prefix: string, record: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};

  for (const [key, value] of Object.entries(record)) {
    result[`${prefix}.${key}`] = value;
  }

  return result;
}

/**
 * Builds the display/raw field-map pair for one relative-driver group
 * (`track_ahead`, `race_behind`, `focused`, …). A null driver — no car in that
 * slot — yields the empty field set, so every key renders "".
 */
function driverMaps(
  driver: DriverEntry | null,
  telemetry: TelemetryData | null,
  order?: number[],
  playerCarIdx?: number,
  estimates?: IRatingEstimates,
): FieldMaps {
  return fieldsToMaps(
    driver ? buildDriverFields(driver, telemetry, order, playerCarIdx, estimates) : { ...EMPTY_DRIVER_FIELDS },
  );
}

/**
 * Builds template context from raw telemetry and session data.
 * Returns the combined { display, raw } context with dot-notation keys in both maps.
 */
export function buildReferenceTemplateMaps(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
  livePositions?: number[] | null,
): ReferenceTemplateMaps {
  const drivers = extractDrivers(sessionInfo);
  const playerCarIdx = extractPlayerCarIdx(sessionInfo);

  // SINGLE SOURCE OF TRUTH for race position: the translator's canonical live
  // race order (1-based, indexed by carIdx) — the same order Session Info derives
  // from. The template NEVER computes its own order. Race sessions use the
  // injected order; otherwise (non-race, or before it's available) every prefix
  // falls back per-car to iRacing's official CarIdxPosition. One coherent order
  // means a strict 1..N ranking, so neighbour selection can't hit duplicate
  // ranks (issue #710). See @.claude/rules/race-positions.md.
  const sessionType = getCurrentSession(sessionInfo, telemetry)?.SessionType as string | undefined;
  const liveOrder = livePositions && livePositions.length > 0 ? livePositions : undefined;
  const order = sessionType === "Race" ? liveOrder : undefined;

  // Estimated iRating change per car ("if the race ended now", #268) — the
  // order input is widened beyond the position `order` above (#872): qualifying
  // and race pre-green resolve through the official counters / qualifying grid,
  // anchored on the player so the pre-green source holds through the green-flag
  // run to the line, while a usable live order stays authoritative. Gated on
  // telemetry: without CarIdxClass a multiclass field would be scored as one
  // combined class. Memoized inside the estimator so the O(n²) math only
  // re-runs when positions actually change.
  const estimateOrder = telemetry
    ? resolveIRatingEstimateOrder({
        sessionType,
        liveOrder,
        officialPositions: telemetry.CarIdxPosition as number[] | undefined,
        qualifyResults: extractQualifyResults(sessionInfo),
        playerCarIdx,
      })
    : null;
  const estimates = estimateOrder
    ? estimateIRatingChanges({
        drivers,
        order: estimateOrder,
        carIdxClass: telemetry?.CarIdxClass as number[] | undefined,
      })
    : undefined;

  const selfDriver = drivers.find((d) => d.CarIdx === playerCarIdx);
  const self = fieldsToMaps(buildSelfFields(selfDriver, playerCarIdx, telemetry, order, estimates));

  const trackAhead = driverMaps(
    findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "ahead"),
    telemetry,
    order,
    playerCarIdx,
    estimates,
  );
  const trackBehind = driverMaps(
    findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "behind"),
    telemetry,
    order,
    playerCarIdx,
    estimates,
  );
  const raceAhead = driverMaps(
    findDriverByRacePosition(playerCarIdx, drivers, telemetry, -1, order),
    telemetry,
    order,
    playerCarIdx,
    estimates,
  );
  const raceBehind = driverMaps(
    findDriverByRacePosition(playerCarIdx, drivers, telemetry, +1, order),
    telemetry,
    order,
    playerCarIdx,
    estimates,
  );
  // `focused` can resolve to the player's own car (camera on you) — passing
  // playerCarIdx makes it use the same player-authoritative fields as `self`.
  const focused = driverMaps(findDriverByCamCarIdx(drivers, telemetry), telemetry, order, playerCarIdx, estimates);

  // The pre-#1339 `buildSessionFields` returned `sof` with the other session
  // fields, from the estimates computed above; its two halves compose to it.
  const sessionClock = buildSessionFields(sessionInfo, telemetry);
  const sessionSof = buildSessionSofFields(playerCarIdx, estimates);
  const sessionFields: FieldMaps = {
    display: { ...sessionClock.display, ...sessionSof.display },
    raw: { ...sessionClock.raw, ...sessionSof.raw },
  };
  const trackFields = buildTrackFields(sessionInfo);

  const telemetryMaps = telemetry
    ? flattenContext(telemetry as unknown as Record<string, unknown>, { excludePrefix: "CarIdx" })
    : { display: {}, raw: {} };
  const sessionInfoMaps = sessionInfo
    ? flattenContext(sessionInfo as unknown as Record<string, unknown>)
    : { display: {}, raw: {} };

  return {
    display: {
      ...prefixKeys("self", self.display),
      ...prefixKeys("track_ahead", trackAhead.display),
      ...prefixKeys("track_behind", trackBehind.display),
      ...prefixKeys("race_ahead", raceAhead.display),
      ...prefixKeys("race_behind", raceBehind.display),
      ...prefixKeys("focused", focused.display),
      ...prefixKeys("session", sessionFields.display),
      ...prefixKeys("track", trackFields),
      ...prefixKeys("telemetry", telemetryMaps.display),
      ...prefixKeys("sessionInfo", sessionInfoMaps.display),
    },
    raw: {
      ...prefixKeys("self", self.raw),
      ...prefixKeys("track_ahead", trackAhead.raw),
      ...prefixKeys("track_behind", trackBehind.raw),
      ...prefixKeys("race_ahead", raceAhead.raw),
      ...prefixKeys("race_behind", raceBehind.raw),
      ...prefixKeys("focused", focused.raw),
      ...prefixKeys("session", sessionFields.raw),
      ...prefixKeys("track", trackFields),
      ...prefixKeys("telemetry", telemetryMaps.raw),
      ...prefixKeys("sessionInfo", sessionInfoMaps.raw),
    },
  };
}
