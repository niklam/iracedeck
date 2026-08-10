import { Flags } from "@iracedeck/iracing-native";

import { hasFlag } from "./utils.js";

/** The four per-driver penalty/status bits `CarIdxSessionFlags` can carry. */
export const PENALTY_FLAG_MASK: number = Flags.Furled | Flags.Black | Flags.Repair | Flags.Disqualify;

/** Decoded penalty bits for one car. Pure — no translator state involved. */
export type CarPenaltyFlags = {
  furled: boolean;
  black: boolean;
  repair: boolean;
  disqualify: boolean;
};

/**
 * Decode a car's `CarIdxSessionFlags` value into its penalty bits (issue
 * #936). Missing telemetry decodes as no flags — don't punish missing data.
 */
export function decodePenaltyFlags(bits: number | undefined): CarPenaltyFlags {
  return {
    furled: hasFlag(bits, Flags.Furled),
    black: hasFlag(bits, Flags.Black),
    repair: hasFlag(bits, Flags.Repair),
    disqualify: hasFlag(bits, Flags.Disqualify),
  };
}
