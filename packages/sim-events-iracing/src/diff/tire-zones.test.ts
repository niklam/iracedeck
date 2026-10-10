/**
 * Unit tests for the tread zone mapping the tire families share (issues
 * #1108, #254).
 */
import { describe, expect, it } from "vitest";

import { zonesFromCarSides } from "./tire-zones.js";

describe("zonesFromCarSides", () => {
  it("names the sim's L the outside and R the inside on a left-side tire", () => {
    expect(zonesFromCarSides("left", 1, 2, 3)).toEqual({ outside: 1, middle: 2, inside: 3 });
  });

  it("names the sim's L the inside and R the outside on a right-side tire", () => {
    expect(zonesFromCarSides("right", 1, 2, 3)).toEqual({ inside: 1, middle: 2, outside: 3 });
  });
});
