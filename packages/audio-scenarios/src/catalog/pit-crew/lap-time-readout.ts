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
 *     fastest-lap call to the tenth): "one twenty three point four", the way a
 *     timing screen reads, as whole phrases rather than spliced words
 *     (revision 5 of the clip contract, after Niklas's trial). Two clips read
 *     the time:
 *       - the **clock**: from a minute up one `lap-time-clock/<m>m<ss>` phrase
 *         ("one twenty three", "two oh five", "ten oh oh"); under a minute
 *         #555's `lap-time-second/<s>` word ("fifty eight");
 *       - the **fraction**: to the thousandth one
 *         `lap-time-thousandths/<ddd>` phrase ("point four five six"), to the
 *         tenth one `lap-time-tenths/<d>` ("point four."), which ends its
 *         sentence even when the fastest-lap gap clause follows it: a break
 *         before "Gap is" is natural (Niklas, revision 6), so the script
 *         pauses there rather than joining the two.
 *     The line that leads into the whole time — the every-lap intro, the
 *     fastest-lap lines — ends its own sentence (revision 6, Niklas: the
 *     period "makes it end cleanly and sharp"), so it is one take whatever the
 *     time opens with, and nothing here picks it.
 *
 * Neither form has a hardcoded range beyond what its precision implies: a
 * value with no clip for the active voice aborts the readout at expansion
 * (issues #835/#836). That is the eleven-minute ceiling both specs state —
 * the clock clips stop at `10m59`, so an 11:00.0 lap (or a 10:59.9996 one
 * that rounds into it) resolves to a base no voice ships and the whole line
 * is dropped, never half of it.
 */
import { poolRef } from "../../dsl.js";

/** #555's full-form groups. */
export const LAP_TIME_FULL_GROUPS = {
  minute: "lap-time-minute",
  second: "lap-time-second",
  decimal: "lap-time-decimal",
} as const;

/**
 * The compact-form groups (#1163, #1571). `second` is #555's own
 * `lap-time-second`, reused unchanged for the clock of a lap under a minute.
 */
export const LAP_TIME_COMPACT_GROUPS = {
  clock: "lap-time-clock",
  second: LAP_TIME_FULL_GROUPS.second,
  thousandths: "lap-time-thousandths",
  tenths: "lap-time-tenths",
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

/** Whether the compact form speaks a minute: the lap, rounded at `precision`, is a minute or longer. */
export function compactHasMinute(lapTime: number, precision: CompactPrecision): boolean {
  const split = splitCompactLapTime(lapTime, precision);

  return split !== null && split.minutes >= 1;
}

/**
 * The compact clock at `precision`, one clip: from a minute up the
 * `lap-time-clock` phrase `<m>m<ss>` (`1m23` for 1:23.4, `2m05` for 2:05.0,
 * `1m00` for 59.96 at the tenth, the minute the rounding made); under a
 * minute #555's `lap-time-second/<s>` (`58` for 58.041). A minute the voice
 * has no clip for — 11 and up — aborts the readout.
 */
export function compactClockRef(lapTime: number, precision: CompactPrecision): string | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null) return null;

  if (split.minutes < 1) return poolRef(LAP_TIME_COMPACT_GROUPS.second, String(split.seconds));

  return poolRef(LAP_TIME_COMPACT_GROUPS.clock, `${split.minutes}m${String(split.seconds).padStart(2, "0")}`);
}

/**
 * The fraction to the thousandth as a `lap-time-thousandths` pool reference,
 * which ends the time: the rounded value as three digits, `456` for
 * 1:23.456, `450` for 1:23.450, `007` for 2:05.007, `000` for 59.9996. The
 * base keeps every digit; only the clip's text drops trailing zeros.
 */
export function compactThousandthsRef(lapTime: number): string | null {
  const split = splitCompactLapTime(lapTime, "thousandths");

  return split === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.thousandths, split.digits.join(""));
}

/**
 * The fraction to the tenth as a `lap-time-tenths` pool reference, `<d>`:
 * "point N.", one take that ends its sentence whatever follows it — the end
 * of the line or, after a pause, the fastest-lap gap clause.
 */
export function compactTenthsRef(lapTime: number): string | null {
  const split = splitCompactLapTime(lapTime, "tenths");

  if (split === null) return null;

  return poolRef(LAP_TIME_COMPACT_GROUPS.tenths, String(split.digits[0]));
}
