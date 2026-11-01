/**
 * The shared lap-time readout (issues #555, #1163, #1571): the full form
 * #555 speaks to the tenth, and the compact form #1163 speaks to the
 * thousandth and #1571 to the tenth — each rounded once at its precision.
 */
import { describe, expect, it } from "vitest";

import {
  compactHasMinute,
  compactMinuteRef,
  compactSecondRef,
  compactSecondsFirstWord,
  compactTenthRef,
  compactThousandthRef,
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
      expect(compactSecondRef(t, "tenths"), String(t)).toBeNull();
      expect(compactTenthRef(t), String(t)).toBeNull();
      expect(compactThousandthRef(t, "first"), String(t)).toBeNull();
    }
  });
});

describe("compactSecondsFirstWord", () => {
  it("is oh for 00–09, each teen word for 10–19 and the tens word from 20 up", () => {
    expect([0, 5, 9].map(compactSecondsFirstWord)).toEqual(["oh", "oh", "oh"]);
    expect([10, 11, 13, 19].map(compactSecondsFirstWord)).toEqual(["ten", "eleven", "thirteen", "nineteen"]);
    expect([20, 29, 30, 45, 59].map(compactSecondsFirstWord)).toEqual(["twenty", "twenty", "thirty", "forty", "fifty"]);
  });
});

describe("the compact form", () => {
  it("reads 1:45.2374 to the thousandth as 1-forty, 45, point two, three, seven", () => {
    expect(compactMinuteRef(105.2374, "thousandths")).toBe("pool:lap-time-compact-minute/1-forty");
    expect(compactSecondRef(105.2374, "thousandths")).toBe("pool:lap-time-compact-second/45");
    expect(compactThousandthRef(105.2374, "first")).toBe("pool:lap-time-compact-thousandth-first/2");
    expect(compactThousandthRef(105.2374, "middle")).toBe("pool:lap-time-compact-thousandth-middle/3");
    expect(compactThousandthRef(105.2374, "last")).toBe("pool:lap-time-compact-thousandth-last/7");
    expect(compactThousandthRef(105.2376, "last")).toBe("pool:lap-time-compact-thousandth-last/8");
  });

  it("reads 0–9 seconds after a minute as a pair, and the minute take as oh (1:05.2 → 1-oh, 05)", () => {
    expect(compactMinuteRef(65.2, "tenths")).toBe("pool:lap-time-compact-minute/1-oh");
    expect(compactSecondRef(65.2, "tenths")).toBe("pool:lap-time-compact-second/05");
  });

  it("reads 00 seconds after a minute as the pair 00 (2:00.4 → 2-oh, 00)", () => {
    expect(compactMinuteRef(120.4, "tenths")).toBe("pool:lap-time-compact-minute/2-oh");
    expect(compactSecondRef(120.4, "tenths")).toBe("pool:lap-time-compact-second/00");
  });

  it("reads a sub-minute lap with no minute: plain under ten, the pairs from ten", () => {
    expect(compactHasMinute(58.041, "thousandths")).toBe(false);
    expect(compactMinuteRef(58.041, "thousandths")).toBeNull();
    expect(compactSecondRef(58.041, "thousandths")).toBe("pool:lap-time-compact-second/58");
    expect(compactSecondRef(7.25, "tenths")).toBe("pool:lap-time-compact-second-plain/7");
    expect(compactSecondRef(10.0, "tenths")).toBe("pool:lap-time-compact-second/10");
  });

  it("picks 1-oh and 00 for 59.96 at the tenth, the minute the rounding made", () => {
    expect(compactHasMinute(59.96, "tenths")).toBe(true);
    expect(compactMinuteRef(59.96, "tenths")).toBe("pool:lap-time-compact-minute/1-oh");
    expect(compactSecondRef(59.96, "tenths")).toBe("pool:lap-time-compact-second/00");
    expect(compactTenthRef(59.96)).toBe("pool:lap-time-compact-tenth/0");
  });

  it("decides the minute at its own precision: 59.9994 has none to the thousandth but one to the tenth", () => {
    expect(compactHasMinute(59.9994, "thousandths")).toBe(false);
    expect(compactSecondRef(59.9994, "thousandths")).toBe("pool:lap-time-compact-second/59");
    expect(compactHasMinute(59.9994, "tenths")).toBe(true);
  });

  it("names the eleventh minute as it is, so a voice with clips to ten aborts it (10:59.9995)", () => {
    expect(compactMinuteRef(659.9995, "thousandths")).toBe("pool:lap-time-compact-minute/11-oh");
  });

  it("reads 1:23.4 to the tenth as 1-twenty, 23, point four", () => {
    expect(compactMinuteRef(83.4, "tenths")).toBe("pool:lap-time-compact-minute/1-twenty");
    expect(compactSecondRef(83.4, "tenths")).toBe("pool:lap-time-compact-second/23");
    expect(compactTenthRef(83.4)).toBe("pool:lap-time-compact-tenth/4");
  });
});
