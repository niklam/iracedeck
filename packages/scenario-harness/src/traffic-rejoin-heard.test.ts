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
import { getEventBus } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-sdk";
import { GlobalSettingsSchema, isCalloutEnabled, setCalloutEnabled } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHeardRig } from "./heard-rig.test-util.js";

/** Racing under green with no flag shown, the caution shortcuts' resting `SessionFlags`. */
const RACING_NO_FLAG = Flags.Servicible | Flags.StartHidden;

const KEY = "calloutEnabledTrafficRejoin";

/** The opt-in as a user who never ticked it has it: the schema's default. */
const USER_DEFAULT = GlobalSettingsSchema.parse({})[KEY];

/** The bus-event buttons, each with the pool its line opens on. */
const BUTTONS = [
  { id: "traffic-rejoin-right-behind", opens: "traffic/rejoin-right-behind" },
  { id: "traffic-rejoin-near-first", opens: "traffic/rejoin-intro" },
  { id: "traffic-rejoin-near-update", opens: "traffic/rejoin-update" },
  { id: "traffic-rejoin-pack", opens: "traffic/rejoin-pack" },
] as const;

describe("what the rejoin traffic buttons are heard to say (issue #1113)", () => {
  const { boot, apply, publish, press, heard } = useHeardRig([]);

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

    expect(clips).toContain("traffic/rejoin-intro");
    expect(clips).toContain("traffic/rejoin-right-behind");
    expect(clips.every((clip) => clip.startsWith("traffic/rejoin-"))).toBe(true);
  });

  it("the towed button says nothing, and cuts the rejoin line it is pressed over (amended 2026-11-20)", () => {
    boot("race");
    press("traffic-rejoin-towed");

    expect(heard()).toEqual([]);

    // A first call, cut a third of the way into its first clip.
    publish("traffic.rejoin", { verdict: "near", seconds: 5, first: true });
    vi.advanceTimersByTime(100);
    press("traffic-rejoin-towed");

    expect(heard()).toEqual(["traffic/rejoin-intro"]);
  });

  it("the rejoin train hands the next button a live translator with the tick loop paused: that button's first edge is announced", () => {
    boot("race", { ticking: false });
    press("traffic-rejoin-train");

    const published: string[] = [];
    const unsubscribe = getEventBus().subscribe("flag.caution-waving.raised", (ev) => published.push(ev.event));

    try {
      // The next button's first step, ticked as a paused loop ticks it: a
      // caution thrown. Were the tick after the teardown's replay exit grace
      // still to come, it would re-seed on this patch and take the flag for
      // its baseline.
      apply([{ patch: { SessionFlags: RACING_NO_FLAG | Flags.CautionWaving }, tick: true, holdMs: 100 }]);
    } finally {
      unsubscribe();
    }

    expect(published).toEqual(["flag.caution-waving.raised"]);
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
