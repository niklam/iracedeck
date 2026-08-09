/**
 * Unit tests for the gap callout module (issue #933).
 *
 * Pins:
 *   - resolveGapCooldownMs: clamping + fallback
 *   - tryClaimGapCallout: shared cooldown claim semantics
 *   - Var resolvers: side/direction pool selection; the readout trio resolves
 *     all-or-nothing (never a partial "Gap is" without a number)
 *   - where: gating — race-finished latch, overtake gate, cooldown as the
 *     LAST gate
 */
import type { SimEventOf } from "@iracedeck/event-bus";
import type { LiveGaps } from "@iracedeck/sim-events-iracing";
import { afterEach, describe, expect, it } from "vitest";

import type { Scenario } from "../../dsl.js";
import {
  _resetGapCalloutCooldown,
  _setLastGapEvent,
  buildGapThresholdScenario,
  buildGapTrendScenario,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  GAP_CALLOUT_SETTING_KEYS,
  registerGapVars,
  resolveGapCooldownMs,
  SCENARIO_ID_TO_GAP_ID,
  tryClaimGapCallout,
} from "./gaps.js";
import { PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";

afterEach(() => {
  _resetGapCalloutCooldown();
  _setLastGapEvent(null);
});

/** Capture var resolvers via a minimal engine stub. */
function captureVars(getLiveGaps: () => LiveGaps | null): Map<string, () => string | null> {
  const vars = new Map<string, () => string | null>();

  registerGapVars(
    { defineVar: (name: string, resolver: () => string | null) => vars.set(name, resolver) } as never,
    getLiveGaps,
  );

  return vars;
}

function liveGaps(aheadGap: number | null, behindGap: number | null): LiveGaps {
  return {
    ahead: aheadGap === null ? null : { carIdx: 3, gapSeconds: aheadGap, lapDelta: 0, trend: null },
    behind: behindGap === null ? null : { carIdx: 5, gapSeconds: behindGap, lapDelta: 0, trend: null },
  };
}

function trendEvent(side: "ahead" | "behind", direction: "closing" | "opening"): SimEventOf<"gap.trendChanged"> {
  return {
    event: "gap.trendChanged",
    timestamp: 0,
    telemetry: {},
    data: { side, direction, gapSeconds: 1.8, ratePerLap: direction === "closing" ? -0.8 : 0.8, carIdx: 3 },
  };
}

function thresholdEvent(side: "ahead" | "behind"): SimEventOf<"gap.thresholdCrossed"> {
  return {
    event: "gap.thresholdCrossed",
    timestamp: 0,
    telemetry: {},
    data: { side, gapSeconds: 0.9, thresholdSeconds: 1.0, carIdx: 3 },
  };
}

function whereOf(s: Scenario): (ev: SimEventOf<never>) => boolean {
  return s.when!.where! as never;
}

describe("resolveGapCooldownMs", () => {
  it("converts seconds to ms and clamps to 1–360 s", () => {
    expect(resolveGapCooldownMs(30)).toBe(30_000);
    expect(resolveGapCooldownMs("45")).toBe(45_000);
    expect(resolveGapCooldownMs(0)).toBe(1_000);
    expect(resolveGapCooldownMs(9999)).toBe(360_000);
  });

  it("falls back to the default on malformed input", () => {
    expect(resolveGapCooldownMs("junk")).toBe(GAP_CALLOUT_DEFAULT_COOLDOWN_MS);
    expect(resolveGapCooldownMs(undefined)).toBe(GAP_CALLOUT_DEFAULT_COOLDOWN_MS);
  });

  it("treats a cleared field as missing, not as a 1 s cooldown", () => {
    // `Number("")` and `Number(null)` are a finite 0, which the clamp would
    // turn into the 1 s minimum — a gap callout every second.
    expect(resolveGapCooldownMs("")).toBe(GAP_CALLOUT_DEFAULT_COOLDOWN_MS);
    expect(resolveGapCooldownMs(null)).toBe(GAP_CALLOUT_DEFAULT_COOLDOWN_MS);
  });
});

describe("tryClaimGapCallout", () => {
  it("claims once per cooldown window", () => {
    expect(tryClaimGapCallout(1000, 30_000)).toBe(true);
    expect(tryClaimGapCallout(15_000, 30_000)).toBe(false);
    expect(tryClaimGapCallout(31_500, 30_000)).toBe(true);
  });
});

describe("gap var resolvers", () => {
  it("selects the trend line pool by side + direction", () => {
    const vars = captureVars(() => null);

    _setLastGapEvent({ side: "ahead", direction: "closing", carIdx: 3 });
    expect(vars.get("gap.line")!()).toBe("pool:gap/ahead-closing");

    _setLastGapEvent({ side: "behind", direction: "opening", carIdx: 5 });
    expect(vars.get("gap.line")!()).toBe("pool:gap/behind-opening");
    expect(vars.get("gap.thresholdLine")!()).toBe("pool:gap/threshold-behind");
  });

  it("resolves the readout trio from the live gap (1.55 s → 'one' + 'point six')", () => {
    const vars = captureVars(() => liveGaps(1.55, null));

    _setLastGapEvent({ side: "ahead", direction: "closing", carIdx: 3 });
    expect(vars.get("gap.readoutIntro")!()).toBe("pool:gap/readout-intro");
    expect(vars.get("gap.second")!()).toBe("pool:lap-time-second/1");
    expect(vars.get("gap.decimal")!()).toBe("pool:lap-time-decimal/6");
  });

  it("resolves the whole trio to null when the gap is unavailable or ≥ 60 s", () => {
    for (const gaps of [null, liveGaps(null, null), liveGaps(61.2, null)]) {
      const vars = captureVars(() => gaps);

      _setLastGapEvent({ side: "ahead", direction: "closing", carIdx: 3 });
      expect(vars.get("gap.readoutIntro")!()).toBeNull();
      expect(vars.get("gap.second")!()).toBeNull();
      expect(vars.get("gap.decimal")!()).toBeNull();
    }
  });

  it("skips the readout when the neighbor changed between claim and speak time", () => {
    // Queued "we've caught the car ahead" (car 3) drains after the pass —
    // the live ahead neighbor is now a different car, 6.4 s up the road.
    const vars = captureVars(() => ({
      ahead: { carIdx: 7, gapSeconds: 6.4, lapDelta: 0, trend: null },
      behind: null,
    }));

    _setLastGapEvent({ side: "ahead", direction: "closing", carIdx: 3 });
    expect(vars.get("gap.readoutIntro")!()).toBeNull();
    expect(vars.get("gap.second")!()).toBeNull();
    expect(vars.get("gap.decimal")!()).toBeNull();
    // The line itself still plays — only the number clause is dropped.
    expect(vars.get("gap.line")!()).toBe("pool:gap/ahead-closing");
  });
});

describe("gap scenario gating", () => {
  it("fires the trend scenario through the permissive gate and claims the cooldown", () => {
    const s = buildGapTrendScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(s)(trendEvent("ahead", "closing") as never)).toBe(true);
    // Second event inside the shared cooldown — suppressed.
    expect(whereOf(s)(trendEvent("behind", "opening") as never)).toBe(false);
  });

  it("shares the cooldown across trend and threshold scenarios", () => {
    const trend = buildGapTrendScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );
    const threshold = buildGapThresholdScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(threshold)(thresholdEvent("ahead") as never)).toBe(true);
    expect(whereOf(trend)(trendEvent("ahead", "closing") as never)).toBe(false);
  });

  it("suppresses on the race-finished latch and on a failing overtake gate without claiming", () => {
    const finished = buildGapTrendScenario(
      () => true,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(finished)(trendEvent("ahead", "closing") as never)).toBe(false);

    const gated = buildGapThresholdScenario(
      () => false,
      () => null, // telemetry unavailable → suppress
      () => 30_000,
    );

    expect(whereOf(gated)(thresholdEvent("behind") as never)).toBe(false);

    // Neither suppression claimed the cooldown — a clean fire still passes.
    const clean = buildGapTrendScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(clean)(trendEvent("ahead", "closing") as never)).toBe(true);
  });

  it("does not let a suppressed event overwrite the accepted event's stash", () => {
    // #922 convention: both scenarios are queueable, and a deferred fire
    // re-resolves its vars at drain time without re-running `where:`. An
    // event rejected by the shared cooldown must leave the stash alone.
    const vars = captureVars(() => null);
    const trend = buildGapTrendScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );
    const threshold = buildGapThresholdScenario(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(trend)(trendEvent("ahead", "closing") as never)).toBe(true);
    // Rejected on the shared cooldown — and on the race-finished latch.
    expect(whereOf(threshold)(thresholdEvent("behind") as never)).toBe(false);
    expect(
      whereOf(
        buildGapThresholdScenario(
          () => true,
          () => PERMISSIVE_OVERTAKE_GATE,
          () => 0,
        ),
      )(thresholdEvent("behind") as never),
    ).toBe(false);

    // The queued fire still speaks the accepted event's side + direction.
    expect(vars.get("gap.line")!()).toBe("pool:gap/ahead-closing");
  });
});

describe("catalog wiring", () => {
  it("maps every scenario id to a callout id with a schema setting key", () => {
    expect(SCENARIO_ID_TO_GAP_ID["pit-crew.gap-trend"]).toBe("trend");
    expect(SCENARIO_ID_TO_GAP_ID["pit-crew.gap-threshold"]).toBe("threshold");
    expect(GAP_CALLOUT_SETTING_KEYS.trend).toBe("calloutEnabledGapTrend");
    expect(GAP_CALLOUT_SETTING_KEYS.threshold).toBe("calloutEnabledGapThreshold");
  });
});
