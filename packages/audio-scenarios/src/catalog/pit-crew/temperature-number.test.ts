import { describe, expect, it } from "vitest";

import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import {
  TEMPERATURE_NUMBER_GROUP,
  TEMPERATURE_UNIT_DESCRIPTION,
  temperatureClipName,
  temperatureNumberDescription,
  temperatureNumberRef,
  temperatureUnitRef,
} from "./temperature-number.js";

describe("temperature figures (issue #1187)", () => {
  it("draws every figure from the numbers-degrees group", () => {
    expect(TEMPERATURE_NUMBER_GROUP).toBe("numbers-degrees");
    expect(temperatureNumberRef(28)).toBe("pool:numbers-degrees/28");
  });

  it("names zero and above by the number itself", () => {
    expect(temperatureClipName(0)).toBe("0");
    expect(temperatureClipName(80)).toBe("80");
    expect(temperatureClipName(176)).toBe("176");
  });

  it("spells a below-zero reading as minus<N>, never a leading hyphen", () => {
    expect(temperatureClipName(-1)).toBe("minus1");
    expect(temperatureClipName(-4)).toBe("minus4");
    expect(temperatureClipName(-20)).toBe("minus20");
    expect(temperatureNumberRef(-4)).toBe("pool:numbers-degrees/minus4");
  });

  it("does not choose a group by unit: a Fahrenheit reading is the same clip name", () => {
    expect(temperatureNumberRef(150)).toBe("pool:numbers-degrees/150");
  });

  it.each(["track", "air"] as const)("names the group in a form lint:pack reads (%s)", (what) => {
    const description = temperatureNumberDescription(what);

    expect(descriptionNamesGroup(description, "numbers-degrees")).toBe(true);
    expect(descriptionNamesGroup(description, "session-start-temp-numbers")).toBe(false);
    expect(description).toContain("-20 to 176");
  });

  it("points the optional unit word at unit-only clips, never the retired degrees-* names", () => {
    expect(temperatureUnitRef("celsius")).toBe("pool:session-start/unit-celsius");
    expect(temperatureUnitRef("fahrenheit")).toBe("pool:session-start/unit-fahrenheit");
  });

  it("describes the unit word as optional, naming both clips and not the figure group", () => {
    expect(TEMPERATURE_UNIT_DESCRIPTION).toContain("session-start/unit-celsius");
    expect(TEMPERATURE_UNIT_DESCRIPTION).toContain("session-start/unit-fahrenheit");
    expect(descriptionNamesGroup(TEMPERATURE_UNIT_DESCRIPTION, "session-start")).toBe(true);
    expect(descriptionNamesGroup(TEMPERATURE_UNIT_DESCRIPTION, "numbers-degrees")).toBe(false);
  });
});
