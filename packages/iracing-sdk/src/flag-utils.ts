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
 * Labels excluded from the overlay. These are either normal racing state
 * or informational flags that should not flash buttons.
 */
const OVERLAY_EXCLUDED_LABELS = new Set(["GREEN", "WHITE", "FINISH"]);

/**
 * Resolves all active warning flags from the session flags bitfield, in priority order.
 * Excludes non-warning flags: Green (normal racing), White (last lap), Checkered (finish).
 */
export function resolveAllActiveFlags(sessionFlags: number | undefined): FlagInfo[] {
  if (sessionFlags === undefined) return [];

  const result: FlagInfo[] = [];

  for (const def of FLAG_DEFINITIONS) {
    if (OVERLAY_EXCLUDED_LABELS.has(def.info.label)) continue;

    if (def.check(sessionFlags)) result.push(def.info);
  }

  return result;
}
