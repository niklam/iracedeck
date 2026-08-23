import { describe, expect, it } from "vitest";

import { DEVICE_SPECS, DEVICE_SUPPORT } from "../packages/deck-core/src/device-profiles.ts";
import { ECOSYSTEMS } from "../packages/website/src/data/brands.ts";

/**
 * The website's Elgato device list vs. the canonical support matrix (#983).
 *
 * `DEVICE_SUPPORT` in deck-core decides which devices iRaceDeck actually runs
 * on; `ECOSYSTEMS.elgato.devices` is the single string the download card and
 * the installation guide both render. Nothing connected the two, and they had
 * drifted: Neo, Studio, + XL, Galleon 100 SD, Stream Deck Mobile and the
 * Virtual Stream Deck were all supported and none of them was named, so their
 * owners read that iRaceDeck did not cover their device.
 *
 * Both directions matter. A supported device missing from the prose costs us a
 * user who owns one; an unsupported device named in it is a promise the plugin
 * cannot keep.
 */
/**
 * The prose list split back into exact device names.
 *
 * Substring matching would leave holes precisely where they hurt: "Stream Deck"
 * occurs inside every other name, and "Stream Deck +" inside "Stream Deck + XL",
 * so dropping either of those two from the prose would still satisfy a
 * `toContain` on the raw string. Comparing parsed entries makes each assertion
 * exact. The leading article is stripped here rather than dropped from the copy,
 * so the sentence can still read "…, and the Virtual Stream Deck".
 */
const namedDevices = ECOSYSTEMS.elgato.devices
  .split(",")
  .map((entry) => entry.trim().replace(/^and\s+/i, "").replace(/^the\s+/i, ""))
  .filter(Boolean);

/** `[name, controls]` for every entry in the matrix, e.g. `["Stream Deck Neo", "keys"]`. */
const devices = Object.entries(DEVICE_SUPPORT).map(([type, support]) => [
  DEVICE_SPECS[Number(type)].name,
  support.controls,
]);

const supported = devices.filter(([, controls]) => controls !== "unsupported");
const unsupported = devices.filter(([, controls]) => controls === "unsupported");

/**
 * Supported devices deliberately left out of the public prose. Empty since
 * #983 — every supported device is named, including the two software surfaces.
 * Add a name here (with the reason) rather than deleting the assertion.
 */
const DELIBERATELY_UNNAMED = [];

describe("website Elgato device list (#983)", () => {
  it("reads both sides at all", () => {
    // Guards the parsing itself: an empty list on either side would make every
    // assertion below pass vacuously.
    expect(supported.length).toBeGreaterThan(5);
    expect(unsupported.length).toBeGreaterThan(0);
    expect(namedDevices.length).toBe(supported.length - DELIBERATELY_UNNAMED.length);
  });

  it.each(supported.filter(([name]) => !DELIBERATELY_UNNAMED.includes(name)))(
    "names %s, which iRaceDeck supports (%s)",
    (name) => {
      expect(namedDevices).toContain(name);
    },
  );

  it.each(unsupported)("does not claim %s, which is unsupported (%s)", (name) => {
    expect(namedDevices).not.toContain(name);
  });

  it("keeps every deliberately unnamed device out of the prose", () => {
    // Otherwise the allow-list quietly becomes a list of things that ARE named.
    for (const name of DELIBERATELY_UNNAMED) {
      expect(namedDevices).not.toContain(name);
    }
  });

  it("names nothing the matrix has never heard of", () => {
    // The other direction of the same drift: a device renamed in deck-core
    // leaves its old name stranded in the prose, where nothing else would
    // catch it.
    const known = devices.map(([name]) => name);

    expect(namedDevices.filter((name) => !known.includes(name))).toEqual([]);
  });
});
