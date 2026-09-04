/**
 * Bundled-script completeness (issue #1064).
 *
 * The code declares a contract; the active voice's `callouts.json` says what
 * it speaks; the two pair by id in a JSON file. Deleting a TypeScript array
 * entry breaks a test, deleting a JSON key would not — and under "absent means
 * skipped" the engineer would just go quiet about that flag, at debug level.
 * That silence is correct for a third-party pack and wrong for ours, so the
 * bundled voice gets the safety net JSON otherwise costs: every contract the
 * real `registerPitCrew` registers has an entry (`skip: true` counts — a
 * deliberate declaration rather than an oversight), no entry names an id the
 * code does not declare, every entry carries the `comment` and `test` lines
 * the published reference (#1066) is built from, and everything the script
 * references by name — pool, frame, var, condition, case key, include — is
 * something the code registries or the script itself defines.
 *
 * The contract set is read off a pass-through spy on `engine.defineContract`
 * installed before the real registration runs (the `register-pit-crew.test.ts`
 * shape), so it widens on its own as #1065 migrates the remaining families —
 * the engine exposes no contract enumeration, and this test adds none. The
 * flags family is the floor: a spy installed late would see nothing and let
 * every "for each contract" assertion pass vacuously, so the set must contain
 * at least `FLAG_SCENARIO_IDS`.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences, NO_FRAME } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { Scenario, ScenarioContract } from "../../dsl.js";
import { DEFAULT_FRAME } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, type IScenarioEngine } from "../../interpreter.js";
import { FLAG_SCENARIO_IDS } from "./flag-alerts.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { POOL_REGISTRY } from "./pools.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

// The catalog reads the translator only at fire time, and nothing fires here;
// the mock keeps the registration off the real translator's module state, as
// every other `registerPitCrew`-driven test in this directory does.
vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
}));

/** The bundled voice — the one whose script this test holds to the completeness bar. */
const VOICE = "default";

/** The JSON import types `schema` as `number`, hence the cast; the freshness test in audio-assets proves it parses. */
const SCRIPT = defaultScript as CalloutScript;

/** The real runtime manifest, so "does this pool have a clip" is asked of the bundled voice's actual clip set. */
const MANIFEST: AudioAssetsManifest = manifestJson;

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createBus(): IEventBus {
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
  };
}

function createFakeAudio(): IAudioService {
  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn(() => true),
    stopChannel: vi.fn(),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((_channel: AudioChannel, _cb: () => void) => {}),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
  } as unknown as IAudioService;
}

/**
 * The interpreter's own pool-membership rule (`buildManifestPool`): every
 * `voice/<voice>/<group>/<base>-NN.mp3` — exactly two digits — plus the bare
 * `<base>.mp3` (issue #836). Restated here rather than imported because the
 * method is private; the #1051 entry in the callout-examples rule records
 * what a three-digit suffix did to a whole family, which is why the digit
 * count is pinned and not loosened.
 */
function hasClipForVoice(voice: string, group: string, base: string): boolean {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^voice/${escape(voice)}/${escape(group)}/${escape(base)}(?:-\\d{2})?\\.mp3$`);

  return MANIFEST.clips.some((clip) => pattern.test(clip));
}

let engine: IScenarioEngine;
let defineContractSpy: MockInstance<(c: ScenarioContract) => void>;
let defineScenarioSpy: MockInstance<(s: Scenario) => void>;
/** Every contract the real registration made, by id — the set the script is held complete against. */
let contracts: Map<string, ScenarioContract>;
/** Every legacy `Scenario` the real registration made, by id — the include targets, and frame consumers too. */
let legacyScenarios: Map<string, Scenario>;
/** What registration itself warned and errored, against the real manifest — kept apart from what `setScripts` says. */
let registrationWarnings: string[];
let registrationErrors: string[];

beforeEach(() => {
  const bus = createBus();
  engine = initializeAudioScenarios(bus, createFakeAudio(), MANIFEST, logger as never, () => VOICE);
  // Pass-through spies, installed BEFORE the registration so they see all of it.
  defineContractSpy = vi.spyOn(engine, "defineContract");
  defineScenarioSpy = vi.spyOn(engine, "defineScenario");
  registerPitCrew(bus, { logger: logger as never });
  contracts = new Map(defineContractSpy.mock.calls.map(([c]) => [c.id, c]));
  legacyScenarios = new Map(defineScenarioSpy.mock.calls.map(([s]) => [s.id, s]));
  registrationWarnings = logger.warn.mock.calls.map(([message]) => String(message));
  registrationErrors = logger.error.mock.calls.map(([message]) => String(message));
  // The compile assertions below must see only what `setScripts` itself says.
  vi.clearAllMocks();
  engine.setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
});

describe("the bundled script is complete for every contract the catalog registers (issue #1064)", () => {
  it("sees the registration: at least the flags family arrives as contracts", () => {
    // The vacuity floor. Widen the expectation as #1065 migrates families —
    // the spy already collects them; this only proves it was installed in time.
    expect(contracts.size).toBeGreaterThanOrEqual(FLAG_SCENARIO_IDS.length);

    for (const id of FLAG_SCENARIO_IDS) {
      expect(contracts.has(id), `${id} is not registered as a contract`).toBe(true);
    }

    // And the legacy half is still there: the include-target and frame checks
    // below iterate it, and an empty map would pass them for nothing.
    expect(legacyScenarios.size).toBeGreaterThan(50);
  });

  it("registers the whole catalog clean against the bundled manifest — no empty code pool, no disabled scenario", () => {
    // The family tests register against hand-built manifests, which is how a
    // family once shipped registered, enabled, unit-tested and mute (the #1051
    // entry in the callout-examples rule). Against the real manifest a warn is
    // a code pool with no default-voice clip or a `{voice}` path that resolves
    // to nothing, and an error is a scenario validation disabled outright.
    expect(registrationWarnings).toEqual([]);
    expect(registrationErrors).toEqual([]);
  });

  it("scripts every contract — an id with no entry would be silent under 'absent means skipped'", () => {
    const missing = [...contracts.keys()].filter((id) => !Object.hasOwn(SCRIPT.scenarios, id));

    expect(
      missing,
      "contracts with no entry in voice/default/callouts.json (skip: true is the deliberate form)",
    ).toEqual([]);
  });

  it("scripts nothing the code does not declare — a stray id compiles as 'no contract' and is skipped with a warn", () => {
    const undeclared = Object.keys(SCRIPT.scenarios).filter((id) => !contracts.has(id));

    expect(undeclared, "script entries whose id is not a registered contract").toEqual([]);
  });

  it("every entry carries the comment and test lines the reference is built from, and a sequence unless skipped", () => {
    for (const [id, entry] of Object.entries(SCRIPT.scenarios)) {
      expect(entry.comment?.trim().length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test?.trim().length ?? 0, `${id}: test`).toBeGreaterThan(0);

      if (entry.skip === true) continue;

      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });
});

describe("everything the bundled script references by name is defined (issue #1064)", () => {
  it("every pool a sequence draws from is defined by the script or by POOL_REGISTRY", () => {
    const refs = collectScriptReferences(SCRIPT);
    const unknown = refs.pools.filter(
      (name) =>
        // A slashed name addresses a clip group directly (`group/base`) and needs no definition.
        !name.includes("/") && !Object.hasOwn(SCRIPT.pools, name) && !Object.hasOwn(POOL_REGISTRY, name),
    );

    expect(unknown, "pools referenced but defined nowhere").toEqual([]);
  });

  it("every script-defined pool resolves to at least one clip of the bundled voice", () => {
    // An empty pool aborts its callout at fire time, silently (issue #835);
    // a typo'd base in `pools` would ship a registered, scripted, mute flag.
    const empty = Object.entries(SCRIPT.pools)
      .filter(([, { group, base }]) => !hasClipForVoice(VOICE, group, base))
      .map(([name, { group, base }]) => `${name} → ${group}/${base}`);

    expect(empty, `pools with no voice/${VOICE}/<group>/<base>(-NN).mp3 in manifest.json`).toEqual([]);
  });

  it("every frame an entry, a contract or a legacy scenario names is defined by the script", () => {
    const defined = new Set(Object.keys(SCRIPT.frames));
    const problems: string[] = [];

    // Effective frame per contract: entry override → contract default → DEFAULT_FRAME.
    for (const [id, contract] of contracts) {
      const frame = SCRIPT.scenarios[id]?.frame ?? contract.frame ?? DEFAULT_FRAME;

      if (frame !== NO_FRAME && !defined.has(frame)) problems.push(`${id} → frame "${frame}"`);
    }

    // A legacy scenario is framed from the same script; a frame it names that
    // the script lacks plays unframed with a warn, which the bundle must not do.
    for (const [id, scenario] of legacyScenarios) {
      const frame = scenario.frame ?? DEFAULT_FRAME;

      if (frame !== NO_FRAME && !defined.has(frame)) problems.push(`${id} → frame "${frame}"`);
    }

    expect(problems, "frames referenced but not defined under `frames`").toEqual([]);
    expect(defined.has(DEFAULT_FRAME), `the "${DEFAULT_FRAME}" frame every unframed-by-default callout wears`).toBe(
      true,
    );
  });

  it("every var, condition and case the script references is registered, with every case key declared", () => {
    const refs = collectScriptReferences(SCRIPT);
    const vocabulary = engine.vocabulary();
    const vars = new Set(vocabulary.vars.map((v) => v.name));
    const conds = new Set(vocabulary.conds.map((c) => c.name));
    const cases = new Map(vocabulary.cases.map((c) => [c.name, new Set(Object.keys(c.keys))]));

    expect(
      refs.vars.filter((name) => !vars.has(name)),
      "vars referenced but not registered with defineVar",
    ).toEqual([]);
    expect(
      refs.conds.filter((name) => !conds.has(name)),
      "conditions referenced but not registered with defineCond",
    ).toEqual([]);
    expect(
      refs.cases.filter((c) => !cases.has(c.name)).map((c) => c.name),
      "cases referenced but not registered with defineCase",
    ).toEqual([]);

    const undeclaredKeys = refs.cases.flatMap((c) =>
      c.keys.filter((key) => !cases.get(c.name)?.has(key)).map((key) => `${c.name}: "${key}"`),
    );

    expect(undeclaredKeys, "case keys a script maps that the resolver never declared").toEqual([]);
  });

  it("every include targets a legacy fragment — a contract has no sequence to splice", () => {
    const refs = collectScriptReferences(SCRIPT);
    const unknown = refs.includes.filter((id) => !legacyScenarios.has(id));

    expect(unknown, "included ids that are not a registered legacy scenario").toEqual([]);
  });

  it("compiles for the bundled voice with nothing skipped and nothing warned", () => {
    // The compiler's own verdict, end to end: one warn per (voice, scenario)
    // for any reference the checks above might have missed, and the per-voice
    // debug tally must read <scripted> of <contracts>, where the only thing
    // that may keep a contract out of <scripted> is a deliberate `skip: true`.
    const scripted = Object.values(SCRIPT.scenarios).filter((entry) => entry.skip !== true).length;

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Voice scripts loaded");
    expect(logger.debug).toHaveBeenCalledWith(`Voice "${VOICE}": ${scripted} of ${contracts.size} callouts scripted`);
  });
});
