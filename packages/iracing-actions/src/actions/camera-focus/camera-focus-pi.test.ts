import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHANGE_CAMERA_GROUPS,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  normalizeGroupName,
} from "../camera-controls/camera-groups.js";

/**
 * The PI runs in a browser context and cannot import action code, so it keeps
 * hand copies of the camera-group lists (#958). A stale copy fails as a missing
 * checkbox or a dead dropdown entry rather than as a red test — these hold it.
 */
const template = readFileSync(fileURLToPath(new URL("./camera-focus.ejs", import.meta.url)), "utf-8");

/** The quoted strings of a `var NAME = [ … ];` array literal, comments stripped. */
function readStringArray(name: string): string[] {
  const match = template.match(new RegExp(`var ${name} = \\[([\\s\\S]*?)\\];`));

  if (!match) throw new Error(`var ${name} not found in camera-focus.ejs`);

  const body = match[1].replace(/\/\/[^\n]*/g, "");

  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function readGroupSections(): { heading: string; start: number; end: number }[] {
  const match = template.match(/var GROUP_SECTIONS = \[([\s\S]*?)\];/);

  if (!match) throw new Error("var GROUP_SECTIONS not found in camera-focus.ejs");

  return [...match[1].matchAll(/heading: "([^"]+)", start: (\d+), end: (\d+)/g)].map((m) => ({
    heading: m[1],
    start: Number(m[2]),
    end: Number(m[3]),
  }));
}

describe("camera-focus PI camera-group lists", () => {
  const allGroups = readStringArray("ALL_GROUPS");

  it("lists exactly the action's camera groups, each once", () => {
    expect(allGroups).toHaveLength(DEFAULT_CAMERA_GROUPS.length);
    expect(new Set(allGroups)).toEqual(new Set(DEFAULT_CAMERA_GROUPS));
  });

  it("enables the same groups by default as the action", () => {
    expect(readStringArray("DEFAULT_ENABLED")).toEqual(DEFAULT_ENABLED_GROUPS);
  });

  it("covers every listed group with exactly one contiguous section", () => {
    const sections = readGroupSections();

    expect(sections.map((s) => s.heading)).toEqual(["Car", "Chase", "Track", "Aerial"]);
    expect(sections[0].start).toBe(0);

    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].start).toBe(sections[i - 1].end);
    }

    expect(sections[sections.length - 1].end).toBe(allGroups.length);
  });

  it("puts the five groups added in #958 in the Track section", () => {
    const track = readGroupSections().find((s) => s.heading === "Track");
    const trackGroups = allGroups.slice(track?.start, track?.end);

    for (const name of ["TV Static", "TV Mixed", "TV4", "Spotter", "Spectator"]) {
      expect(trackGroups).toContain(name);
    }
  });

  // The dropdown's suspension labels spell the group out; every other label is the group name.
  const CHANGE_CAMERA_LABELS: Record<string, string> = {
    "Suspension - Left Front": "LF Susp",
    "Suspension - Right Front": "RF Susp",
    "Suspension - Left Rear": "LR Susp",
    "Suspension - Right Rear": "RR Susp",
  };

  function changeCameraOptions(): { value: number; label: string }[] {
    const select = template.match(/<sdpi-select setting="cameraGroup"[\s\S]*?<\/sdpi-select>/);

    if (!select) throw new Error("the cameraGroup select was not found in camera-focus.ejs");

    return [...select[0].matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map((m) => ({
      value: Number(m[1]),
      label: m[2],
    }));
  }

  it("offers every Change Camera value from 1 to the number of groups, each once", () => {
    const values = changeCameraOptions().map((o) => o.value);

    expect([...values].sort((a, b) => a - b)).toEqual(
      Array.from({ length: DEFAULT_CAMERA_GROUPS.length }, (_, i) => i + 1),
    );
  });

  it("labels every Change Camera value with the group the action switches to", () => {
    for (const { value, label } of changeCameraOptions()) {
      expect(CHANGE_CAMERA_LABELS[label] ?? label, `option ${value}`).toBe(CHANGE_CAMERA_GROUPS[value]);
    }
  });

  it("folds the same legacy group spellings as the action", () => {
    const match = template.match(/var LEGACY_NAMES = (\{[^}]*\});/);

    expect(match).not.toBeNull();

    const legacy = JSON.parse(match?.[1] ?? "{}") as Record<string, string>;

    expect(Object.keys(legacy).length).toBeGreaterThan(0);

    for (const [variant, canonical] of Object.entries(legacy)) {
      expect(normalizeGroupName(variant)).toBe(canonical);
    }
  });

  it("offers Icon Shows for Cycle Camera keys, defaulting to the next camera", () => {
    const section = template.match(/<div id="camera-groups-section"[\s\S]*?<\/div>/);

    expect(section?.[0]).toContain('<sdpi-select setting="cycleIconMode" default="next">');
    expect(section?.[0]).toContain('<option value="current">');
  });
});
