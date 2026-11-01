/**
 * The shared lap-time readout (issues #555, #1163, #1571): the full form
 * #555 speaks to the tenth, and the compact form #1163 speaks to the
 * thousandth and #1571 to the tenth — each rounded once at its precision,
 * read as whole phrases (the clock, then the fraction). The line before the
 * time ends its own sentence, so nothing here picks it.
 */
import { describe, expect, it } from "vitest";

import {
  compactClockRef,
  compactHasMinute,
  compactTenthsRef,
  compactThousandthsRef,
  fullDecimalRef,
  fullHasMinute,
  fullMinuteRef,
  fullSecondRef,
  splitCompactLapTime,
  splitLapTime,
} from "./lap-time-readout.js";

describe("the full form (#555)", () => {
  it("splits and resolves 1:34.8 as minute 1, second 34, decimal 8", () => {
    expect(splitLapTime(94.8)).toEqual({ minutes: 1, seconds: 34, tenths: 8 });
    expect(fullMinuteRef(94.8)).toBe("pool:lap-time-minute/1");
    expect(fullSecondRef(94.8)).toBe("pool:lap-time-second/34");
    expect(fullDecimalRef(94.8)).toBe("pool:lap-time-decimal/8");
    expect(fullHasMinute(94.8)).toBe(true);
  });

  it("has no minute under one minute, and carries 59.95 into 1:00.0", () => {
    expect(fullMinuteRef(34.8)).toBeNull();
    expect(fullHasMinute(34.8)).toBe(false);
    expect(fullMinuteRef(59.95)).toBe("pool:lap-time-minute/1");
    expect(fullSecondRef(59.95)).toBe("pool:lap-time-second/0");
  });

  it("names a minute past ten as it is — the clips decide what is speakable (#836)", () => {
    expect(fullMinuteRef(750.5)).toBe("pool:lap-time-minute/12");
  });
});

describe("splitCompactLapTime", () => {
  it("rounds once to the thousandth: 1:45.2374 is 237 and 1:45.2376 is 238", () => {
    expect(splitCompactLapTime(105.2374, "thousandths")).toEqual({ minutes: 1, seconds: 45, digits: [2, 3, 7] });
    expect(splitCompactLapTime(105.2376, "thousandths")).toEqual({ minutes: 1, seconds: 45, digits: [2, 3, 8] });
  });

  it("keeps leading zeros of the fraction (58.041 → 0, 4, 1)", () => {
    expect(splitCompactLapTime(58.041, "thousandths")).toEqual({ minutes: 0, seconds: 58, digits: [0, 4, 1] });
  });

  it("rounds once to the tenth, carrying 59.96 into 1:00.0", () => {
    expect(splitCompactLapTime(59.96, "tenths")).toEqual({ minutes: 1, seconds: 0, digits: [0] });
  });

  it("carries 10:59.9995 into 11:00.000 at the thousandth", () => {
    expect(splitCompactLapTime(659.9995, "thousandths")).toEqual({ minutes: 11, seconds: 0, digits: [0, 0, 0] });
  });

  it("has nothing to say for a time that is not a positive finite number", () => {
    for (const t of [0, -5, NaN, Infinity]) {
      expect(splitCompactLapTime(t, "thousandths"), String(t)).toBeNull();
      expect(compactClockRef(t, "tenths"), String(t)).toBeNull();
      expect(compactClockRef(t, "thousandths"), String(t)).toBeNull();
      expect(compactTenthsRef(t, false), String(t)).toBeNull();
      expect(compactTenthsRef(t, true), String(t)).toBeNull();
      expect(compactThousandthsRef(t), String(t)).toBeNull();
    }
  });
});

describe("the compact clock", () => {
  it("reads 1:23.456 as the phrase 1m23 (the positive control on the group)", () => {
    expect(compactClockRef(83.456, "thousandths")).toBe("pool:lap-time-clock/1m23");
    expect(compactClockRef(83.4, "tenths")).toBe("pool:lap-time-clock/1m23");
  });

  it("pads the seconds to two digits: 2:05.007 is 2m05, 10:00.000 is 10m00", () => {
    expect(compactClockRef(125.007, "thousandths")).toBe("pool:lap-time-clock/2m05");
    expect(compactClockRef(600.0, "thousandths")).toBe("pool:lap-time-clock/10m00");
    // The positive control on the padding: ten seconds and up are as they are.
    expect(compactClockRef(130.0, "thousandths")).toBe("pool:lap-time-clock/2m10");
  });

  it("reads a lap under a minute from #555's lap-time-second: 58.041 is fifty eight, 7.25 seven", () => {
    expect(compactHasMinute(58.041, "thousandths")).toBe(false);
    expect(compactClockRef(58.041, "thousandths")).toBe("pool:lap-time-second/58");
    expect(compactClockRef(7.25, "tenths")).toBe("pool:lap-time-second/7");
    // The positive control: the same seconds after a minute are a clock phrase.
    expect(compactClockRef(67.25, "tenths")).toBe("pool:lap-time-clock/1m07");
  });

  it("reads the minute the rounding made: 59.9996 to the thousandth and 59.96 to the tenth are 1m00", () => {
    expect(compactHasMinute(59.9996, "thousandths")).toBe(true);
    expect(compactClockRef(59.9996, "thousandths")).toBe("pool:lap-time-clock/1m00");
    expect(compactClockRef(59.96, "tenths")).toBe("pool:lap-time-clock/1m00");
    // The positive control: 59.9994 stays under a minute to the thousandth.
    expect(compactHasMinute(59.9994, "thousandths")).toBe(false);
    // Each precision rounds on its own: 59.96 is a minute to the tenth, not to the thousandth.
    expect(compactHasMinute(59.96, "tenths")).toBe(true);
    expect(compactHasMinute(59.96, "thousandths")).toBe(false);
    expect(compactClockRef(59.9994, "thousandths")).toBe("pool:lap-time-second/59");
  });

  it("names the eleventh minute as it is, so a voice with clips to 10m59 aborts it (10:59.9996)", () => {
    expect(compactClockRef(659.9996, "thousandths")).toBe("pool:lap-time-clock/11m00");
    expect(compactClockRef(659.9994, "thousandths")).toBe("pool:lap-time-clock/10m59");
  });
});

describe("the compact fraction to the thousandth", () => {
  it("reads 1:23.456 as 456", () => {
    expect(compactThousandthsRef(83.456)).toBe("pool:lap-time-thousandths/456");
  });

  it("keeps a trailing zero in the base: 1:23.450 is 450, not 45", () => {
    expect(compactThousandthsRef(83.45)).toBe("pool:lap-time-thousandths/450");
    // The positive control: a non-zero last digit is read as it is.
    expect(compactThousandthsRef(83.451)).toBe("pool:lap-time-thousandths/451");
  });

  it("keeps leading zeros: 2:05.007 is 007, 58.041 is 041", () => {
    expect(compactThousandthsRef(125.007)).toBe("pool:lap-time-thousandths/007");
    expect(compactThousandthsRef(58.041)).toBe("pool:lap-time-thousandths/041");
  });

  it("reads a whole number of seconds as 000: 10:00.000, and 59.9996 rounded into 1:00.000", () => {
    expect(compactThousandthsRef(600.0)).toBe("pool:lap-time-thousandths/000");
    expect(compactThousandthsRef(59.9996)).toBe("pool:lap-time-thousandths/000");
  });

  it("rounds once at the thousandth: 1:45.2374 is 237 and 1:45.2376 is 238", () => {
    expect(compactThousandthsRef(105.2374)).toBe("pool:lap-time-thousandths/237");
    expect(compactThousandthsRef(105.2376)).toBe("pool:lap-time-thousandths/238");
  });
});

describe("the compact fraction to the tenth", () => {
  it("reads 1:23.44 as the clock 1m23 and point four, the take that ends the line", () => {
    expect(compactClockRef(83.44, "tenths")).toBe("pool:lap-time-clock/1m23");
    expect(compactTenthsRef(83.44, false)).toBe("pool:lap-time-tenths/4");
  });

  it("takes <d>-gap when the gap clause follows, and only then", () => {
    expect(compactTenthsRef(83.44, true)).toBe("pool:lap-time-tenths/4-gap");
    expect(compactTenthsRef(83.44, false)).toBe("pool:lap-time-tenths/4");
  });

  it("carries 59.96 into 1m00 and point oh", () => {
    expect(compactClockRef(59.96, "tenths")).toBe("pool:lap-time-clock/1m00");
    expect(compactTenthsRef(59.96, false)).toBe("pool:lap-time-tenths/0");
    // The positive control: 59.94 stays fifty nine point nine.
    expect(compactClockRef(59.94, "tenths")).toBe("pool:lap-time-second/59");
    expect(compactTenthsRef(59.94, false)).toBe("pool:lap-time-tenths/9");
  });
});
