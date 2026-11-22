/**
 * The caution sequence's position call, HEARD, on track and on pit road
 * (issue #1722).
 *
 * "Flags → Caution → restart" drives the translator through a caution whose
 * last lap carries the position call ("We're currently seven"). That call
 * says the race position, so like every position readout it is silent on pit
 * road and out of the car — asked at the checkpoint and again at speak time,
 * reading the translator's latest tick. The button's description asks for
 * the hot-lap telemetry preset first, which has the car on track; this pins
 * that the call is heard there and not with the car on pit road.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type ClipDurations, useHeardRig } from "./heard-rig.test-util.js";

const TELEMETRY_PRESETS = join(dirname(fileURLToPath(import.meta.url)), "..", "presets", "telemetry");

/** A telemetry preset applied the way the UI applies one: one patch, ticked. */
function preset(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TELEMETRY_PRESETS, `${name}.json`), "utf8")) as Record<string, unknown>;
}

/** Lines are held briefly, so the run's calls never queue past the listen. */
const CLIP_MS: ClipDurations = [[/./, 600]];

/** The position call's two clips: "We're currently" and the player's race position. */
const POSITION_CALL = ["position-intro-worse/currently", "position-number/7"];

/** Whether `clips` holds `run` in order, back to back. */
function containsRun(clips: readonly string[], run: readonly string[]): boolean {
  return clips.some((_, i) => run.every((clip, j) => clips[i + j] === clip));
}

describe('the position call in "Caution → restart" (issue #1722)', () => {
  const { boot, apply, press, heard } = useHeardRig(CLIP_MS);

  it("is heard with the hot-lap preset the button asks for — the car on track", () => {
    boot("race-oval");
    apply([{ patch: preset("hot-lap"), tick: true }]);
    press("flag-caution-restart");

    expect(containsRun(heard(), POSITION_CALL)).toBe(true);
  });

  it("is silent with the car on pit road, while the rest of the caution is still heard", () => {
    boot("race-oval");
    apply([{ patch: preset("on-pit-road"), tick: true }]);
    press("flag-caution-restart");

    const clips = heard();

    expect(clips.some((clip) => clip.startsWith("caution/"))).toBe(true);
    expect(clips).not.toContain("position-number/7");
  });
});
