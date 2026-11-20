/**
 * What the rejoin traffic buttons (issue #1113) are HEARD to say, and why.
 *
 * The rejoin warnings ship experimental and off by default (Niklas,
 * 2026-11-20; the #1113 spec's amendment of that date), so a user hears none
 * of them until they tick **Traffic when rejoining (experimental)**. The
 * harness seeds the opt-in on (`bootstrap-settings.ts`), as it does the two
 * pit-lane beeps, so its rejoin buttons are heard on a freshly booted
 * harness; the Global Settings panel's checkbox turns them off. This file
 * presses each button on the harness's whole stack (`heard-rig.test-util.ts`)
 * with the opt-in as the harness seeds it, then with it at the schema's
 * default, which is what a user who never ticked it has.
 */
import { GlobalSettingsSchema, isCalloutEnabled, setCalloutEnabled } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useHeardRig } from "./heard-rig.test-util.js";

const KEY = "calloutEnabledTrafficRejoin";

/** The opt-in as a user who never ticked it has it: the schema's default. */
const USER_DEFAULT = GlobalSettingsSchema.parse({})[KEY];

/** The bus-event buttons, each with the pool its line opens on. */
const BUTTONS = [
  { id: "traffic-rejoin-right-behind", opens: "traffic/rejoin-right-behind" },
  { id: "traffic-rejoin-near-first", opens: "traffic/rejoin-intro" },
  { id: "traffic-rejoin-near-update", opens: "traffic/rejoin-update" },
  { id: "traffic-rejoin-over-ten", opens: "traffic/rejoin-over-ten" },
  { id: "traffic-rejoin-clear", opens: "traffic/rejoin-clear" },
  { id: "traffic-rejoin-pack", opens: "traffic/rejoin-pack" },
] as const;

describe("what the rejoin traffic buttons are heard to say (issue #1113)", () => {
  const { boot, press, heard } = useHeardRig([]);

  let seeded: boolean;

  beforeEach(() => {
    seeded = isCalloutEnabled(KEY);
  });

  afterEach(() => {
    // Back to what the harness seeded, whatever a test switched, so no test
    // hears a button only because an earlier one turned the opt-in on.
    setCalloutEnabled(KEY, seeded);
  });

  it("ships the opt-in off for users, and the harness seeds it on", () => {
    expect(USER_DEFAULT).toBe(false);
    expect(isCalloutEnabled(KEY)).toBe(true);
  });

  it.each(BUTTONS)("$id speaks its line with the opt-in as the harness seeds it", ({ id, opens }) => {
    boot("race");
    press(id);

    expect(heard()[0]).toBe(opens);
  });

  it("the rejoin train through the translator is heard, every line a rejoin line", () => {
    boot("race");
    press("traffic-rejoin-train");

    const clips = heard();

    expect(clips).toContain("traffic/rejoin-clear");
    expect(clips).toContain("traffic/rejoin-right-behind");
    expect(clips.every((clip) => clip.startsWith("traffic/rejoin-"))).toBe(true);
  });

  it.each(BUTTONS)("$id is silent with the opt-in at its default, as a user has it", ({ id }) => {
    boot("race");
    setCalloutEnabled(KEY, USER_DEFAULT);
    press(id);

    expect(heard()).toEqual([]);
  });

  it("the rejoin train is silent with the opt-in at its default", () => {
    boot("race");
    setCalloutEnabled(KEY, USER_DEFAULT);
    press("traffic-rejoin-train");

    expect(heard()).toEqual([]);
  });
});
