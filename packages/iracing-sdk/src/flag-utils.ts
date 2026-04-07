import { Flags } from "@iracedeck/iracing-native";

import { hasFlag } from "./utils.js";

/**
 * Describes a resolved race flag with its visual properties.
 */
export interface FlagInfo {
  label: string;
  color: string;
  textColor: string;
  /** Whether this flag should pulse continuously (black, meatball) */
  pulse: boolean;
}

/**
 * Flag definitions in priority order (highest priority first).
 * When multiple flags are active, the first match wins for resolveActiveFlag.
 */
export const FLAG_DEFINITIONS: ReadonlyArray<{
  check: (flags: number) => boolean;
  info: FlagInfo;
}> = [
  { check: (f) => hasFlag(f, Flags.Red), info: { label: "RED", color: "#e74c3c", textColor: "#ffffff", pulse: false } },
  {
    check: (f) => hasFlag(f, Flags.Black) || hasFlag(f, Flags.Disqualify),
    info: { label: "BLACK", color: "#1a1a1a", textColor: "#ffffff", pulse: true },
  },
  {
    check: (f) => hasFlag(f, Flags.Repair),
    info: { label: "REPAIR", color: "#e67e22", textColor: "#ffffff", pulse: true },
  },
  {
    check: (f) =>
      hasFlag(f, Flags.Yellow) ||
      hasFlag(f, Flags.YellowWaving) ||
      hasFlag(f, Flags.Caution) ||
      hasFlag(f, Flags.CautionWaving),
    info: { label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Blue),
    info: { label: "BLUE", color: "#3498db", textColor: "#ffffff", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.White),
    info: { label: "WHITE", color: "#e8e8e8", textColor: "#1a1a1a", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Checkered),
    info: { label: "FINISH", color: "#1a1a1a", textColor: "#ffffff", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Green),
    info: { label: "GREEN", color: "#2ecc71", textColor: "#ffffff", pulse: false },
  },
];

/**
 * Resolves the highest-priority active flag from the session flags bitfield.
 */
export function resolveActiveFlag(sessionFlags: number | undefined): FlagInfo | null {
  if (sessionFlags === undefined) return null;

  for (const def of FLAG_DEFINITIONS) {
    if (def.check(sessionFlags)) return def.info;
  }

  return null;
}

/**
 * Resolves all active flags from the session flags bitfield, in priority order.
 * Blue is suppressed when green is also active — this combination occurs only
 * at race start (rolling/standing start), not mid-race where blue means a
 * faster car is approaching.
 */
export function resolveAllActiveFlags(sessionFlags: number | undefined): FlagInfo[] {
  if (sessionFlags === undefined) return [];

  const result: FlagInfo[] = [];

  for (const def of FLAG_DEFINITIONS) {
    if (def.check(sessionFlags)) result.push(def.info);
  }

  // Suppress blue when green is active — green only appears at race start
  // (rolling start moment), and iRacing sets both Green + Blue bits together.
  // Mid-race blue (faster car approaching) never has green set.
  if (result.some((f) => f.label === "GREEN") && result.some((f) => f.label === "BLUE")) {
    return result.filter((f) => f.label !== "BLUE");
  }

  return result;
}
