/**
 * Mock telemetry variable headers and buffer builder.
 *
 * Defines a subset of iRacing telemetry variables sufficient for development
 * and testing. The buffer builder writes typed values at the correct offsets,
 * matching the binary format that `IRacingSDK.parseTelemetry()` expects.
 */
import { VarType, VarTypeBytes, type VarHeader } from "../defines.js";

/**
 * Values for a single telemetry snapshot.
 * Keys must match variable names in MOCK_VAR_HEADERS.
 */
export interface MockSnapshotValues {
  [key: string]: number | boolean | number[] | boolean[];
}

/**
 * Build the mock var headers array with computed offsets.
 * Offsets are packed sequentially based on type size and count.
 */
function buildVarHeaders(): VarHeader[] {
  const definitions: Omit<VarHeader, "offset">[] = [
    // Session
    { type: VarType.Double, count: 1, countAsTime: true, name: "SessionTime", desc: "Seconds since session start", unit: "s" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "SessionTick", desc: "Current update number", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "SessionNum", desc: "Session number", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "SessionState", desc: "Session state", unit: "irsdk_SessionState" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "SessionFlags", desc: "Session flags", unit: "irsdk_Flags" },
    { type: VarType.Double, count: 1, countAsTime: false, name: "SessionTimeRemain", desc: "Seconds left", unit: "s" },

    // Player car
    { type: VarType.Int, count: 1, countAsTime: false, name: "PlayerCarIdx", desc: "Player car index", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "PlayerCarPosition", desc: "Player position", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "PlayerCarClassPosition", desc: "Player class position", unit: "" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "PlayerCarInPitStall", desc: "Player in pit stall", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "PlayerTrackSurface", desc: "Player track surface", unit: "irsdk_TrkLoc" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "PlayerCarMyIncidentCount", desc: "Player incidents", unit: "" },

    // Vehicle state
    { type: VarType.Float, count: 1, countAsTime: false, name: "Speed", desc: "Vehicle speed", unit: "m/s" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "RPM", desc: "Engine RPM", unit: "revs/min" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "Gear", desc: "Current gear", unit: "" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "Throttle", desc: "Throttle position", unit: "%" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "Brake", desc: "Brake position", unit: "%" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "Clutch", desc: "Clutch position", unit: "%" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "SteeringWheelAngle", desc: "Steering wheel angle", unit: "rad" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "FuelLevel", desc: "Fuel level", unit: "l" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "FuelLevelPct", desc: "Fuel level %", unit: "%" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "FuelUsePerHour", desc: "Fuel use per hour", unit: "kg/h" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "OilTemp", desc: "Oil temperature", unit: "C" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "WaterTemp", desc: "Water temperature", unit: "C" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "Voltage", desc: "Battery voltage", unit: "V" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "EngineWarnings", desc: "Engine warning flags", unit: "irsdk_EngineWarnings" },

    // Lap & timing
    { type: VarType.Int, count: 1, countAsTime: false, name: "Lap", desc: "Current lap number", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "LapCompleted", desc: "Laps completed", unit: "" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LapDistPct", desc: "Lap distance %", unit: "%" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LapCurrentLapTime", desc: "Current lap time", unit: "s" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LapBestLapTime", desc: "Best lap time", unit: "s" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LapLastLapTime", desc: "Last lap time", unit: "s" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LapDeltaToBestLap", desc: "Delta to best lap", unit: "s" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "LapDeltaToBestLap_OK", desc: "Delta valid", unit: "" },

    // On track status
    { type: VarType.Bool, count: 1, countAsTime: false, name: "IsOnTrack", desc: "On track", unit: "" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "IsOnTrackCar", desc: "On track in car", unit: "" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "IsInGarage", desc: "In garage", unit: "" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "OnPitRoad", desc: "On pit road", unit: "" },
    { type: VarType.Bool, count: 1, countAsTime: false, name: "PitstopActive", desc: "Pitstop in progress", unit: "" },

    // Pit service
    { type: VarType.Int, count: 1, countAsTime: false, name: "PitSvFlags", desc: "Pit service flags", unit: "irsdk_PitSvFlags" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "PitSvFuel", desc: "Pit service fuel add", unit: "l" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "PitRepairLeft", desc: "Pit repair time left", unit: "s" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "PitOptRepairLeft", desc: "Pit optional repair left", unit: "s" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "FastRepairAvailable", desc: "Fast repairs available", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "FastRepairUsed", desc: "Fast repairs used", unit: "" },

    // Physics
    { type: VarType.Float, count: 1, countAsTime: false, name: "LatAccel", desc: "Lateral acceleration", unit: "m/s^2" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "LongAccel", desc: "Longitudinal acceleration", unit: "m/s^2" },

    // Camera
    { type: VarType.Int, count: 1, countAsTime: false, name: "CamCarIdx", desc: "Camera car index", unit: "" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "CamGroupNumber", desc: "Camera group", unit: "" },

    // Car index arrays (3 cars for mock)
    { type: VarType.Int, count: 64, countAsTime: false, name: "CarIdxLap", desc: "Laps per car", unit: "" },
    { type: VarType.Float, count: 64, countAsTime: false, name: "CarIdxLapDistPct", desc: "Lap distance % per car", unit: "%" },
    { type: VarType.Bool, count: 64, countAsTime: false, name: "CarIdxOnPitRoad", desc: "On pit road per car", unit: "" },
    { type: VarType.Int, count: 64, countAsTime: false, name: "CarIdxPosition", desc: "Position per car", unit: "" },
    { type: VarType.Int, count: 64, countAsTime: false, name: "CarIdxClassPosition", desc: "Class position per car", unit: "" },
    { type: VarType.Int, count: 64, countAsTime: false, name: "CarIdxTrackSurface", desc: "Track surface per car", unit: "irsdk_TrkLoc" },

    // Display
    { type: VarType.Int, count: 1, countAsTime: false, name: "DisplayUnits", desc: "Display units", unit: "" },

    // Environment
    { type: VarType.Float, count: 1, countAsTime: false, name: "AirTemp", desc: "Air temperature", unit: "C" },
    { type: VarType.Float, count: 1, countAsTime: false, name: "TrackTempCrew", desc: "Track temperature", unit: "C" },
    { type: VarType.Int, count: 1, countAsTime: false, name: "Skies", desc: "Sky condition", unit: "irsdk_Skies" },
  ];

  let offset = 0;
  const headers: VarHeader[] = [];

  for (const def of definitions) {
    const size = VarTypeBytes[def.type];
    // Align offset to type size for proper alignment
    const alignment = Math.min(size, 8);
    offset = Math.ceil(offset / alignment) * alignment;

    headers.push({ ...def, offset });
    offset += size * def.count;
  }

  return headers;
}

export const MOCK_VAR_HEADERS = buildVarHeaders();

/**
 * Map from variable name to index in MOCK_VAR_HEADERS.
 */
export const MOCK_VAR_INDEX_MAP: Map<string, number> = new Map(
  MOCK_VAR_HEADERS.map((h, i) => [h.name, i]),
);

/**
 * Total buffer size needed for all mock variables.
 */
export function getBufferSize(): number {
  let maxEnd = 0;
  for (const h of MOCK_VAR_HEADERS) {
    const end = h.offset + VarTypeBytes[h.type] * h.count;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/**
 * Build a telemetry buffer from snapshot values.
 *
 * Writes typed values into a Buffer at the correct offsets based on
 * VarHeader definitions, matching the binary format that
 * `IRacingSDK.parseTelemetry()` expects (little-endian).
 */
export function buildTelemetryBuffer(values: MockSnapshotValues): Buffer {
  const buf = Buffer.alloc(getBufferSize());

  for (const header of MOCK_VAR_HEADERS) {
    const value = values[header.name];
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      // Array value — write each element
      const elementSize = VarTypeBytes[header.type];
      for (let i = 0; i < Math.min(value.length, header.count); i++) {
        const elementOffset = header.offset + i * elementSize;
        writeValue(buf, elementOffset, header.type, value[i]);
      }
    } else {
      // Scalar value
      writeValue(buf, header.offset, header.type, value);
    }
  }

  return buf;
}

function writeValue(
  buf: Buffer,
  offset: number,
  type: VarType,
  value: number | boolean,
): void {
  switch (type) {
    case VarType.Char:
      buf.writeInt8(typeof value === "boolean" ? (value ? 1 : 0) : (value as number), offset);
      break;
    case VarType.Bool:
      buf.writeInt8(value ? 1 : 0, offset);
      break;
    case VarType.Int:
    case VarType.BitField:
      buf.writeInt32LE(typeof value === "boolean" ? (value ? 1 : 0) : (value as number), offset);
      break;
    case VarType.Float:
      buf.writeFloatLE(value as number, offset);
      break;
    case VarType.Double:
      buf.writeDoubleLE(value as number, offset);
      break;
  }
}
