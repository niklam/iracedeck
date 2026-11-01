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
 *         tenth one `lap-time-tenths/<d>` ("point four"), or its `<d>-gap`
 *         take when the fastest-lap gap clause follows it.
 *     The line that leads into the whole time — the every-lap intro, the
 *     fastest-lap lines — is cut once per **onset class** of the time's first
 *     word, its first sound (Niklas's rule, #1163): {@link compactLeadClass}.
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

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;
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
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

/**
 * A word a compact lap time can open with: the plain words zero to nine, the
 * teens, and the tens words twenty to ninety.
 */
export type NumberWord = (typeof ONES)[number] | (typeof TEENS)[number] | (typeof TENS)[number];

/**
 * The onset class of a word: its first sound, which is what a clip leading
 * into it has to be cut for (#1163). Words that start alike share a take —
 * "two", "ten", "twelve" and "twenty" all begin with a t.
 */
export type OnsetClass = "w" | "t" | "th" | "f" | "s" | "ei" | "n" | "e" | "z";

/** Every word's class, the table of Niklas's onset rule; a `Record` so no word can be left out. */
const ONSET_CLASS: Readonly<Record<NumberWord, OnsetClass>> = {
  zero: "z",
  one: "w",
  two: "t",
  ten: "t",
  twelve: "t",
  twenty: "t",
  three: "th",
  thirteen: "th",
  thirty: "th",
  four: "f",
  five: "f",
  fourteen: "f",
  fifteen: "f",
  forty: "f",
  fifty: "f",
  six: "s",
  seven: "s",
  sixteen: "s",
  seventeen: "s",
  sixty: "s",
  seventy: "s",
  eight: "ei",
  eighteen: "ei",
  eighty: "ei",
  nine: "n",
  nineteen: "n",
  ninety: "n",
  eleven: "e",
};

/** The onset class of a word ({@link OnsetClass}). */
export function onsetClass(word: NumberWord): OnsetClass {
  return ONSET_CLASS[word];
}

/**
 * The first word of a whole number 0–99 read plainly: "zero" … "nine", each
 * teen word, the tens word from twenty up ("forty" for 45). How a minute is
 * read, and the seconds of a lap under a minute. `null` for anything else.
 */
export function plainFirstWord(n: number): NumberWord | null {
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;

  if (n < 10) return ONES[n];

  if (n < 20) return TEENS[n - 10];

  return TENS[Math.floor(n / 10) - 2];
}

/** Whether the compact form speaks a minute: the lap, rounded at `precision`, is a minute or longer. */
export function compactHasMinute(lapTime: number, precision: CompactPrecision): boolean {
  const split = splitCompactLapTime(lapTime, precision);

  return split !== null && split.minutes >= 1;
}

/**
 * The onset class of the first word the compact readout speaks at
 * `precision` — the minute word ("one" for 1:23.4 → `w`), or under a minute
 * the seconds read plainly ("fifteen" for 15.2 → `f`, "zero" for 0.9 →
 * `z`). The line that leads into the time picks its take by it. `null` with
 * nothing to read, or a minute past 99 that has no word.
 */
export function compactLeadClass(lapTime: number, precision: CompactPrecision): OnsetClass | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null) return null;

  const word = plainFirstWord(split.minutes >= 1 ? split.minutes : split.seconds);

  return word === null ? null : onsetClass(word);
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
 * The fraction to the tenth as a `lap-time-tenths` pool reference: "point
 * N", the take `<d>` when it ends the line and `<d>-gap` when a gap clause
 * follows it (its `next_text` is "Gap is"). `beforeGap` is the caller's
 * answer to whether that clause will speak.
 */
export function compactTenthsRef(lapTime: number, beforeGap: boolean): string | null {
  const split = splitCompactLapTime(lapTime, "tenths");

  if (split === null) return null;

  const digit = String(split.digits[0]);

  return poolRef(LAP_TIME_COMPACT_GROUPS.tenths, beforeGap ? `${digit}-gap` : digit);
}
