/**
 * Template Context Builder
 *
 * Assembles a template variable context from iRacing telemetry and session data.
 * Used by resolveTemplate() to hydrate {{variable}} placeholders.
 */
import type { SDKController } from "./SDKController.js";
import type { SessionInfo, TelemetryData } from "./types.js";

/**
 * Shared fields available for all driver groups.
 */
interface DriverFields {
  name: string;
  first_name: string;
  last_name: string;
  abbrev_name: string;
  car_number: string;
  position: string;
  class_position: string;
  lap: string;
  laps_completed: string;
  irating: string;
  license: string;
}

/**
 * Self driver extends DriverFields with additional player-specific data.
 */
interface SelfDriverFields extends DriverFields {
  incidents: string;
}

/**
 * Flat template context — all keys use dot-notation (e.g., "self.name", "telemetry.Speed").
 */
export type TemplateContext = Record<string, string>;

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
  position: "",
  class_position: "",
  lap: "",
  laps_completed: "",
  irating: "",
  license: "",
};

const EMPTY_SELF_FIELDS: SelfDriverFields = {
  ...EMPTY_DRIVER_FIELDS,
  incidents: "",
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
 * Flattens a nested object into dot-notation keys with display-formatted string values.
 * Skips arrays, filters keys by prefix, rounds floats to 2 decimals, converts booleans to Yes/No.
 */
export function flattenForDisplay(obj: Record<string, unknown>, options?: FlattenOptions): Record<string, string> {
  const result: Record<string, string> = {};
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
        result[fullKey] = value ? "Yes" : "No";
      } else if (typeof value === "number") {
        const leafKey = fullKey.includes(".") ? fullKey.substring(fullKey.lastIndexOf(".") + 1) : fullKey;

        if (BOOLEAN_INT_FIELDS.has(leafKey) && (value === 0 || value === 1)) {
          result[fullKey] = value === 1 ? "Yes" : "No";
        } else {
          result[fullKey] = Number.isInteger(value) ? String(value) : value.toFixed(2);
        }
      } else if (typeof value === "string") {
        result[fullKey] = value;
      } else if (value !== null && value !== undefined) {
        result[fullKey] = String(value);
      }
    }
  }

  walk(obj, "");

  return result;
}

/**
 * Builds the full template context from current SDK state.
 */
export function buildTemplateContext(sdkController: SDKController): TemplateContext {
  const telemetry = sdkController.getCurrentTelemetry();
  const sessionInfo = sdkController.getSessionInfo();

  return buildTemplateContextFromData(telemetry, sessionInfo);
}

/**
 * @internal Exported for testing
 *
 * Prefixes all keys in a record with a given prefix.
 */
export function prefixKeys(prefix: string, record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    result[`${prefix}.${key}`] = value;
  }

  return result;
}

/**
 * @internal Exported for testing
 *
 * Builds template context from raw telemetry and session data.
 * Returns a single flat Record<string, string> with dot-notation keys.
 */
export function buildTemplateContextFromData(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
): TemplateContext {
  const drivers = extractDrivers(sessionInfo);
  const playerCarIdx = extractPlayerCarIdx(sessionInfo);

  const selfDriver = drivers.find((d) => d.CarIdx === playerCarIdx);
  const selfFields = buildSelfFields(selfDriver, playerCarIdx, telemetry);

  const trackAhead = findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "ahead");
  const trackBehind = findNearestDriverOnTrack(playerCarIdx, drivers, telemetry, "behind");
  const raceAhead = findDriverByRacePosition(playerCarIdx, drivers, telemetry, -1);
  const raceBehind = findDriverByRacePosition(playerCarIdx, drivers, telemetry, +1);

  const sessionFields = buildSessionFields(sessionInfo, telemetry);
  const trackFields = buildTrackFields(sessionInfo);

  return {
    ...prefixKeys("self", selfFields as unknown as Record<string, string>),
    ...prefixKeys(
      "track_ahead",
      (trackAhead ? buildDriverFields(trackAhead, telemetry) : { ...EMPTY_DRIVER_FIELDS }) as unknown as Record<
        string,
        string
      >,
    ),
    ...prefixKeys(
      "track_behind",
      (trackBehind ? buildDriverFields(trackBehind, telemetry) : { ...EMPTY_DRIVER_FIELDS }) as unknown as Record<
        string,
        string
      >,
    ),
    ...prefixKeys(
      "race_ahead",
      (raceAhead ? buildDriverFields(raceAhead, telemetry) : { ...EMPTY_DRIVER_FIELDS }) as unknown as Record<
        string,
        string
      >,
    ),
    ...prefixKeys(
      "race_behind",
      (raceBehind ? buildDriverFields(raceBehind, telemetry) : { ...EMPTY_DRIVER_FIELDS }) as unknown as Record<
        string,
        string
      >,
    ),
    ...prefixKeys("session", sessionFields),
    ...prefixKeys("track", trackFields),
    ...prefixKeys(
      "telemetry",
      telemetry ? flattenForDisplay(telemetry as unknown as Record<string, unknown>, { excludePrefix: "CarIdx" }) : {},
    ),
    ...prefixKeys(
      "sessionInfo",
      sessionInfo ? flattenForDisplay(sessionInfo as unknown as Record<string, unknown>) : {},
    ),
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
 * Finds the physically closest car on track in a given direction.
 * Uses laps completed + lap distance percentage for track progress.
 * Excludes cars in the pits, pace car, spectators, and inactive cars.
 */
export function findNearestDriverOnTrack(
  playerCarIdx: number,
  drivers: DriverEntry[],
  telemetry: TelemetryData | null,
  direction: "ahead" | "behind",
): DriverEntry | null {
  if (!telemetry?.CarIdxLapCompleted || !telemetry?.CarIdxLapDistPct) return null;

  const lapCompleted = telemetry.CarIdxLapCompleted;
  const lapDistPct = telemetry.CarIdxLapDistPct;
  const onPitRoad = telemetry.CarIdxOnPitRoad;

  // Build sorted list of active on-track cars by track progress
  const activeCars: Array<{ carIdx: number; progress: number }> = [];

  for (const driver of drivers) {
    const idx = driver.CarIdx;

    // Skip inactive, pace car, spectators, pit road
    if (lapCompleted[idx] === undefined || lapCompleted[idx] < 0) continue;

    if (driver.CarIsPaceCar === 1 || driver.IsSpectator === 1) continue;

    if (onPitRoad && onPitRoad[idx]) continue;

    const progress = lapCompleted[idx] + (lapDistPct[idx] ?? 0);
    activeCars.push({ carIdx: idx, progress });
  }

  // Sort by progress descending (highest first = most laps/distance)
  activeCars.sort((a, b) => b.progress - a.progress);

  const playerIndex = activeCars.findIndex((c) => c.carIdx === playerCarIdx);

  if (playerIndex === -1) return null;

  if (direction === "ahead") {
    // Car ahead = higher progress = lower index in sorted array
    if (playerIndex === 0) return null;

    const aheadCarIdx = activeCars[playerIndex - 1].carIdx;

    return drivers.find((d) => d.CarIdx === aheadCarIdx) ?? null;
  } else {
    // Car behind = lower progress = higher index in sorted array
    if (playerIndex === activeCars.length - 1) return null;

    const behindCarIdx = activeCars[playerIndex + 1].carIdx;

    return drivers.find((d) => d.CarIdx === behindCarIdx) ?? null;
  }
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
): DriverEntry | null {
  if (!telemetry?.CarIdxPosition) return null;

  const positions = telemetry.CarIdxPosition;
  const playerPosition = positions[playerCarIdx];

  if (!playerPosition || playerPosition < 1) return null;

  const targetPosition = playerPosition + offset;

  if (targetPosition < 1) return null;

  // Find the car at the target position
  for (const driver of drivers) {
    if (positions[driver.CarIdx] === targetPosition) {
      return driver;
    }
  }

  return null;
}

function buildDriverFields(driver: DriverEntry, telemetry: TelemetryData | null): DriverFields {
  const { firstName, lastName } = splitDriverName(driver.UserName);

  return {
    name: driver.UserName,
    first_name: firstName,
    last_name: lastName,
    abbrev_name: driver.AbbrevName,
    car_number: driver.CarNumber,
    position: telemetry?.CarIdxPosition?.[driver.CarIdx]?.toString() ?? "",
    class_position: telemetry?.CarIdxClassPosition?.[driver.CarIdx]?.toString() ?? "",
    lap: telemetry?.CarIdxLap?.[driver.CarIdx]?.toString() ?? "",
    laps_completed: telemetry?.CarIdxLapCompleted?.[driver.CarIdx]?.toString() ?? "",
    irating: driver.IRating?.toString() ?? "",
    license: driver.LicString ?? "",
  };
}

function buildSelfFields(
  driver: DriverEntry | undefined,
  playerCarIdx: number,
  telemetry: TelemetryData | null,
): SelfDriverFields {
  if (!driver) return { ...EMPTY_SELF_FIELDS };

  const base = buildDriverFields(driver, telemetry);

  // Use player-specific telemetry fields when available (more accurate)
  return {
    ...base,
    position: telemetry?.PlayerCarPosition?.toString() ?? base.position,
    class_position: telemetry?.PlayerCarClassPosition?.toString() ?? base.class_position,
    lap: telemetry?.Lap?.toString() ?? base.lap,
    laps_completed: telemetry?.LapCompleted?.toString() ?? base.laps_completed,
    incidents: telemetry?.PlayerCarMyIncidentCount?.toString() ?? "",
  };
}

function buildSessionFields(sessionInfo: SessionInfo | null, telemetry: TelemetryData | null): Record<string, string> {
  if (!sessionInfo) return { type: "", laps_remaining: "", time_remaining: "" };

  const sessions = (sessionInfo as Record<string, unknown>).SessionInfo as Record<string, unknown> | undefined;
  const sessionList = sessions?.Sessions as Array<Record<string, unknown>> | undefined;

  // Get current session number from telemetry
  const sessionNum = telemetry?.SessionNum ?? 0;
  const currentSession = sessionList?.[sessionNum as number];

  const lapsRemaining = telemetry?.SessionLapsRemainEx;
  const timeRemaining = telemetry?.SessionTimeRemain;

  return {
    type: (currentSession?.SessionType as string) ?? "",
    laps_remaining: lapsRemaining !== undefined && lapsRemaining >= 0 ? String(lapsRemaining) : "",
    time_remaining: formatTimeRemaining(timeRemaining),
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
