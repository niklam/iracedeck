import { describe, expect, it } from "vitest";

import { SPOTTER_BINDING_KEYS, SPOTTER_CONTROLS } from "./spotter-bindings.js";

describe("spotter-bindings", () => {
  it("lists every spotter control in the AI Spotter Controls order", () => {
    expect(SPOTTER_CONTROLS).toEqual([
      "damage-report",
      "weather-report",
      "toggle-report-laps",
      "announce-leader",
      "louder",
      "quieter",
      "silence",
    ]);
  });

  it("maps every control to its global-settings binding key", () => {
    expect(SPOTTER_BINDING_KEYS).toEqual({
      "damage-report": "spotterDamageReport",
      "weather-report": "spotterWeatherReport",
      "toggle-report-laps": "spotterToggleReportLaps",
      "announce-leader": "spotterAnnounceLeader",
      louder: "spotterLouder",
      quieter: "spotterQuieter",
      silence: "spotterSilence",
    });
  });
});
