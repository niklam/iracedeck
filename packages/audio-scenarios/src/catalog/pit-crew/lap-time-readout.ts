/**
 * The lap-time readout (issues #555, #1163, #1571): how a lap time is split
 * into spoken parts and which clip pool each part draws from. One module, so
 * no two callouts round the same lap differently, and a change to how a lap
 * time is split reaches every callout that reads one.
 *
 * Two forms, each rounding ONCE at its own precision at the input boundary so
 * its parts stay internally consistent:
 *
 *   - **Full** (#555's best-lap call, tenths): "one minute, twenty-three,
 *     point four seconds." over the four `lap-time-*` groups — a minute clip
 *     that carries the word "minute", a second clip with a trailing comma, and
 *     a "point N seconds." tail.
 *   - **Compact** (#1163's every-lap call to the thousandth, #1571's
 *     fastest-lap call to the tenth): "one twenty-three point four", the way a
 *     timing screen reads, over the `lap-time-compact-*` groups. Each join is
 *     a clip boundary, and each clip is cut once per distinct continuation:
 *     the minute take is chosen by the first word of the seconds that follow
 *     it (`<m>-oh`, `<m>-ten` … `<m>-nineteen`, `<m>-twenty` … `<m>-fifty`),
 *     the seconds after a minute are a pair `00`–`59` ("oh five"), under a
 *     minute they are plain (`second-plain/0`–`9`) or the same pairs from 10
 *     up, and the tail is either one phrase-final "point N." (tenths) or three
 *     digits (`thousandth-first`, `-middle`, `-last`).
 *
 * Neither form has a hardcoded range beyond what its precision implies: a
 * value with no clip for the active voice aborts the readout at expansion
 * (issues #835/#836). That is the eleven-minute ceiling both specs state —
 * the minute clips stop at ten, so an 11:00.0 lap (or a 10:59.9995 one that
 * rounds into it) resolves to a base no voice ships and the whole line is
 * dropped, never half of it.
 */
import { poolRef } from "../../dsl.js";

/** #555's full-form groups. */
export const LAP_TIME_FULL_GROUPS = {
  minute: "lap-time-minute",
  second: "lap-time-second",
  decimal: "lap-time-decimal",
} as const;

/** The compact-form groups (#1163, #1571). */
export const LAP_TIME_COMPACT_GROUPS = {
  minute: "lap-time-compact-minute",
  second: "lap-time-compact-second",
  secondPlain: "lap-time-compact-second-plain",
  tenth: "lap-time-compact-tenth",
  thousandthFirst: "lap-time-compact-thousandth-first",
  thousandthMiddle: "lap-time-compact-thousandth-middle",
  thousandthLast: "lap-time-compact-thousandth-last",
} as const;

/**
 * Split a lap time (seconds) into minute / whole-second / decimal-tenth, with
 * a single round-to-nearest-tenth at the input boundary so 34.85 → 34.9 and
 * the three components stay internally consistent. #555's full form.
 */
export function splitLapTime(lapTime: number): { minutes: number; seconds: number; tenths: number } {
  if (!Number.isFinite(lapTime) || lapTime < 0) {
    return { minutes: 0, seconds: 0, tenths: 0 };
  }

  const totalTenths = Math.round(lapTime * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return { minutes, seconds, tenths };
}

/** The full form's minute as a `lap-time-minute` pool reference; `null` under a minute. */
export function fullMinuteRef(lapTime: number): string | null {
  const { minutes } = splitLapTime(lapTime);

  return minutes < 1 ? null : poolRef(LAP_TIME_FULL_GROUPS.minute, String(minutes));
}

/** The full form's whole seconds (0–59) as a `lap-time-second` pool reference. */
export function fullSecondRef(lapTime: number): string {
  return poolRef(LAP_TIME_FULL_GROUPS.second, String(splitLapTime(lapTime).seconds));
}

/** The full form's tenths (0–9) as a `lap-time-decimal` pool reference ("point N seconds."). */
export function fullDecimalRef(lapTime: number): string {
  return poolRef(LAP_TIME_FULL_GROUPS.decimal, String(splitLapTime(lapTime).tenths));
}

/** Whether the full form speaks a minute: the lap, rounded to the tenth, is a minute or longer. */
export function fullHasMinute(lapTime: number): boolean {
  return splitLapTime(lapTime).minutes >= 1;
}

/** The precision a compact readout is rounded to, once. */
export type CompactPrecision = "tenths" | "thousandths";

/**
 * A lap time split for the compact form: whole minutes, whole seconds (0–59)
 * and the fraction's digits at the precision asked for — one digit for
 * tenths, three for thousandths.
 */
export type CompactLapTime = { minutes: number; seconds: number; digits: readonly number[] };

const DIGITS: Record<CompactPrecision, number> = { tenths: 1, thousandths: 3 };

/**
 * Split a lap time for the compact form, rounding once at `precision`:
 * 1:45.2374 → `{ 1, 45, [2, 3, 7] }` to the thousandth, 59.96 → `{ 1, 0, [0] }`
 * to the tenth. `null` for a time that is not a positive finite number —
 * nothing to say, so every compact var resolves to nothing and the line
 * aborts.
 */
export function splitCompactLapTime(lapTime: number, precision: CompactPrecision): CompactLapTime | null {
  if (!Number.isFinite(lapTime) || lapTime <= 0) return null;

  const places = DIGITS[precision];
  const scale = 10 ** places;
  const total = Math.round(lapTime * scale);
  const totalSeconds = Math.floor(total / scale);
  const fraction = total % scale;
  const digits = String(fraction).padStart(places, "0").split("").map(Number);

  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60, digits };
}

const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;
const TENS = ["twenty", "thirty", "forty", "fifty"] as const;

/**
 * The first word of a seconds pair (0–59) as the compact form speaks it after
 * a minute: `oh` for 00–09 ("oh five", "oh oh"), each teen word for 10–19, and
 * the tens word from 20 up. It names the minute take that leads into it.
 *
 * @internal Exported for testing.
 */
export function compactSecondsFirstWord(seconds: number): string {
  if (seconds < 10) return "oh";

  if (seconds < 20) return TEENS[seconds - 10];

  return TENS[Math.floor(seconds / 10) - 2];
}

/** Whether the compact form speaks a minute: the lap, rounded at `precision`, is a minute or longer. */
export function compactHasMinute(lapTime: number, precision: CompactPrecision): boolean {
  const split = splitCompactLapTime(lapTime, precision);

  return split !== null && split.minutes >= 1;
}

/**
 * The compact minute as a `lap-time-compact-minute` pool reference, the take
 * chosen by the seconds that follow it (`1-twenty` for 1:23.4, `1-oh` for
 * 1:05.0 and 1:00.0); `null` under a minute. A minute the voice has no clip
 * for — 11 and up — aborts the readout.
 */
export function compactMinuteRef(lapTime: number, precision: CompactPrecision): string | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null || split.minutes < 1) return null;

  return poolRef(LAP_TIME_COMPACT_GROUPS.minute, `${split.minutes}-${compactSecondsFirstWord(split.seconds)}`);
}

/**
 * The compact seconds: after a minute, the pair from `lap-time-compact-second`
 * (`00`–`59`, "oh five"); under a minute, `lap-time-compact-second-plain`
 * (`0`–`9`, "five") below ten and the same pairs (`10`–`59`) from ten up.
 */
export function compactSecondRef(lapTime: number, precision: CompactPrecision): string | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null) return null;

  if (split.minutes >= 1) return poolRef(LAP_TIME_COMPACT_GROUPS.second, String(split.seconds).padStart(2, "0"));

  if (split.seconds < 10) return poolRef(LAP_TIME_COMPACT_GROUPS.secondPlain, String(split.seconds));

  return poolRef(LAP_TIME_COMPACT_GROUPS.second, String(split.seconds));
}

/** The compact tenths tail as a `lap-time-compact-tenth` pool reference: "point N.", phrase-final. */
export function compactTenthRef(lapTime: number): string | null {
  const split = splitCompactLapTime(lapTime, "tenths");

  return split === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.tenth, String(split.digits[0]));
}

/** Which of the three thousandths clips: "point" with the first digit, the middle digit, the phrase-final last. */
export type ThousandthPart = "first" | "middle" | "last";

const THOUSANDTH_GROUP: Record<ThousandthPart, string> = {
  first: LAP_TIME_COMPACT_GROUPS.thousandthFirst,
  middle: LAP_TIME_COMPACT_GROUPS.thousandthMiddle,
  last: LAP_TIME_COMPACT_GROUPS.thousandthLast,
};

const THOUSANDTH_INDEX: Record<ThousandthPart, number> = { first: 0, middle: 1, last: 2 };

/** One digit of the compact thousandths tail as a pool reference into its group. */
export function compactThousandthRef(lapTime: number, part: ThousandthPart): string | null {
  const split = splitCompactLapTime(lapTime, "thousandths");

  return split === null ? null : poolRef(THOUSANDTH_GROUP[part], String(split.digits[THOUSANDTH_INDEX[part]]));
}
