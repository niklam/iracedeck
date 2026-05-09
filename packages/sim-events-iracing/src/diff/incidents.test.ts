import { IncidentFlags } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { classifyIncident } from "./incidents.js";

describe("classifyIncident", () => {
  it.each([
    [IncidentFlags.RepOutOfControl, "out-of-control"],
    [IncidentFlags.RepOffTrack, "off-track"],
    [IncidentFlags.RepContactWithWorld, "contact-world"],
    [IncidentFlags.RepCollisionWithWorld, "collision-world"],
    [IncidentFlags.RepContactWithCar, "contact-car"],
    [IncidentFlags.RepCollisionWithCar, "collision-car"],
  ])("maps report byte %i to %s", (input, expected) => {
    expect(classifyIncident(input)).toBe(expected);
  });

  it("returns null for RepNoReport", () => {
    expect(classifyIncident(IncidentFlags.RepNoReport)).toBeNull();
  });

  it("returns null for the Ongoing variants iRacing never emits", () => {
    expect(classifyIncident(IncidentFlags.RepOffTrackOngoing)).toBeNull();
    expect(classifyIncident(IncidentFlags.RepCollisionWithWorldOngoing)).toBeNull();
  });

  it("ignores the penalty byte when classifying the report byte", () => {
    // Report byte 0x02 (RepOffTrack) + Pen byte 0x0200 (PenOneX) — the report
    // mask must isolate the low byte cleanly so the penalty bits don't
    // perturb classification.
    const combined = IncidentFlags.RepOffTrack | IncidentFlags.PenOneX;
    expect(classifyIncident(combined)).toBe("off-track");
  });

  it("returns null for unknown high values to stay forward-compatible", () => {
    // Hypothetical future iRacing report code the bus doesn't know about.
    expect(classifyIncident(0x00ff)).toBeNull();
  });
});
