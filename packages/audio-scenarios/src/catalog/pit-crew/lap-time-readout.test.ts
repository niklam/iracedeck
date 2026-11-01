/**
 * The shared lap-time readout (issues #555, #1163, #1571): the full form
 * #555 speaks to the tenth, and the compact form #1163 speaks to the
 * thousandth and #1571 to the tenth — each rounded once at its precision,
 * each clip that leads into another chosen by the onset class of the word
 * after it.
 */
import { describe, expect, it } from "vitest";

import {
  compactHasMinute,
  compactLeadClass,
  compactMinuteRef,
  compactPairRef,
  compactPointRef,
  compactSecondRef,
  compactTenthRef,
  fullDecimalRef,
  fullHasMinute,
  fullMinuteRef,
  fullSecondRef,
  type NumberWord,
  onsetClass,
  type OnsetClass,
  pairFirstWord,
  plainFirstWord,
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

describe("the onset classes (#1163)", () => {
  /** The contract's table, word for word: a clip leading into a word is cut once per class. */
  const TABLE: Readonly<Record<OnsetClass, readonly NumberWord[]>> = {
    oh: ["oh"],
    w: ["one"],
    t: ["two", "ten", "twelve", "twenty"],
    th: ["three", "thirteen", "thirty"],
    f: ["four", "five", "fourteen", "fifteen", "forty", "fifty"],
    s: ["six", "seven", "sixteen", "seventeen", "sixty", "seventy"],
    ei: ["eight", "eighteen", "eighty"],
    n: ["nine", "nineteen", "ninety"],
    e: ["eleven"],
    z: ["zero"],
  };

  it("puts every word of the table in its class", () => {
    for (const [cls, words] of Object.entries(TABLE)) {
      for (const word of words) expect(onsetClass(word), word).toBe(cls);
    }
  });

  it("covers exactly the words a compact time speaks first: oh, 0–9, the teens and the tens", () => {
    const tabled = Object.values(TABLE).flat().sort();
    const spoken = new Set<NumberWord>(["oh"]);

    for (let n = 0; n < 100; n++) spoken.add(plainFirstWord(n) as NumberWord);

    expect(tabled).toEqual([...spoken].sort());
    expect(tabled).toHaveLength(29);
  });

  it("tells apart words that only look alike (the positive control): two is t, three is th, eleven is e", () => {
    expect(onsetClass("two")).not.toBe(onsetClass("three"));
    expect(onsetClass("ten")).not.toBe(onsetClass("eleven"));
    expect(onsetClass("eight")).not.toBe(onsetClass("eleven"));
    expect(onsetClass("oh")).not.toBe(onsetClass("zero"));
  });
});

describe("the first spoken word", () => {
  it("reads plainly: zero to nine, each teen, the tens word from twenty", () => {
    expect([0, 1, 5, 9].map(plainFirstWord)).toEqual(["zero", "one", "five", "nine"]);
    expect([10, 11, 13, 19].map(plainFirstWord)).toEqual(["ten", "eleven", "thirteen", "nineteen"]);
    expect([20, 29, 37, 45, 59, 61, 78, 80, 99].map(plainFirstWord)).toEqual([
      "twenty",
      "twenty",
      "thirty",
      "forty",
      "fifty",
      "sixty",
      "seventy",
      "eighty",
      "ninety",
    ]);
  });

  it("reads a pair with oh below ten, and as plainly from ten up", () => {
    expect([0, 5, 9].map(pairFirstWord)).toEqual(["oh", "oh", "oh"]);
    expect([10, 19, 23, 99].map(pairFirstWord)).toEqual(["ten", "nineteen", "twenty", "ninety"]);
  });

  it("has no word outside 0–99 or for a fraction", () => {
    for (const n of [-1, 100, 1.5, NaN]) {
      expect(plainFirstWord(n), String(n)).toBeNull();
      expect(pairFirstWord(n), String(n)).toBeNull();
    }
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
      expect(compactLeadClass(t, "tenths"), String(t)).toBeNull();
      expect(compactMinuteRef(t, "tenths"), String(t)).toBeNull();
      expect(compactSecondRef(t, "tenths"), String(t)).toBeNull();
      expect(compactTenthRef(t), String(t)).toBeNull();
      expect(compactPointRef(t), String(t)).toBeNull();
      expect(compactPairRef(t), String(t)).toBeNull();
    }
  });
});

describe("the compact form: minute and seconds", () => {
  it("reads 1:05.4 as minute 1-oh and the seconds oh five from lap-time-compact-second", () => {
    expect(compactMinuteRef(65.4, "tenths")).toBe("pool:lap-time-compact-minute/1-oh");
    expect(compactSecondRef(65.4, "tenths")).toBe("pool:lap-time-compact-second/05");
  });

  it("reads 1:23.4 as minute 1-t and the seconds twenty three from lap-time-second (the positive control)", () => {
    expect(compactMinuteRef(83.4, "tenths")).toBe("pool:lap-time-compact-minute/1-t");
    expect(compactSecondRef(83.4, "tenths")).toBe("pool:lap-time-second/23");
    expect(compactTenthRef(83.4)).toBe("pool:lap-time-compact-tenth/4");
  });

  it("takes the minute by the class of the seconds word: 1:11 e, 1:13 th, 1:16 s, 1:18 ei, 1:19 n", () => {
    expect([71.0, 73.0, 76.0, 78.0, 79.0].map((t) => compactMinuteRef(t, "tenths"))).toEqual([
      "pool:lap-time-compact-minute/1-e",
      "pool:lap-time-compact-minute/1-th",
      "pool:lap-time-compact-minute/1-s",
      "pool:lap-time-compact-minute/1-ei",
      "pool:lap-time-compact-minute/1-n",
    ]);
  });

  it("reads 00 seconds after a minute as oh oh (2:00.4 → 2-oh, compact-second/00)", () => {
    expect(compactMinuteRef(120.4, "tenths")).toBe("pool:lap-time-compact-minute/2-oh");
    expect(compactSecondRef(120.4, "tenths")).toBe("pool:lap-time-compact-second/00");
  });

  it("reads a lap under a minute plainly from lap-time-second: 7.25 is seven, not oh seven", () => {
    expect(compactHasMinute(7.25, "tenths")).toBe(false);
    expect(compactMinuteRef(7.25, "tenths")).toBeNull();
    expect(compactSecondRef(7.25, "tenths")).toBe("pool:lap-time-second/7");
    // The positive control: the same seconds after a minute are "oh seven".
    expect(compactSecondRef(67.25, "tenths")).toBe("pool:lap-time-compact-second/07");
  });

  it("picks 1-oh and 00 for 59.96 at the tenth, the minute the rounding made", () => {
    expect(compactHasMinute(59.96, "tenths")).toBe(true);
    expect(compactMinuteRef(59.96, "tenths")).toBe("pool:lap-time-compact-minute/1-oh");
    expect(compactSecondRef(59.96, "tenths")).toBe("pool:lap-time-compact-second/00");
    expect(compactTenthRef(59.96)).toBe("pool:lap-time-compact-tenth/0");
  });

  it("decides the minute at its own precision: 59.9994 has none to the thousandth but one to the tenth", () => {
    expect(compactHasMinute(59.9994, "thousandths")).toBe(false);
    expect(compactSecondRef(59.9994, "thousandths")).toBe("pool:lap-time-second/59");
    expect(compactHasMinute(59.9994, "tenths")).toBe(true);
  });

  it("names the eleventh minute as it is, so a voice with clips to ten aborts it (10:59.9995)", () => {
    expect(compactMinuteRef(659.9995, "thousandths")).toBe("pool:lap-time-compact-minute/11-oh");
    expect(compactMinuteRef(659.9994, "thousandths")).toBe("pool:lap-time-compact-minute/10-f");
  });
});

describe("the compact form: the thousandths", () => {
  it("reads 1:45.237 as 1-f, forty five, point two by thirty's class, thirty seven", () => {
    expect(compactMinuteRef(105.237, "thousandths")).toBe("pool:lap-time-compact-minute/1-f");
    expect(compactSecondRef(105.237, "thousandths")).toBe("pool:lap-time-second/45");
    expect(compactPointRef(105.237)).toBe("pool:lap-time-compact-point/2-th");
    expect(compactPairRef(105.237)).toBe("pool:lap-time-compact-pair/37");
  });

  it("rounds once to the thousandth: 1:45.2374 is pair 37 and 1:45.2376 pair 38", () => {
    expect(compactPointRef(105.2374)).toBe("pool:lap-time-compact-point/2-th");
    expect(compactPairRef(105.2374)).toBe("pool:lap-time-compact-pair/37");
    expect(compactPairRef(105.2376)).toBe("pool:lap-time-compact-pair/38");
  });

  it("reads .007 as point oh by oh's class and the pair oh seven", () => {
    expect(compactPointRef(83.007)).toBe("pool:lap-time-compact-point/0-oh");
    expect(compactPairRef(83.007)).toBe("pool:lap-time-compact-pair/07");
  });

  it("reads .019 as point oh by nineteen's class and the pair nineteen", () => {
    expect(compactPointRef(83.019)).toBe("pool:lap-time-compact-point/0-n");
    expect(compactPairRef(83.019)).toBe("pool:lap-time-compact-pair/19");
  });

  it("reads .210 as point two by ten's class and the pair ten", () => {
    expect(compactPointRef(83.21)).toBe("pool:lap-time-compact-point/2-t");
    expect(compactPairRef(83.21)).toBe("pool:lap-time-compact-pair/10");
  });

  it("reads 58.041 with no minute: fifty eight, point oh by forty's class, forty one", () => {
    expect(compactMinuteRef(58.041, "thousandths")).toBeNull();
    expect(compactSecondRef(58.041, "thousandths")).toBe("pool:lap-time-second/58");
    expect(compactPointRef(58.041)).toBe("pool:lap-time-compact-point/0-f");
    expect(compactPairRef(58.041)).toBe("pool:lap-time-compact-pair/41");
  });

  it("reads .000 as point oh by oh's class and oh oh", () => {
    expect(compactPointRef(659.9995)).toBe("pool:lap-time-compact-point/0-oh");
    expect(compactPairRef(659.9995)).toBe("pool:lap-time-compact-pair/00");
  });
});

describe("compactLeadClass — the class of the time's first word", () => {
  it("is the minute word's class from a minute up: 1:xx w, 2:00 t, 3:xx th, 4:05 f, 6:xx s, 8:xx ei, 9:xx n, 10:xx t", () => {
    expect(compactLeadClass(83.4, "tenths")).toBe("w");
    expect(compactLeadClass(120.0, "tenths")).toBe("t");
    expect(compactLeadClass(190.0, "tenths")).toBe("th");
    expect(compactLeadClass(245.0, "tenths")).toBe("f");
    expect(compactLeadClass(370.0, "tenths")).toBe("s");
    expect(compactLeadClass(490.0, "tenths")).toBe("ei");
    expect(compactLeadClass(550.0, "tenths")).toBe("n");
    expect(compactLeadClass(610.0, "tenths")).toBe("t");
  });

  it("is the plain seconds word's class under a minute: 15.2 f, 0.9 z, 5.0 f, 9.9 n, 11.3 e, 13.0 th, 58.041 f", () => {
    expect(compactLeadClass(15.2, "tenths")).toBe("f");
    expect(compactLeadClass(0.9, "tenths")).toBe("z");
    expect(compactLeadClass(5.0, "tenths")).toBe("f");
    expect(compactLeadClass(9.9, "tenths")).toBe("n");
    expect(compactLeadClass(11.3, "tenths")).toBe("e");
    expect(compactLeadClass(13.0, "tenths")).toBe("th");
    expect(compactLeadClass(58.041, "thousandths")).toBe("f");
  });

  it("follows the rounding at its own precision: 59.96 is one minute (w) to the tenth, fifty nine (f) to the thousandth", () => {
    expect(compactLeadClass(59.96, "tenths")).toBe("w");
    expect(compactLeadClass(59.96, "thousandths")).toBe("f");
  });

  it("has no class for a minute past 99, which no word reads", () => {
    expect(compactLeadClass(6000.0, "tenths")).toBeNull();
    expect(compactLeadClass(5999.0, "tenths")).toBe("n");
  });
});
