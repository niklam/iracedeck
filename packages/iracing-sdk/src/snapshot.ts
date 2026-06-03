/**
 * Telemetry snapshot formatting utilities
 *
 * Pure helpers shared by the telemetry-snapshot CLI and the Telemetry Snapshot
 * Stream Deck action. They format a telemetry + session info reading into a
 * JSON envelope and a human-readable Markdown report. No filesystem access —
 * callers decide where the output goes.
 */
import { TrkLoc } from "./types.js";

/**
 * Driver summary row extracted from telemetry + session info.
 */
export interface DriverInfo {
  carIdx: number;
  carNumber: string;
  driverName: string;
  position: number;
  lapsCompleted: number;
  lapDistPct: number;
  trackLocation: string;
}

/**
 * The JSON output shape of a telemetry snapshot.
 */
export interface SnapshotEnvelope {
  timestamp: string;
  telemetry: Record<string, unknown>;
  sessionInfo?: Record<string, unknown>;
}

/**
 * Converts a TrkLoc enum value to a human-readable string.
 */
export function trkLocToString(loc: number): string {
  switch (loc) {
    case TrkLoc.OnTrack:
      return "On Track";
    case TrkLoc.OffTrack:
      return "Off Track";
    case TrkLoc.InPitStall:
      return "In Pit Stall";
    case TrkLoc.AproachingPits:
      return "Pit Lane";
    case TrkLoc.NotInWorld:
      return "Not in World";
    default:
      return `Unknown (${loc})`;
  }
}

/**
 * Builds a list of drivers currently in the session from telemetry car-index
 * arrays and session info driver records.
 */
export function buildDriverList(
  telemetry: Record<string, unknown>,
  sessionInfo: Record<string, unknown> | null,
): DriverInfo[] {
  const positions = telemetry.CarIdxPosition as number[] | undefined;
  const lapDistPcts = telemetry.CarIdxLapDistPct as number[] | undefined;
  const laps = telemetry.CarIdxLap as number[] | undefined;
  const trackSurfaces = telemetry.CarIdxTrackSurface as number[] | undefined;

  if (!positions || !lapDistPcts || !laps || !trackSurfaces) return [];

  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = (driverInfo?.Drivers as Array<Record<string, unknown>>) ?? [];

  const driverMap = new Map<number, { carNumber: string; userName: string }>();

  for (const d of drivers) {
    driverMap.set(d.CarIdx as number, {
      carNumber: String(d.CarNumber ?? ""),
      userName: String(d.UserName ?? ""),
    });
  }

  const result: DriverInfo[] = [];

  for (let i = 0; i < positions.length; i++) {
    if (positions[i] <= 0 && trackSurfaces[i] === TrkLoc.NotInWorld) continue;

    const driver = driverMap.get(i);

    if (!driver) continue;

    result.push({
      carIdx: i,
      carNumber: driver.carNumber,
      driverName: driver.userName,
      position: positions[i],
      lapsCompleted: Math.max(0, laps[i] - 1),
      lapDistPct: lapDistPcts[i],
      trackLocation: trkLocToString(trackSurfaces[i]),
    });
  }

  return result;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

/**
 * Builds a Markdown table from headers and rows with per-column alignment.
 */
export function buildMarkdownTable(headers: string[], rows: string[][], alignRight: boolean[]): string {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const headerLine =
    "| " +
    headers.map((h, i) => (alignRight[i] ? padLeft(h, colWidths[i]) : padRight(h, colWidths[i]))).join(" | ") +
    " |";

  const separatorLine =
    "| " + colWidths.map((w, i) => (alignRight[i] ? "-".repeat(w - 1) + ":" : "-".repeat(w))).join(" | ") + " |";

  const dataLines = rows.map(
    (row) =>
      "| " +
      row.map((cell, i) => (alignRight[i] ? padLeft(cell, colWidths[i]) : padRight(cell, colWidths[i]))).join(" | ") +
      " |",
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

/**
 * Builds a Markdown table identifying the session (track, event type, weather, …).
 * Returns null when no identifying information is available.
 */
export function getSessionIdentification(sessionInfo: Record<string, unknown> | null): string | null {
  if (!sessionInfo) return null;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const sessionSection = sessionInfo.SessionInfo as Record<string, unknown> | undefined;
  const sessions = sessionSection?.Sessions as Array<Record<string, unknown>> | undefined;

  const rows: string[][] = [];

  if (weekend) {
    const trackName = weekend.TrackDisplayName ?? weekend.TrackName;
    const config = weekend.TrackConfigName;
    const trackLine = config ? `${trackName} — ${config}` : String(trackName ?? "Unknown Track");
    rows.push(["Track", trackLine]);

    if (weekend.TrackLength) rows.push(["Track Length", String(weekend.TrackLength)]);

    if (weekend.TrackCity || weekend.TrackCountry) {
      const location = [weekend.TrackCity, weekend.TrackCountry].filter(Boolean).join(", ");
      rows.push(["Location", location]);
    }

    if (weekend.EventType) rows.push(["Event Type", String(weekend.EventType)]);

    if (weekend.Category) rows.push(["Category", String(weekend.Category)]);

    if (weekend.TrackType) rows.push(["Track Type", String(weekend.TrackType)]);

    if (weekend.NumCarClasses) rows.push(["Car Classes", String(weekend.NumCarClasses)]);

    if (weekend.TrackPitSpeedLimit) rows.push(["Pit Speed Limit", String(weekend.TrackPitSpeedLimit)]);
  }

  if (sessions && sessions.length > 0) {
    const currentSession = sessions[sessions.length - 1];

    if (currentSession.SessionType) rows.push(["Session Type", String(currentSession.SessionType)]);

    if (currentSession.SessionLaps) rows.push(["Session Laps", String(currentSession.SessionLaps)]);

    if (currentSession.SessionTime) rows.push(["Session Time", String(currentSession.SessionTime)]);
  }

  if (weekend) {
    if (weekend.TrackSkies) rows.push(["Skies", String(weekend.TrackSkies)]);

    if (weekend.TrackAirTemp) rows.push(["Air Temp", String(weekend.TrackAirTemp)]);

    if (weekend.TrackSurfaceTemp) rows.push(["Surface Temp", String(weekend.TrackSurfaceTemp)]);
  }

  if (rows.length === 0) return null;

  return buildMarkdownTable(["", ""], rows, [false, false]);
}

/**
 * Builds a Markdown table of all driver details from session info.
 * Returns null when no drivers are present.
 */
export function buildDriverDetailsTable(sessionInfo: Record<string, unknown> | null): string | null {
  if (!sessionInfo) return null;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;

  if (!drivers || drivers.length === 0) return null;

  const headers = ["Car Idx", "Car #", "Driver", "Car", "iRating", "License", "Team", "AI"];
  const alignRight = [true, true, false, false, true, false, false, false];

  const rows: string[][] = [];

  for (const d of drivers) {
    if (d.CarIsPaceCar === 1) continue;

    rows.push([
      String(d.CarIdx ?? ""),
      String(d.CarNumber ?? ""),
      String(d.UserName ?? ""),
      String(d.CarScreenNameShort ?? d.CarScreenName ?? ""),
      String(d.IRating ?? ""),
      String(d.LicString ?? ""),
      String(d.TeamName ?? ""),
      d.CarIsAI === 1 ? "Yes" : "No",
    ]);
  }

  if (rows.length === 0) return null;

  return buildMarkdownTable(headers, rows, alignRight);
}

function formatTime(seconds: number): string {
  if (seconds < 0) return "-";

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return mins > 0 ? `${mins}:${secs.toFixed(3).padStart(7, "0")}` : `${secs.toFixed(3)}s`;
}

/**
 * Builds a Markdown table of the player's car telemetry (identity, position,
 * lap timing, vehicle state, fuel, temperatures).
 * Returns null when the player car index is unavailable.
 */
export function buildPlayerTelemetry(
  telemetry: Record<string, unknown>,
  sessionInfo: Record<string, unknown> | null,
): string | null {
  const playerCarIdx = telemetry.PlayerCarIdx as number | undefined;

  if (playerCarIdx === undefined) return null;

  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;
  const player = drivers?.find((d) => d.CarIdx === playerCarIdx);

  const posRows: string[][] = [];

  // Player identity
  if (player) {
    posRows.push(["Driver", String(player.UserName)]);
    posRows.push(["Car", `${player.CarScreenName ?? player.CarScreenNameShort ?? "Unknown"} (#${player.CarNumber})`]);

    if (player.TeamName) posRows.push(["Team", String(player.TeamName)]);

    if (player.IRating) posRows.push(["iRating", String(player.IRating)]);

    if (player.LicString) posRows.push(["License", String(player.LicString)]);
  }

  // Car info from DriverInfo section
  if (driverInfo) {
    if (driverInfo.DriverSetupName) posRows.push(["Setup", String(driverInfo.DriverSetupName)]);

    if (driverInfo.DriverCarFuelMaxLtr) posRows.push(["Max Fuel", `${driverInfo.DriverCarFuelMaxLtr} L`]);

    if (driverInfo.DriverCarEstLapTime)
      posRows.push(["Est. Lap Time", formatTime(Number(driverInfo.DriverCarEstLapTime))]);
  }

  // Position
  if (telemetry.PlayerCarPosition !== undefined)
    posRows.push(["Position (Overall)", String(telemetry.PlayerCarPosition)]);

  if (telemetry.PlayerCarClassPosition !== undefined)
    posRows.push(["Position (Class)", String(telemetry.PlayerCarClassPosition)]);

  posRows.push(["Track Surface", trkLocToString((telemetry.PlayerTrackSurface as number) ?? TrkLoc.NotInWorld)]);

  if (telemetry.OnPitRoad !== undefined) posRows.push(["On Pit Road", telemetry.OnPitRoad ? "Yes" : "No"]);

  if (telemetry.PlayerCarInPitStall !== undefined)
    posRows.push(["In Pit Stall", telemetry.PlayerCarInPitStall ? "Yes" : "No"]);

  if (telemetry.PlayerCarMyIncidentCount !== undefined)
    posRows.push(["Incidents", String(telemetry.PlayerCarMyIncidentCount)]);

  // Lap & timing
  if (telemetry.Lap !== undefined) posRows.push(["Current Lap", String(telemetry.Lap)]);

  if (telemetry.LapCompleted !== undefined) posRows.push(["Laps Completed", String(telemetry.LapCompleted)]);

  if (telemetry.LapDistPct !== undefined)
    posRows.push(["Lap Distance %", (Number(telemetry.LapDistPct) * 100).toFixed(4) + "%"]);

  if (telemetry.LapCurrentLapTime !== undefined)
    posRows.push(["Current Lap Time", formatTime(Number(telemetry.LapCurrentLapTime))]);

  if (telemetry.LapBestLapTime !== undefined && Number(telemetry.LapBestLapTime) > 0)
    posRows.push(["Best Lap Time", formatTime(Number(telemetry.LapBestLapTime))]);

  if (telemetry.LapLastLapTime !== undefined && Number(telemetry.LapLastLapTime) > 0)
    posRows.push(["Last Lap Time", formatTime(Number(telemetry.LapLastLapTime))]);

  if (telemetry.LapDeltaToBestLap !== undefined && telemetry.LapDeltaToBestLap_OK)
    posRows.push([
      "Delta to Best",
      `${Number(telemetry.LapDeltaToBestLap) >= 0 ? "+" : ""}${Number(telemetry.LapDeltaToBestLap).toFixed(3)}s`,
    ]);

  // Vehicle state
  if (telemetry.Speed !== undefined) posRows.push(["Speed", `${(Number(telemetry.Speed) * 3.6).toFixed(1)} km/h`]);

  if (telemetry.RPM !== undefined) posRows.push(["RPM", String(Math.round(Number(telemetry.RPM)))]);

  if (telemetry.Gear !== undefined)
    posRows.push([
      "Gear",
      Number(telemetry.Gear) === -1 ? "R" : Number(telemetry.Gear) === 0 ? "N" : String(telemetry.Gear),
    ]);

  if (telemetry.Throttle !== undefined) posRows.push(["Throttle", `${(Number(telemetry.Throttle) * 100).toFixed(0)}%`]);

  if (telemetry.Brake !== undefined) posRows.push(["Brake", `${(Number(telemetry.Brake) * 100).toFixed(0)}%`]);

  if (telemetry.SteeringWheelAngle !== undefined)
    posRows.push(["Steering Angle", `${(Number(telemetry.SteeringWheelAngle) * (180 / Math.PI)).toFixed(1)}°`]);

  // Fuel
  if (telemetry.FuelLevel !== undefined) posRows.push(["Fuel Level", `${Number(telemetry.FuelLevel).toFixed(1)} L`]);

  if (telemetry.FuelLevelPct !== undefined)
    posRows.push(["Fuel %", `${(Number(telemetry.FuelLevelPct) * 100).toFixed(1)}%`]);

  if (telemetry.FuelUsePerHour !== undefined)
    posRows.push(["Fuel Use/Hour", `${Number(telemetry.FuelUsePerHour).toFixed(1)} L/h`]);

  // Temperatures & electrical
  if (telemetry.OilTemp !== undefined) posRows.push(["Oil Temp", `${Number(telemetry.OilTemp).toFixed(1)} °C`]);

  if (telemetry.WaterTemp !== undefined) posRows.push(["Water Temp", `${Number(telemetry.WaterTemp).toFixed(1)} °C`]);

  if (telemetry.Voltage !== undefined) posRows.push(["Voltage", `${Number(telemetry.Voltage).toFixed(1)} V`]);

  if (posRows.length === 0) return null;

  return buildMarkdownTable(["", ""], posRows, [false, false]);
}

/**
 * Generates the full human-readable Markdown snapshot report (session info,
 * race/track position orders, driver details, player telemetry).
 */
export function generateMarkdown(
  telemetry: Record<string, unknown>,
  sessionInfo: Record<string, unknown> | null,
  now: Date = new Date(),
): string {
  const drivers = buildDriverList(telemetry, sessionInfo);
  const lines: string[] = [];

  lines.push("# Telemetry Snapshot");
  lines.push("");
  lines.push(`*${now.toISOString()}*`);
  lines.push("");

  const sessionTable = getSessionIdentification(sessionInfo);

  if (sessionTable) {
    lines.push("## Session Info");
    lines.push("");
    lines.push(sessionTable);
    lines.push("");
  }

  if (drivers.length === 0) {
    lines.push("No position data available.");
    lines.push("");
  } else {
    const headers = ["Pos", "Car #", "Car Idx", "Driver", "Laps", "Lap Dist %", "Location"];
    const alignRight = [true, true, true, false, true, true, false];

    const toRow = (d: DriverInfo): string[] => [
      String(d.position),
      d.carNumber,
      String(d.carIdx),
      d.driverName,
      String(d.lapsCompleted),
      (d.lapDistPct * 100).toFixed(4) + "%",
      d.trackLocation,
    ];

    // Table 1: sorted by position
    const byPosition = [...drivers].sort((a, b) => {
      if (a.position <= 0 && b.position <= 0) return 0;

      if (a.position <= 0) return 1;

      if (b.position <= 0) return -1;

      return a.position - b.position;
    });

    // Table 2: sorted by lap distance percentage only (track position, not race position)
    const byTrackProgress = [...drivers].sort((a, b) => b.lapDistPct - a.lapDistPct);

    lines.push("## Race Position Order");
    lines.push("");
    lines.push(buildMarkdownTable(headers, byPosition.map(toRow), alignRight));
    lines.push("");
    lines.push("## Track Position Order (Car Ahead / Behind)");
    lines.push("");
    lines.push(buildMarkdownTable(headers, byTrackProgress.map(toRow), alignRight));
    lines.push("");
  }

  const driverTable = buildDriverDetailsTable(sessionInfo);

  if (driverTable) {
    lines.push("## Driver Details");
    lines.push("");
    lines.push(driverTable);
    lines.push("");
  }

  const playerTable = buildPlayerTelemetry(telemetry, sessionInfo);

  if (playerTable) {
    lines.push("## Player Telemetry");
    lines.push("");
    lines.push(playerTable);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Formats a Date as a filesystem-safe snapshot timestamp: "YYYYMMDD-HHMMSS".
 */
export function snapshotTimestamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Returns the base filename (without extension) for a snapshot taken at the given time.
 *
 * Includes milliseconds so two snapshots captured within the same second (e.g. a
 * rapid double-press of the Stream Deck key, or two CLI runs) do not collide and
 * silently overwrite each other.
 */
export function snapshotBaseName(now: Date = new Date()): string {
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  return `telemetry-snapshot-${snapshotTimestamp(now)}-${ms}`;
}

/**
 * Builds the JSON envelope written to disk for a snapshot.
 */
export function buildSnapshotEnvelope(
  telemetry: Record<string, unknown>,
  sessionInfo: Record<string, unknown> | null,
  includeSession: boolean,
  now: Date = new Date(),
): SnapshotEnvelope {
  const envelope: SnapshotEnvelope = {
    timestamp: now.toISOString(),
    telemetry,
  };

  if (includeSession && sessionInfo) {
    envelope.sessionInfo = sessionInfo;
  }

  return envelope;
}
