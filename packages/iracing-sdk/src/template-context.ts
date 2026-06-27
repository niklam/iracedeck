/**
 * Template Context Builder
 *
 * Assembles a template variable context from iRacing telemetry and session data.
 * Used by resolveTemplate() to hydrate {{variable}} placeholders (display map)
 * and {{= expression }} calculations (raw map).
 */
import type { ExpressionValue } from "./expression-evaluator.js";
import { calculateRacePositions, classPositionFromOrder } from "./position-utils.js";
import type { SDKController } from "./SDKController.js";
import { findNearestCarOnTrack } from "./track-utils.js";
import type { SessionInfo, TelemetryData } from "./types.js";

/** Value type for raw template-context entries. */
export type TemplateValue = ExpressionValue;

/**
 * Flat template context — all keys use dot-notation (e.g., "self.name", "telemetry.Speed").
 */
export interface TemplateContext {
  /** Display-formatted strings used by plain {{var}} placeholders. */
  display: Record<string, string>;
  /** Full-precision raw values used by {{= expr }} expressions. */
  raw: Record<string, TemplateValue>;
}

/**
 * A display/raw map pair for one context namespace.
 */
interface FieldMaps {
  display: Record<string, string>;
  raw: Record<string, TemplateValue>;
}

/**
 * Raw driver field values — numeric fields stay numbers until display formatting.
 * `undefined` means "unavailable": display renders "", raw omits the key.
 */
type DriverFieldValue = string | number | undefined;

/**
 * Shared fields available for all driver groups.
 *
 * Must stay a `type` alias (not `interface`): only aliases get the implicit
 * index signature needed for assignability to `Record<string, DriverFieldValue>`
 * in `fieldsToMaps`.
 */
type DriverFields = {
  name: string;
  first_name: string;
  last_name: string;
  abbrev_name: string;
  car_number: string;
  position: number | undefined;
  class_position: number | undefined;
  lap: number | undefined;
  laps_completed: number | undefined;
  irating: number | undefined;
  license: string;
};

/**
 * Self driver extends DriverFields with additional player-specific data.
 */
type SelfDriverFields = DriverFields & {
  incidents: number | undefined;
};

interface DriverEntry {
  CarIdx: number;
  UserName: string;
  AbbrevName: string;
  CarNumber: string;
  IRating: number;
  LicString: string;
  IsSpectator: number;
  CarIsPaceCar: number;
}

const EMPTY_DRIVER_FIELDS: DriverFields = {
  name: "",
  first_name: "",
  last_name: "",
  abbrev_name: "",
  car_number: "",
  position: undefined,
  class_position: undefined,
  lap: undefined,
  laps_completed: undefined,
  irating: undefined,
  license: "",
};

const EMPTY_SELF_FIELDS: SelfDriverFields = {
  ...EMPTY_DRIVER_FIELDS,
  incidents: undefined,
};

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
 * @internal Exported for testing
 *
 * Flattens a nested object into dot-notation keys, producing both maps in one walk:
 * display-formatted strings (floats rounded to 2 decimals, booleans and known
 * boolean-semantic integers as Yes/No) and full-precision raw values (numbers stay
 * numbers — including BOOLEAN_INT_FIELDS, which stay 0/1 — booleans stay booleans,
 * strings stay strings). Skips arrays and filters keys by prefix.
 */
export function flattenContext(obj: Record<string, unknown>, options?: FlattenOptions): FieldMaps {
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
 * Builds the full template context from current SDK state.
 */
export function buildTemplateContext(sdkController: SDKController): TemplateContext {
  const telemetry = sdkController.getCurrentTelemetry();
  const sessionInfo = sdkController.getSessionInfo();

  return buildTemplateContextFromData(telemetry, sessionInfo, sdkController.getLiveRacePositions());
}

/**
 * @internal Exported for testing
 *
 * Prefixes all keys in a record with a given prefix.
 */
export function prefixKeys<T>(prefix: string, record: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};

  for (const [key, value] of Object.entries(record)) {
    result[`${prefix}.${key}`] = value;
  }

  return result;
}

/**
 * Converts a raw driver fields record into the display/raw map pair.
 * Display keeps every key (null/undefined render ""); raw omits null/undefined
 * keys so expressions referencing them fail as unknown variables (rendering "").
 * Runtime nulls from YAML session data are treated like undefined.
 */
function fieldsToMaps(fields: Record<string, DriverFieldValue>): FieldMaps {
  const display: Record<string, string> = {};
  const raw: Record<string, TemplateValue> = {};

  for (const [key, value] of Object.entries(fields)) {
    display[key] = value != null ? String(value) : "";

    if (value != null) {
      raw[key] = value;
    }
  }

  return { display, raw };
}

/**
 * Builds the display/raw field-map pair for one relative-driver group
 * (`track_ahead`, `race_behind`, `focused`, …). A null driver — no car in that
 * slot — yields the empty field set, so every key renders "".
 */
function driverMaps(
  driver: DriverEntry | null,
  telemetry: TelemetryData | null,
  positions?: number[],
  order?: number[],
  playerCarIdx?: number,
): FieldMaps {
  return fieldsToMaps(
    driver ? buildDriverFields(driver, telemetry, positions, order, playerCarIdx) : { ...EMPTY_DRIVER_FIELDS },
  );
}

/**
 * @internal Exported for testing
 *
 * Builds template context from raw telemetry and session data.
 * Returns the combined { display, raw } context with dot-notation keys in both maps.
 */
export function buildTemplateContextFromData(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
  livePositions?: number[] | null,
): TemplateContext {
  const drivers = extractDrivers(sessionInfo);
  const playerCarIdx = extractPlayerCarIdx(sessionInfo);

  // The live per-car race order (1-based, indexed by carIdx) drives both the
  // overall position and the derived class position. Prefer the injected order
  // (the translator's frozen live standings — towed/finished cars kept at their
  // rank, matching the Session Info display) and fall back to the locally
  // calculated lap-progress order. Race sessions only: in non-race the lap order
  // isn't the standings, so positions come straight from iRacing's CarIdx* counters.
  const liveOrder = livePositions && livePositions.length > 0 ? livePositions : undefined;
  const rawOrder = isRaceSession(sessionInfo, telemetry) ? (liveOrder ?? calculateRacePositions(telemetry)) : [];
  const order = rawOrder.length > 0 ? rawOrder : undefined;
  // Pit-blended standings: a car on pit road holds its official position rather
  // than its (demoted) on-track lap-order slot. Drives driver selection and the
  // overall position field; class position is derived from the pure `order`.
  const positions = order ? resolveRacePositions(telemetry, order) : undefined;

  const selfDriver = drivers.find((d) => d.CarIdx === playerCarIdx);
  const self = fieldsToMaps(buildSelfFields(selfDriver, playerCarIdx, telemetry, positions, order));

  const trackAhead = driverMaps(
    findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "ahead"),
    telemetry,
    positions,
    order,
    playerCarIdx,
  );
  const trackBehind = driverMaps(
    findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "behind"),
    telemetry,
    positions,
    order,
    playerCarIdx,
  );
  const raceAhead = driverMaps(
    findDriverByRacePosition(playerCarIdx, drivers, telemetry, -1, positions),
    telemetry,
    positions,
    order,
    playerCarIdx,
  );
  const raceBehind = driverMaps(
    findDriverByRacePosition(playerCarIdx, drivers, telemetry, +1, positions),
    telemetry,
    positions,
    order,
    playerCarIdx,
  );
  // `focused` can resolve to the player's own car (camera on you) — passing
  // playerCarIdx makes it use the same player-authoritative fields as `self`.
  const focused = driverMaps(findDriverByCamCarIdx(drivers, telemetry), telemetry, positions, order, playerCarIdx);

  const sessionFields = buildSessionFields(sessionInfo, telemetry);
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

/**
 * @internal Exported for testing
 */
export function splitDriverName(userName: string): { firstName: string; lastName: string } {
  const trimmed = userName.trim();
  const spaceIndex = trimmed.indexOf(" ");

  if (spaceIndex === -1) return { firstName: trimmed, lastName: "" };

  return {
    firstName: trimmed.substring(0, spaceIndex),
    lastName: trimmed.substring(spaceIndex + 1),
  };
}

/**
 * @internal Exported for testing
 *
 * Finds the physically closest driver on track in a given direction.
 * Delegates to findNearestCarOnTrack with a filter that excludes pace car and spectators.
 */
export function findNearestDriverOnTrack(
  playerCarIdx: number,
  drivers: DriverEntry[],
  telemetry: TelemetryData | null,
  direction: "ahead" | "behind",
): DriverEntry | null {
  // Build a set of car indices to skip (pace car, spectators)
  const skipIndices = new Set<number>();

  for (const driver of drivers) {
    if (driver.CarIsPaceCar === 1 || driver.IsSpectator === 1) {
      skipIndices.add(driver.CarIdx);
    }
  }

  const carIdx = findNearestCarOnTrack(telemetry, playerCarIdx, direction, {
    skipIdx: (idx) => skipIndices.has(idx),
  });

  if (carIdx === null) return null;

  return drivers.find((d) => d.CarIdx === carIdx) ?? null;
}

/**
 * @internal Exported for testing
 *
 * Finds a driver by race position relative to the player.
 * offset: -1 for position ahead, +1 for position behind.
 */
export function findDriverByRacePosition(
  playerCarIdx: number,
  drivers: DriverEntry[],
  telemetry: TelemetryData | null,
  offset: number,
  positions?: number[],
): DriverEntry | null {
  const posArray = positions ?? telemetry?.CarIdxPosition;

  if (!posArray) return null;

  const playerPosition = posArray[playerCarIdx];

  if (!playerPosition || playerPosition < 1) return null;

  const targetPosition = playerPosition + offset;

  if (targetPosition < 1) return null;

  for (const driver of drivers) {
    if (posArray[driver.CarIdx] === targetPosition) {
      return driver;
    }
  }

  return null;
}

/**
 * @internal Exported for testing
 *
 * Resolves the driver the camera is currently focused on from `CamCarIdx`.
 * Returns null when no car is focused — `CamCarIdx` is undefined (no telemetry)
 * or a negative sentinel (a scenic/track cam, not a specific car) — or when the
 * index matches no driver. When the camera is on the player's own car this
 * returns the player's driver entry, which is expected.
 *
 * Unlike the track/race-relative resolvers, the pace car and spectators are
 * intentionally not filtered: a camera focus is a deliberate user selection, so
 * whatever the camera is on is the car the user wants to see.
 */
export function findDriverByCamCarIdx(drivers: DriverEntry[], telemetry: TelemetryData | null): DriverEntry | null {
  const camCarIdx = telemetry?.CamCarIdx;

  if (camCarIdx === undefined || camCarIdx < 0) return null;

  return drivers.find((d) => d.CarIdx === camCarIdx) ?? null;
}

/**
 * @internal Exported for testing
 *
 * Builds a resolved positions array for a race session.
 * For each car: if on pit road or calculated position is unavailable, uses official CarIdxPosition.
 * Otherwise uses the calculated position.
 *
 * `order` supplies the base 1-based race order (indexed by carIdx) to blend; when
 * omitted it is computed locally via {@link calculateRacePositions}. Callers pass
 * the injected live order so the pit-road blend applies to the same order the
 * Session Info display uses.
 */
export function resolveRacePositions(telemetry: TelemetryData | null, order?: number[]): number[] | undefined {
  const calculated = order ?? calculateRacePositions(telemetry);

  if (calculated.length === 0) return undefined;

  const official = telemetry?.CarIdxPosition as number[] | undefined;
  const onPitRoad = telemetry?.CarIdxOnPitRoad as boolean[] | undefined;

  if (!official) return calculated;

  const resolved = new Array<number>(calculated.length).fill(0);

  for (let i = 0; i < calculated.length; i++) {
    if (onPitRoad?.[i] || !calculated[i] || calculated[i] < 1) {
      resolved[i] = official[i] ?? 0;
    } else {
      resolved[i] = calculated[i];
    }
  }

  return resolved;
}

/**
 * First strictly-positive value, or undefined. Used to skip iRacing's `0`
 * "not classified" position/class sentinel as we fall through candidate sources,
 * so an unclassified car renders blank instead of "0".
 */
function firstPositive(...values: (number | undefined)[]): number | undefined {
  return values.find((v) => typeof v === "number" && v > 0);
}

/**
 * Live class position for a car: the count of same-class cars (`CarIdxClass`)
 * ranked ahead of it in the live race `order`, +1 (issue #700). Mirrors the
 * Session Info display, which derives class position from the live order rather
 * than iRacing's start/finish-line-frozen `CarIdxClassPosition`.
 *
 * Falls back to the official counter when the car is on pit road (its on-track
 * lap-order slot isn't its standing), when there's no live order (non-race), or
 * when `CarIdxClass` can't be read. `officialClass` overrides the official
 * fallback — the player passes `PlayerCarClassPosition`, the value iRacing
 * maintains authoritatively for the player. `onPitRoad` is supplied by the
 * caller so overall and class position share one pit-road signal.
 */
function resolveClassPosition(
  order: number[] | undefined,
  telemetry: TelemetryData | null,
  carIdx: number,
  onPitRoad: boolean,
  officialClass?: number,
): number | undefined {
  if (order && !onPitRoad) {
    const derived = classPositionFromOrder(order, telemetry?.CarIdxClass as number[] | undefined, carIdx);

    if (derived > 0) return derived;
  }

  // A non-positive official counter (0 = not classified) renders blank, not "0".
  return firstPositive(officialClass, telemetry?.CarIdxClassPosition?.[carIdx]);
}

/**
 * Resolves the shared driver fields (name, car number, live overall/class
 * position, lap counts, iRating, license) for one car. When `playerCarIdx`
 * matches the car, the player-authoritative telemetry fields are used so `self`
 * and `focused`-on-the-player agree; a pace car / spectator / unclassified car
 * gets a blank position and class. See the inline notes for the per-field rules.
 */
function buildDriverFields(
  driver: DriverEntry,
  telemetry: TelemetryData | null,
  positions?: number[],
  order?: number[],
  playerCarIdx?: number,
): DriverFields {
  const { firstName, lastName } = splitDriverName(driver.UserName);
  const carIdx = driver.CarIdx;
  // When this entry IS the player's own car — `self`, or `focused` while the
  // camera is on the player — read the player-authoritative telemetry fields so
  // the `self` and `focused` prefixes resolve to identical values for the same
  // car (issue #700). For every other car those player-only fields don't exist,
  // so we use the per-car arrays.
  const isPlayer = playerCarIdx !== undefined && carIdx === playerCarIdx;
  // The pace car and spectators have no race position. The relative prefixes
  // already exclude them in their finders, so this only matters for `focused`,
  // the one prefix that can be aimed at a non-competitor: render its
  // position/class blank rather than a 0 or a bogus on-track lap-order rank.
  const isCompetitor = driver.CarIsPaceCar !== 1 && driver.IsSpectator !== 1;
  // One pit-road signal for BOTH overall and class position so they can't
  // disagree: the player's own scalar `OnPitRoad`, the per-car array otherwise.
  const onPitRoad = isPlayer
    ? telemetry?.OnPitRoad === true
    : (telemetry?.CarIdxOnPitRoad as boolean[] | undefined)?.[carIdx] === true;

  const livePosition = positions?.[carIdx];
  const carIdxPosition = telemetry?.CarIdxPosition?.[carIdx];
  let position: number | undefined;

  if (!isCompetitor) {
    position = undefined;
  } else if (isPlayer) {
    // On pit road the live lap-order demotes the player to their on-track slot,
    // but they hold their official standing — so prefer PlayerCarPosition there.
    position = onPitRoad
      ? firstPositive(telemetry?.PlayerCarPosition, livePosition, carIdxPosition)
      : firstPositive(livePosition, telemetry?.PlayerCarPosition, carIdxPosition);
  } else {
    position = firstPositive(livePosition, carIdxPosition);
  }

  return {
    name: driver.UserName,
    first_name: firstName,
    last_name: lastName,
    abbrev_name: driver.AbbrevName,
    car_number: driver.CarNumber,
    position,
    class_position: isCompetitor
      ? resolveClassPosition(
          order,
          telemetry,
          carIdx,
          onPitRoad,
          isPlayer ? telemetry?.PlayerCarClassPosition : undefined,
        )
      : undefined,
    lap: (isPlayer ? telemetry?.Lap : undefined) ?? telemetry?.CarIdxLap?.[carIdx],
    laps_completed: (isPlayer ? telemetry?.LapCompleted : undefined) ?? telemetry?.CarIdxLapCompleted?.[carIdx],
    irating: driver.IRating,
    license: driver.LicString ?? "",
  };
}

/**
 * Builds the `self` fields: the player-aware driver field set (so `self` and
 * `focused`-on-the-player resolve identically) plus the player-only incident
 * count. Returns the empty set when the player's driver entry isn't found.
 */
function buildSelfFields(
  driver: DriverEntry | undefined,
  playerCarIdx: number,
  telemetry: TelemetryData | null,
  positions?: number[],
  order?: number[],
): SelfDriverFields {
  if (!driver) return { ...EMPTY_SELF_FIELDS };

  // Self is the player-aware per-car field set plus the player-only incident
  // count — so `self` and `focused`-on-the-player share one code path.
  return {
    ...buildDriverFields(driver, telemetry, positions, order, playerCarIdx),
    incidents: telemetry?.PlayerCarMyIncidentCount,
  };
}

function getCurrentSession(
  sessionInfo: SessionInfo | null,
  telemetry: TelemetryData | null,
): Record<string, unknown> | undefined {
  if (!sessionInfo) return undefined;

  const sessions = (sessionInfo as Record<string, unknown>).SessionInfo as Record<string, unknown> | undefined;
  const sessionList = sessions?.Sessions as Array<Record<string, unknown>> | undefined;
  const sessionNum = telemetry?.SessionNum ?? 0;

  return sessionList?.[sessionNum];
}

function isRaceSession(sessionInfo: SessionInfo | null, telemetry: TelemetryData | null): boolean {
  return (getCurrentSession(sessionInfo, telemetry)?.SessionType as string) === "Race";
}

function buildSessionFields(sessionInfo: SessionInfo | null, telemetry: TelemetryData | null): FieldMaps {
  const currentSession = getCurrentSession(sessionInfo, telemetry);

  const lapsRemaining = telemetry?.SessionLapsRemainEx;
  const timeRemaining = telemetry?.SessionTimeRemain;

  const type = (currentSession?.SessionType as string) ?? "";
  const hasLapsRemaining = lapsRemaining !== undefined && lapsRemaining >= 0;
  // time_remaining keeps the formatted M:SS string in BOTH maps — expressions
  // wanting math on it should use telemetry.SessionTimeRemain instead.
  const timeRemainingFormatted = formatTimeRemaining(timeRemaining);

  const raw: Record<string, TemplateValue> = { type, time_remaining: timeRemainingFormatted };

  if (hasLapsRemaining) {
    raw.laps_remaining = lapsRemaining;
  }

  return {
    display: {
      type,
      laps_remaining: hasLapsRemaining ? String(lapsRemaining) : "",
      time_remaining: timeRemainingFormatted,
    },
    raw,
  };
}

function buildTrackFields(sessionInfo: SessionInfo | null): Record<string, string> {
  if (!sessionInfo) return { name: "", short_name: "" };

  const weekend = (sessionInfo as Record<string, unknown>).WeekendInfo as Record<string, unknown> | undefined;

  return {
    name: (weekend?.TrackDisplayName as string) ?? "",
    short_name: (weekend?.TrackDisplayShortName as string) ?? "",
  };
}

function extractDrivers(sessionInfo: SessionInfo | null): DriverEntry[] {
  if (!sessionInfo) return [];

  const driverInfo = (sessionInfo as Record<string, unknown>).DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  return drivers ?? [];
}

function extractPlayerCarIdx(sessionInfo: SessionInfo | null): number {
  if (!sessionInfo) return -1;

  const driverInfo = (sessionInfo as Record<string, unknown>).DriverInfo as Record<string, unknown> | undefined;

  return (driverInfo?.DriverCarIdx as number) ?? -1;
}

/**
 * @internal Exported for testing
 */
export function formatTimeRemaining(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return "";

  const totalSeconds = Math.floor(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
