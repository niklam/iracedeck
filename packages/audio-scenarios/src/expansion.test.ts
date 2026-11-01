/**
 * Expansion with no scheduler (issue #1514): the real pool store, vocabulary,
 * contract registry and script set under `Expansion`, driven through
 * `prepare` and `prepareFrame` alone — no bus, no gate, no `IAudioService`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContractRegistry } from "./contract-registry.js";
import { resolveStep, type Scenario, type ScenarioContract } from "./dsl.js";
import type { CompiledScenario, ExecOp } from "./engine-types.js";
import { Expansion } from "./expansion.js";
import type { FrameOptions } from "./interpreter.js";
import type { AudioAssetsManifest } from "./manifest.js";
import { OnceWarnings } from "./once-warnings.js";
import { PoolStore } from "./pool-store.js";
import { ScriptSet } from "./script-set.js";
import { Vocabulary } from "./vocabulary.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const logger: ILogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const TICK_OPEN = "sfx/tick-open.mp3";
const TICK_CLOSE = "sfx/tick-close.mp3";

const manifest: AudioAssetsManifest = {
  clips: [
    TICK_OPEN,
    TICK_CLOSE,
    "voice/v1/flags/blue-01.mp3",
    "voice/v1/flags/blue-02.mp3",
    "voice/v1/radio/never-mind-01.mp3",
    "voice/v1/radio/never-mind-02.mp3",
    "voice/v1/greet/hi-01.mp3",
    "static/a.mp3",
  ],
  ambientLoop: "sfx/ambient.mp3",
  ticks: { open: TICK_OPEN, close: TICK_CLOSE },
};

const ID = "pit-crew.flag-blue";

const BLUE: ScenarioContract = { id: ID, channel: AudioChannel.Voice, bus: AudioBus.Voice, base: "voice/{voice}" };

/** The same contract, with an event that can end it — the one case the cut tail is expanded for. */
const BLUE_ENDED: ScenarioContract = { ...BLUE, endsOn: { event: "pitLane.exited", description: "the exit" } };

const RADIO = {
  open: [TICK_OPEN, { ambient: "start" as const }],
  close: [{ ambient: "stop" as const }, TICK_CLOSE],
};

/** A script with the radio frame (its `cut` a spoken pool take), the blue-flag entry and two pools. */
function script(overrides: Partial<CalloutScript> = {}): CalloutScript {
  return {
    schema: 1,
    scenarios: { [ID]: { sequence: ["pool:flag-blue"] } },
    frames: { radio: { ...RADIO, cut: ["pool:never-mind", TICK_CLOSE] } },
    pools: {
      "flag-blue": { group: "flags", base: "blue" },
      "never-mind": { group: "radio", base: "never-mind" },
    },
    ...overrides,
  };
}

const play = (channel: AudioChannel, path: string, extra: Partial<Extract<ExecOp, { kind: "play" }>> = {}): ExecOp => ({
  kind: "play",
  channel,
  path,
  ...extra,
});

/** Pin `Math.random` so a pick is the index `floor(value * clips.length)` before the no-repeat guard. */
const randomAt = (value: number): void => {
  vi.spyOn(Math, "random").mockReturnValue(value);
};

let voice: string | null;
let frameOptions: FrameOptions;
let warnings: OnceWarnings;
let registry: ContractRegistry;
let vocab: Vocabulary;
let pools: PoolStore;
let scripts: ScriptSet;
let expansion: Expansion;

beforeEach(() => {
  vi.clearAllMocks();
  voice = "v1";
  frameOptions = { beeps: true, ambience: true };
  warnings = new OnceWarnings();
  registry = new ContractRegistry(logger);
  vocab = new Vocabulary(logger, warnings);
  pools = new PoolStore(
    manifest,
    logger,
    () => voice,
    (v, name) => scripts.compiled(v)?.pools.get(name),
  );
  scripts = new ScriptSet(logger, warnings, () => voice, { contracts: registry, vocabulary: vocab, pools });
  expansion = new Expansion(
    logger,
    warnings,
    () => voice,
    () => frameOptions,
    {
      contracts: registry,
      vocabulary: vocab,
      pools,
      scripts,
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Register a contract and hand the voice its script, as the facade's `defineContract` + `setScripts` would. */
function contract(c: ScenarioContract, s: CalloutScript = script()): CompiledScenario {
  const entry = registry.store(c, null);
  scripts.setScripts(new Map([["v1", s]]));

  return entry;
}

/** Register a legacy scenario, its sequence resolved at definition as `defineScenario` does. */
function legacy(s: Scenario): CompiledScenario {
  return registry.store(s, s.sequence.map(resolveStep));
}

// ─── prepare ─────────────────────────────────────────────────────────────────

describe("prepare", () => {
  it("wraps a body that holds a clip in its frame, tagged by side, with the frame's clips on SFX", () => {
    randomAt(0);
    const prepared = expansion.prepare(contract(BLUE), null);

    expect(prepared?.fire.ops).toEqual([
      play(AudioChannel.SFX, TICK_OPEN, { frame: "open" }),
      { kind: "ambient", action: "start", frame: "open" },
      play(AudioChannel.Voice, "voice/v1/flags/blue-01.mp3", { pool: "flag-blue" }),
      { kind: "ambient", action: "stop", frame: "close" },
      play(AudioChannel.SFX, TICK_CLOSE, { frame: "close" }),
    ]);
    // No event can end this contract, so no tail is expanded for it.
    expect(prepared?.fire.cutTail).toEqual([]);
  });

  it("expands the cut tail for a contract an event can end: spoken on the callout's channel, its tick on SFX", () => {
    randomAt(0);
    const prepared = expansion.prepare(contract(BLUE_ENDED), null);

    expect(prepared?.fire.cutTail).toEqual([
      play(AudioChannel.Voice, "voice/v1/radio/never-mind-01.mp3", { pool: "never-mind", frame: "cut" }),
      play(AudioChannel.SFX, TICK_CLOSE, { frame: "cut" }),
    ]);
  });

  it("applies the frame switches by position: beeps drops the frame's sound steps, ambience its ambient steps", () => {
    const entry = contract(BLUE_ENDED);
    const body = play(AudioChannel.Voice, "voice/v1/flags/blue-01.mp3", { pool: "flag-blue" });
    randomAt(0);

    frameOptions = { beeps: false, ambience: true };
    expect(expansion.prepare(entry, null)?.fire.ops).toEqual([
      { kind: "ambient", action: "start", frame: "open" },
      body,
      { kind: "ambient", action: "stop", frame: "close" },
    ]);

    frameOptions = { beeps: true, ambience: false };
    expect(expansion.prepare(entry, null)?.fire.ops).toEqual([
      play(AudioChannel.SFX, TICK_OPEN, { frame: "open" }),
      body,
      play(AudioChannel.SFX, TICK_CLOSE, { frame: "close" }),
    ]);

    // Both off: the body plays bare, and the tail still says its words
    // (Radio beeps drops only the tick in it).
    frameOptions = { beeps: false, ambience: false };
    const bare = expansion.prepare(entry, null);
    expect(bare?.fire.ops).toEqual([body]);
    expect(bare?.fire.cutTail).toEqual([
      play(AudioChannel.Voice, "voice/v1/radio/never-mind-01.mp3", { pool: "never-mind", frame: "cut" }),
    ]);
  });

  it("gives a body with no clip no frame, and expands no frame for a body that can never hold one", () => {
    // The frame is broken, and would abort any callout it was expanded for.
    const entry = contract(
      BLUE,
      script({
        scenarios: { [ID]: { sequence: [{ pause: 100 }, { ambient: "seek" }] } },
        frames: { radio: { open: ["sfx/missing-beep.mp3"], close: [] } },
      }),
    );

    expect(expansion.prepare(entry, null)?.fire).toEqual({
      ops: [
        { kind: "pause", ms: 100 },
        { kind: "ambient", action: "seek" },
      ],
      cutTail: [],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("expands the frame before the body, so a frame that aborts runs no body resolver", () => {
    const resolver = vi.fn(() => "voice/{voice}/greet/hi-01.mp3");
    vocab.defineVar("greeting", resolver);
    const entry = contract(
      BLUE,
      script({
        scenarios: { [ID]: { sequence: ["{{greeting}}"] } },
        frames: { radio: { open: ["sfx/missing-beep.mp3"], close: [] } },
      }),
    );

    expect(expansion.prepare(entry, null)).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Voice "v1" frame "radio" cannot play — clip "sfx/missing-beep.mp3" → "sfx/missing-beep.mp3" is not in the manifest for the active voice; every callout it frames is skipped',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      `Scenario "${ID}" skipped — clip "sfx/missing-beep.mp3" → "sfx/missing-beep.mp3" is not in the manifest for the active voice`,
    );

    // The frame warn is said once per (voice, frame); the per-fire detail stays at debug.
    vi.mocked(logger.warn).mockClear();
    expect(expansion.prepare(entry, null)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves the vars into the context the gate reads, and carries the event", () => {
    // A var's value is a full path (or a `pool:` ref), never read under the contract's base.
    vocab.defineVar("greeting", () => "voice/{voice}/greet/hi-01.mp3");
    const entry = contract(BLUE, script({ scenarios: { [ID]: { sequence: ["{{greeting}}"] } } }));
    const event = { name: "pitLane.exited", telemetry: null, data: { lap: 3 } } as never;

    const prepared = expansion.prepare(entry, event);

    expect(prepared?.fire.ops).toContainEqual(play(AudioChannel.Voice, "voice/v1/greet/hi-01.mp3"));
    expect(prepared?.ctx.vars).toEqual({ greeting: "voice/{voice}/greet/hi-01.mp3" });
    expect(prepared?.ctx.event).toBe(event);
    expect(prepared?.ctx.data).toEqual({ lap: 3 });
  });

  describe("returns null, logging why, for every outcome that plays nothing", () => {
    it("a contract the active voice's script does not script", () => {
      const entry = contract(BLUE, script({ scenarios: {} }));

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(`Scenario "${ID}" skipped — no script for voice "v1"`);
    });

    it("a contract with no active voice", () => {
      const entry = contract(BLUE);
      voice = null;

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(`Scenario "${ID}" skipped — no script for voice "(none)"`);
    });

    it("a required clip the voice does not have", () => {
      const entry = contract(BLUE, script({ scenarios: { [ID]: { sequence: ["flags/yellow-01.mp3"] } } }));

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        `Scenario "${ID}" skipped — clip "flags/yellow-01.mp3" → "voice/v1/flags/yellow-01.mp3" is not in the manifest for the active voice`,
      );
    });

    it("a var resolving to nothing", () => {
      vocab.defineVar("greeting", () => null);
      const entry = contract(BLUE, script({ scenarios: { [ID]: { sequence: ["{{greeting}}"] } } }));

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(`Scenario "${ID}" skipped — var {{greeting}} resolved to nothing`);
    });

    it("a pool empty for the active voice", () => {
      const entry = contract(
        BLUE,
        script({
          scenarios: { [ID]: { sequence: ["pool:flag-red"] } },
          pools: { "flag-red": { group: "flags", base: "red" } },
        }),
      );

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        `Scenario "${ID}" skipped — pool "flag-red" resolved to nothing for the active voice`,
      );
    });

    it("an expansion that throws", () => {
      vocab.defineVar("greeting", () => {
        throw new Error("boom");
      });
      const entry = contract(BLUE, script({ scenarios: { [ID]: { sequence: ["{{greeting}}"] } } }));

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(`Scenario "${ID}" expansion failed: boom`);
    });

    it("a body that expanded to nothing", () => {
      const entry = legacy({ ...BLUE, sequence: [{ if: () => false, then: ["flags/blue-01.mp3"] }] });

      expect(expansion.prepare(entry, null)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(`Scenario "${ID}" expanded to empty sequence; skipping`);
    });
  });

  it("commits the pool picks only when commit() is called", () => {
    const entry = contract(BLUE);
    randomAt(0);
    const first = play(AudioChannel.Voice, "voice/v1/flags/blue-01.mp3", { pool: "flag-blue" });
    const second = play(AudioChannel.Voice, "voice/v1/flags/blue-02.mp3", { pool: "flag-blue" });

    // Never committed: nothing was heard, so the next expansion draws the same take.
    expect(expansion.prepare(entry, null)?.fire.ops).toContainEqual(first);
    expect(expansion.prepare(entry, null)?.fire.ops).toContainEqual(first);

    const accepted = expansion.prepare(entry, null);
    expect(accepted?.fire.ops).toContainEqual(first);
    accepted?.commit();

    // Committed: the next fire steers away from the take the driver heard.
    expect(expansion.prepare(entry, null)?.fire.ops).toContainEqual(second);
  });

  it("warns once when the voice's script lacks a legacy scenario's frame, and plays it unframed", () => {
    const entry = legacy({ ...BLUE, frame: "terse", sequence: ["flags/blue-01.mp3"] });
    // The voice's script defines the radio frame only, and scripts no contract.
    scripts.setScripts(new Map([["v1", script({ scenarios: {} })]]));

    expect(expansion.prepare(entry, null)?.fire.ops).toEqual([play(AudioChannel.Voice, "voice/v1/flags/blue-01.mp3")]);
    expect(expansion.prepare(entry, null)).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Voice "v1" defines no frame "terse" — legacy scenarios using it play unframed',
    );
  });
});

// ─── The cut tail ────────────────────────────────────────────────────────────

describe("the cut tail", () => {
  it("falls back to the close when the cut aborts, warns once, and puts the cut's picks back", () => {
    // Two contracts over ONE script map, compiled once: a recompile would
    // clear the script pools' trackers and hide whether the restore happened.
    const SPOKEN: ScenarioContract = { ...BLUE, id: "pit-crew.never-mind" };
    const entry = registry.store(BLUE_ENDED, null);
    const spoken = registry.store(SPOKEN, null);
    scripts.setScripts(
      new Map([
        [
          "v1",
          script({
            scenarios: { [ID]: { sequence: ["pool:flag-blue"] }, [SPOKEN.id]: { sequence: ["pool:never-mind"] } },
            frames: { radio: { ...RADIO, cut: ["pool:never-mind", "radio/missing.mp3"] } },
          }),
        ],
      ]),
    );
    randomAt(0);

    const prepared = expansion.prepare(entry, null);

    // The close, every clip a sound effect, tagged `cut`.
    expect(prepared?.fire.cutTail).toEqual([
      { kind: "ambient", action: "stop", frame: "cut" },
      play(AudioChannel.SFX, TICK_CLOSE, { frame: "cut" }),
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Voice "v1" frame "radio" cut tail cannot play — clip "radio/missing.mp3" → "radio/missing.mp3" is not in the manifest for the active voice; an ended line closes the radio instead',
    );

    // The line itself still plays, and the failed attempt's `never-mind`
    // take was put back before the commit: the next body to draw from that
    // pool gets take 0, where a committed take 0 would have steered it to 1.
    prepared?.commit();
    expect(expansion.prepare(spoken, null)?.fire.ops).toContainEqual(
      play(AudioChannel.Voice, "voice/v1/radio/never-mind-01.mp3", { pool: "never-mind" }),
    );

    // Warned once per (voice, frame): the same broken cut again says nothing.
    expect(expansion.prepare(entry, null)?.fire.cutTail).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("is the close, tagged cut, when the frame defines no cut", () => {
    const entry = contract(BLUE_ENDED, script({ frames: { radio: RADIO } }));

    expect(expansion.prepare(entry, null)?.fire.cutTail).toEqual([
      { kind: "ambient", action: "stop", frame: "cut" },
      play(AudioChannel.SFX, TICK_CLOSE, { frame: "cut" }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ─── prepareFrame ────────────────────────────────────────────────────────────

describe("prepareFrame", () => {
  /** The compiled script of `v1`, as the facade's `playFramePreview` hands it in. */
  function compiledScript(s: CalloutScript = script()) {
    scripts.setScripts(new Map([["v1", s]]));

    return scripts.compiled("v1")!;
  }

  it("expands the frame around nothing, with the switches applied, and no cut tail", () => {
    const s = compiledScript();

    expect(expansion.prepareFrame("radio", "v1", s)?.frame).toEqual({
      open: [play(AudioChannel.SFX, TICK_OPEN, { frame: "open" }), { kind: "ambient", action: "start", frame: "open" }],
      close: [
        { kind: "ambient", action: "stop", frame: "close" },
        play(AudioChannel.SFX, TICK_CLOSE, { frame: "close" }),
      ],
      cut: [],
    });

    frameOptions = { beeps: false, ambience: false };
    // Both halves empty is still a frame: what that means is the caller's.
    expect(expansion.prepareFrame("radio", "v1", s)?.frame).toEqual({ open: [], close: [], cut: [] });
  });

  it("commits the frame's pool picks only when commit() is called", () => {
    const s = compiledScript(script({ frames: { radio: { open: ["pool:never-mind"], close: [] } } }));
    randomAt(0);
    const first = play(AudioChannel.SFX, "voice/v1/radio/never-mind-01.mp3", { pool: "never-mind", frame: "open" });

    expect(expansion.prepareFrame("radio", "v1", s)?.frame.open).toEqual([first]);
    expect(expansion.prepareFrame("radio", "v1", s)?.frame.open).toEqual([first]);

    const accepted = expansion.prepareFrame("radio", "v1", s);
    accepted?.commit();

    expect(expansion.prepareFrame("radio", "v1", s)?.frame.open).toEqual([
      play(AudioChannel.SFX, "voice/v1/radio/never-mind-02.mp3", { pool: "never-mind", frame: "open" }),
    ]);
  });

  it("returns null with one debug line when the frame aborts", () => {
    const s = compiledScript(script({ frames: { radio: { open: ["sfx/missing-beep.mp3"], close: [] } } }));

    expect(expansion.prepareFrame("radio", "v1", s)).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      'Frame preview "radio" skipped — clip "sfx/missing-beep.mp3" → "sfx/missing-beep.mp3" is not in the manifest for the active voice',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns null with one error line when the expansion throws", () => {
    vocab.defineVar("greeting", () => {
      throw new Error("boom");
    });
    const s = compiledScript(script({ frames: { radio: { open: ["{{greeting}}"], close: [] } } }));

    expect(expansion.prepareFrame("radio", "v1", s)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('Frame preview "radio" expansion failed: boom');
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("Frame preview"));
  });

  it("returns null without a line when the frame is unframed", () => {
    // No scenario in the script, so the compile itself warns about nothing.
    expect(expansion.prepareFrame("none", "v1", compiledScript(script({ scenarios: {} })))).toBeNull();
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("Frame preview"));
    // Not the legacy "defines no frame" warn either: `none` is never looked up.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
