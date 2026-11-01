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
 *     timing screen reads, over the `lap-time-compact-*` groups and #555's
 *     `lap-time-second`. Each join is a clip boundary, and a clip that leads
 *     into another is cut once per **onset class** of the word that follows
 *     it — its first sound (Niklas's rule, #1163): {@link onsetClass}. So the
 *     minute take is `<m>-<class of the seconds word>` ("one" before "twenty
 *     three" is `1-t`, before "oh five" `1-oh`); the seconds after a minute
 *     are `lap-time-compact-second/00`–`09` ("oh five") below ten and
 *     `lap-time-second/10`–`59` from ten up, and under a minute
 *     `lap-time-second/0`–`59` throughout; the tail is either one "point N"
 *     (tenths, `lap-time-compact-tenth`) or, to the thousandth, "point N" by
 *     the class of the pair that follows (`lap-time-compact-point/<d>-<c>`)
 *     and the pair itself (`lap-time-compact-pair/00`–`99`, "oh seven",
 *     "thirty seven"). The line that leads into the whole time — the
 *     every-lap intro, the fastest-lap lines — takes the class of the time's
 *     first word ({@link compactLeadClass}).
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

/**
 * The compact-form groups (#1163, #1571). `plainSecond` is #555's own
 * `lap-time-second`, reused unchanged: the plain words 0–59 serve every
 * seconds value except 0–9 after a minute, which is read "oh N".
 */
export const LAP_TIME_COMPACT_GROUPS = {
  minute: "lap-time-compact-minute",
  ohSecond: "lap-time-compact-second",
  plainSecond: LAP_TIME_FULL_GROUPS.second,
  tenth: "lap-time-compact-tenth",
  point: "lap-time-compact-point",
  pair: "lap-time-compact-pair",
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
 * A word a compact lap time can open a clip with: "oh" (the "oh" of "oh
 * five" after a minute or a point), the plain words zero to nine, the teens,
 * and the tens words twenty to ninety.
 */
export type NumberWord = "oh" | (typeof ONES)[number] | (typeof TEENS)[number] | (typeof TENS)[number];

/**
 * The onset class of a word: its first sound, which is what a clip leading
 * into it has to be cut for (#1163). Words that start alike share a take —
 * "two", "ten", "twelve" and "twenty" all begin with a t.
 */
export type OnsetClass = "oh" | "w" | "t" | "th" | "f" | "s" | "ei" | "n" | "e" | "z";

/** Every word's class, the table of Niklas's onset rule; a `Record` so no word can be left out. */
const ONSET_CLASS: Readonly<Record<NumberWord, OnsetClass>> = {
  oh: "oh",
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

/**
 * The first word of a whole number 0–99 read as a pair, the way a timing
 * screen reads the seconds after a minute and the two digits after the
 * point: "oh" for 0–9 ("oh five", "oh oh"), otherwise as
 * {@link plainFirstWord}. `null` outside 0–99.
 */
export function pairFirstWord(n: number): NumberWord | null {
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;

  return n < 10 ? "oh" : plainFirstWord(n);
}

/** The onset class of `word`, or `null` with no word. */
function classOf(word: NumberWord | null): OnsetClass | null {
  return word === null ? null : onsetClass(word);
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

  return classOf(plainFirstWord(split.minutes >= 1 ? split.minutes : split.seconds));
}

/**
 * The compact minute as a `lap-time-compact-minute` pool reference, the take
 * chosen by the class of the seconds word that follows it (`1-t` for 1:23.4,
 * `1-oh` for 1:05.4 and 1:00.0, `1-f` for 1:45.237); `null` under a minute.
 * A minute the voice has no clip for — 11 and up — aborts the readout.
 */
export function compactMinuteRef(lapTime: number, precision: CompactPrecision): string | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null || split.minutes < 1) return null;

  const next = classOf(pairFirstWord(split.seconds));

  return next === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.minute, `${split.minutes}-${next}`);
}

/**
 * The compact seconds: after a minute, 0–9 as "oh N" from
 * `lap-time-compact-second` (`00`–`09`) and 10–59 from `lap-time-second`;
 * under a minute, `lap-time-second` (`0`–`59`, "seven", "fifty eight")
 * throughout.
 */
export function compactSecondRef(lapTime: number, precision: CompactPrecision): string | null {
  const split = splitCompactLapTime(lapTime, precision);

  if (split === null) return null;

  if (split.minutes >= 1 && split.seconds < 10) {
    return poolRef(LAP_TIME_COMPACT_GROUPS.ohSecond, String(split.seconds).padStart(2, "0"));
  }

  return poolRef(LAP_TIME_COMPACT_GROUPS.plainSecond, String(split.seconds));
}

/** The compact tenths tail as a `lap-time-compact-tenth` pool reference: "point N", which ends the time. */
export function compactTenthRef(lapTime: number): string | null {
  const split = splitCompactLapTime(lapTime, "tenths");

  return split === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.tenth, String(split.digits[0]));
}

/** The thousandths of a lap as the point's digit and the pair after it (1:45.237 → 2 and 37); `null` with nothing to read. */
function thousandthsTail(lapTime: number): { digit: number; pair: number } | null {
  const split = splitCompactLapTime(lapTime, "thousandths");

  if (split === null) return null;

  const [digit, tens, ones] = split.digits;

  return { digit, pair: tens * 10 + ones };
}

/**
 * The first digit after the point, to the thousandth, as a
 * `lap-time-compact-point` pool reference: "point N" in the take for the
 * class of the pair that follows (`2-th` for 1:45.237, `0-oh` for .007,
 * `0-n` for .019).
 */
export function compactPointRef(lapTime: number): string | null {
  const tail = thousandthsTail(lapTime);

  if (tail === null) return null;

  const next = classOf(pairFirstWord(tail.pair));

  return next === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.point, `${tail.digit}-${next}`);
}

/**
 * The last two digits, to the thousandth, as a `lap-time-compact-pair` pool
 * reference `00`–`99` ("oh seven", "thirty seven"), which ends the time.
 */
export function compactPairRef(lapTime: number): string | null {
  const tail = thousandthsTail(lapTime);

  return tail === null ? null : poolRef(LAP_TIME_COMPACT_GROUPS.pair, String(tail.pair).padStart(2, "0"));
}
