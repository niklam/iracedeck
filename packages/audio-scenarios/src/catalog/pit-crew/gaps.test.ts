/**
 * Gap callout tests (issue #933; scripted since #1065).
 *
 * Pins:
 *   - resolveGapCooldownMs: clamping + fallback
 *   - tryClaimGapCallout: shared cooldown claim semantics
 *   - Var resolvers: side/direction pool selection; the readout trio resolves
 *     all-or-nothing (never a partial "Gap is" without a number)
 *   - where: gating — race-finished latch, overtake gate, cooldown as the
 *     LAST gate
 *   - The bundled script through the real engine: the line, then the
 *     `gap-readout` fragment both entries share, inlined at compile time
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { LiveGaps } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  _resetGapCalloutCooldown,
  _setLastGapEvent,
  buildGapThresholdContract,
  buildGapTrendContract,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  GAP_CALLOUT_SETTING_KEYS,
  GAP_CLIP_SOURCES,
  GAP_SCENARIO_IDS,
  registerGapVocabulary,
  resolveGapCooldownMs,
  SCENARIO_ID_TO_GAP_ID,
  tryClaimGapCallout,
} from "./gaps.js";
import { PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & {
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) => void;
} {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
    },
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: {},
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
      callbacks[channel] = null;
    }),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks[channel] = cb;
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks[channel];
      callbacks[channel] = null;
      cb?.();
    },
    _played: played,
  } as unknown as FakeAudio;
}

function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** The gap lines (one take each) plus the number groups the readout reuses. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GAP_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    ...Array.from({ length: 60 }, (_, i) => `voice/${VOICE}/lap-time-second/${i}.mp3`),
    ...Array.from({ length: 10 }, (_, i) => `voice/${VOICE}/lap-time-decimal/${i}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's entries AND the one fragment
 * they include (F7-trap i): `collectScriptReferences` walks every fragment it
 * is given, so another family's fragment would widen the reference set.
 */
const GAP_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(GAP_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: { "gap-readout": SCRIPT.fragments!["gap-readout"] },
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

afterEach(() => {
  _resetGapCalloutCooldown();
  _setLastGapEvent(null);
});

/** Capture var resolvers via a minimal engine stub. */
function captureVars(getLiveGaps: () => LiveGaps | null): Map<string, () => string | null> {
  const vars = new Map<string, () => string | null>();

  registerGapVocabulary(
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

function whereOf(c: ScenarioContract): (ev: SimEventOf<never>) => boolean {
  return c.when!.where! as never;
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

describe("gap contract gating", () => {
  it("fires the trend contract through the permissive gate and claims the cooldown", () => {
    const c = buildGapTrendContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(c)(trendEvent("ahead", "closing") as never)).toBe(true);
    // Second event inside the shared cooldown — suppressed.
    expect(whereOf(c)(trendEvent("behind", "opening") as never)).toBe(false);
  });

  it("shares the cooldown across trend and threshold contracts", () => {
    const trend = buildGapTrendContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );
    const threshold = buildGapThresholdContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(threshold)(thresholdEvent("ahead") as never)).toBe(true);
    expect(whereOf(trend)(trendEvent("ahead", "closing") as never)).toBe(false);
  });

  it("suppresses on the race-finished latch and on a failing overtake gate without claiming", () => {
    const finished = buildGapTrendContract(
      () => true,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(finished)(trendEvent("ahead", "closing") as never)).toBe(false);

    const gated = buildGapThresholdContract(
      () => false,
      () => null, // telemetry unavailable → suppress
      () => 30_000,
    );

    expect(whereOf(gated)(thresholdEvent("behind") as never)).toBe(false);

    // Neither suppression claimed the cooldown — a clean fire still passes.
    const clean = buildGapTrendContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(clean)(trendEvent("ahead", "closing") as never)).toBe(true);
  });

  it("does not let a suppressed event overwrite the accepted event's stash", () => {
    // #922 convention: both contracts are queueable, and a deferred fire
    // re-resolves its vars at drain time without re-running `where:`. An
    // event rejected by the shared cooldown must leave the stash alone.
    const vars = captureVars(() => null);
    const trend = buildGapTrendContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );
    const threshold = buildGapThresholdContract(
      () => false,
      () => PERMISSIVE_OVERTAKE_GATE,
      () => 30_000,
    );

    expect(whereOf(trend)(trendEvent("ahead", "closing") as never)).toBe(true);
    // Rejected on the shared cooldown — and on the race-finished latch.
    expect(whereOf(threshold)(thresholdEvent("behind") as never)).toBe(false);
    expect(
      whereOf(
        buildGapThresholdContract(
          () => true,
          () => PERMISSIVE_OVERTAKE_GATE,
          () => 0,
        ),
      )(thresholdEvent("behind") as never),
    ).toBe(false);

    // The queued fire still speaks the accepted event's side + direction.
    expect(vars.get("gap.line")!()).toBe("pool:gap/ahead-closing");
  });

  it("keeps every scheduling field verbatim and carries no sequence — what is said is the voice script's", () => {
    const trend = buildGapTrendContract();
    const threshold = buildGapThresholdContract();

    expect(trend.id).toBe("pit-crew.gap-trend");
    expect(trend.when?.event).toBe("gap.trendChanged");
    expect(trend.weight).toBe(WEIGHT.CHATTER);
    expect(threshold.id).toBe("pit-crew.gap-threshold");
    expect(threshold.when?.event).toBe("gap.thresholdCrossed");
    expect(threshold.weight).toBe(WEIGHT.NORMAL);

    for (const c of [trend, threshold]) {
      expect("sequence" in c).toBe(false);
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.queueable).toBe(true);
      expect(c.family).toBe("gap");
      expect(c.frame).toBeUndefined();
    }
  });
});

describe("the gap lines through the real script", () => {
  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let engine: IScenarioEngine;
  let currentGaps: LiveGaps | null;

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  beforeEach(() => {
    currentGaps = null;
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    // The production order (`registerPitCrew`): vocabulary, contracts, script.
    registerGapVocabulary(engine, () => currentGaps);
    engine.defineContract(
      buildGapTrendContract(
        () => false,
        () => PERMISSIVE_OVERTAKE_GATE,
        () => 30_000,
      ),
    );
    engine.defineContract(
      buildGapThresholdContract(
        () => false,
        () => PERMISSIVE_OVERTAKE_GATE,
        () => 30_000,
      ),
    );
    engine.setScripts(new Map([[VOICE, GAP_SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it("a trend flip plays the side/direction line and the live readout — 'Gap is' + 'one' + 'point six'", () => {
    currentGaps = liveGaps(1.55, null);
    bus.publishEvent("gap.trendChanged", trendEvent("ahead", "closing").data);
    flush(audio);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/gap/ahead-closing-01.mp3`,
      `voice/${VOICE}/gap/readout-intro-01.mp3`,
      `voice/${VOICE}/lap-time-second/1.mp3`,
      `voice/${VOICE}/lap-time-decimal/6.mp3`,
    ]);
  });

  it("a threshold crossing plays the side's threshold line and the same readout — the fragment is inlined into both entries", () => {
    currentGaps = liveGaps(null, 0.9);
    bus.publishEvent("gap.thresholdCrossed", { ...thresholdEvent("behind").data, carIdx: 5 });
    flush(audio);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/gap/threshold-behind-01.mp3`,
      `voice/${VOICE}/gap/readout-intro-01.mp3`,
      `voice/${VOICE}/lap-time-second/0.mp3`,
      `voice/${VOICE}/lap-time-decimal/9.mp3`,
    ]);
  });

  it("drops the whole readout clause and keeps the line when the gap is not readable — never 'Gap is' alone", () => {
    currentGaps = null;
    bus.publishEvent("gap.trendChanged", trendEvent("behind", "opening").data);
    flush(audio);

    expect(voicePaths()).toEqual([`voice/${VOICE}/gap/behind-opening-01.mp3`]);
  });

  it("plays inside the radio frame", () => {
    bus.publishEvent("gap.trendChanged", trendEvent("ahead", "opening").data);
    flush(audio);

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(voicePaths()).toEqual([`voice/${VOICE}/gap/ahead-opening-01.mp3`]);
  });

  it("publishes the five vars with descriptions naming their groups, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const gapVars = vars.filter((v) => v.name.startsWith("gap."));

    expect(gapVars.map((v) => v.name)).toEqual([
      "gap.decimal",
      "gap.line",
      "gap.readoutIntro",
      "gap.second",
      "gap.thresholdLine",
    ]);
    expect(gapVars.find((v) => v.name === "gap.second")?.description).toContain("lap-time-second");
    expect(gapVars.find((v) => v.name === "gap.decimal")?.description).toContain("lap-time-decimal");

    for (const v of gapVars) expect(v.description.length, v.name).toBeGreaterThan(0);

    expect(conds.filter((c) => c.name.startsWith("gap."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("gap."))).toEqual([]);
  });

  it("compiles for the test voice with nothing skipped — the fragment resolves within the script", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("the bundled script's gap entries (issue #1065)", () => {
  it("scripts both contracts with a comment, a Gaps harness route and a sequence", () => {
    for (const id of GAP_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Gaps → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("both entries speak their line var then include the gap-readout fragment, defined once with a comment as ONE optional clause", () => {
    expect(SCRIPT.scenarios["pit-crew.gap-trend"].sequence).toEqual(["{{gap.line}}", "@gap-readout"]);
    expect(SCRIPT.scenarios["pit-crew.gap-threshold"].sequence).toEqual(["{{gap.thresholdLine}}", "@gap-readout"]);

    const fragment = SCRIPT.fragments?.["gap-readout"];

    expect(fragment?.comment?.length ?? 0).toBeGreaterThan(0);
    expect(fragment?.sequence).toEqual([
      { optional: ["{{gap.readoutIntro}}", "{{gap.second}}", "{{gap.decimal}}"] },
    ]);
  });

  it("references only the vars this family registers, the one fragment, and no pool by name — every clip reaches the script through a var", () => {
    const refs = collectScriptReferences(GAP_SCRIPT);

    expect(refs.vars).toEqual(["gap.decimal", "gap.line", "gap.readoutIntro", "gap.second", "gap.thresholdLine"]);
    expect(refs.pools).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual(["gap-readout"]);
    expect(refs.fragments).toEqual(["gap-readout"]);
    expect(refs.frames).toEqual([]);
  });

  it("the published clip sources are the gap group's seven bases, and every one has a clip in the bundled voice", () => {
    expect(GAP_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual([
      "gap/ahead-closing",
      "gap/ahead-opening",
      "gap/behind-closing",
      "gap/behind-opening",
      "gap/readout-intro",
      "gap/threshold-ahead",
      "gap/threshold-behind",
    ]);

    for (const { group, base } of GAP_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });
});

describe("catalog wiring", () => {
  it("maps every contract id to a callout id with a schema setting key", () => {
    expect(SCENARIO_ID_TO_GAP_ID["pit-crew.gap-trend"]).toBe("trend");
    expect(SCENARIO_ID_TO_GAP_ID["pit-crew.gap-threshold"]).toBe("threshold");
    expect(GAP_CALLOUT_SETTING_KEYS.trend).toBe("calloutEnabledGapTrend");
    expect(GAP_CALLOUT_SETTING_KEYS.threshold).toBe("calloutEnabledGapThreshold");
  });
});
