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
 * the published reference (#1066) is built from, everything the script
 * references by name — pool, frame, var, condition, case key, fragment — is
 * something the code registries or the script itself defines, and every pool
 * it draws from, in either spelling, has a clip for the bundled voice.
 *
 * The contract set is read off a pass-through spy on `engine.defineContract`
 * installed before the real registration runs (the `register-pit-crew.test.ts`
 * shape) — the engine exposes no contract enumeration, and this test adds
 * none. Since #1065 the set is the WHOLE catalog: every family is a contract
 * plus a script entry, and a sibling spy on `engine.defineScenario` proves the
 * catalog makes no legacy `Scenario` (a contract with an inline sequence) at
 * all. The vacuity floor is therefore two-sided — at least `CATALOG_FLOOR`
 * contracts, and exactly zero legacy scenarios — because a spy installed late
 * would see nothing and let every "for each contract" assertion pass for
 * nothing, and a family re-added in the legacy shape would slip past every
 * script check while still speaking from code.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import {
  type CalloutScript,
  collectScriptReferences,
  NO_FRAME,
  parseStringStep,
  type ScriptStep,
} from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { Scenario, ScenarioContract } from "../../dsl.js";
import { DEFAULT_FRAME } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import {
  _resetAudioScenarios,
  initializeAudioScenarios,
  type IScenarioEngine,
  poolMemberPattern,
} from "../../interpreter.js";
import { FLAG_CLIP_SOURCES, FLAG_SCENARIO_IDS } from "./flag-alerts.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
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

/**
 * How many contracts the catalog registered when #1065 closed it: 24 flags
 * (#1064) plus the 125 callouts migrated in #1065. Bump the literal when a
 * callout is added — it is only the vacuity floor for the spy; the
 * completeness checks below are what actually guard the catalog.
 */
const CATALOG_FLOOR = 149;

/**
 * How many distinct clip sources the bundled script addresses — `pool:<group>/<base>`
 * references plus named `pools` — with the same job as `CATALOG_FLOOR`: a walk
 * that resolved fewer went blind rather than finding the script clean.
 */
const CLIP_SOURCE_FLOOR = 150;

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
 * Every literal clip a step list plays — a bare path string or a `{ clip }`
 * object — through every `optional` / `then` / `else` / `of` branch. An
 * include is not followed: the fragments are walked as sources of their own
 * below, once each, and the compiler inlines them into every entry that
 * includes them. `collectScriptReferences` deliberately leaves clips out
 * (they are not references by NAME), so the walk lives here; a new step form
 * that carries steps needs an arm, which the grammar's own checklist already
 * asks for.
 */
function literalClips(steps: readonly ScriptStep[]): string[] {
  const out: string[] = [];

  const visit = (step: ScriptStep): void => {
    if (typeof step === "string") {
      const form = parseStringStep(step);

      if (form.kind === "clip") out.push(form.path);

      return;
    }

    if ("clip" in step) out.push(step.clip);
    else if ("optional" in step) step.optional.forEach(visit);
    else if ("if" in step) {
      step.then.forEach(visit);
      step.else?.forEach(visit);
    } else if ("case" in step) Object.values(step.of).forEach((branch) => branch.forEach(visit));
  };

  steps.forEach(visit);

  return out;
}

let engine: IScenarioEngine;
let defineContractSpy: MockInstance<(c: ScenarioContract) => void>;
let defineScenarioSpy: MockInstance<(s: Scenario) => void>;
/** Every contract the real registration made, by id — the set the script is held complete against. */
let contracts: Map<string, ScenarioContract>;
/** Every legacy `Scenario` the real registration made, by id — frame consumers, held to the same frame check. */
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
  it("sees the registration: the whole catalog arrives as contracts, and nothing arrives as a legacy scenario", () => {
    // The vacuity floor, two-sided. The spy already collects every contract;
    // the count only proves it was installed in time — and that no family
    // silently dropped out of `registerPitCrew`.
    expect(contracts.size).toBeGreaterThanOrEqual(CATALOG_FLOOR);

    for (const id of FLAG_SCENARIO_IDS) {
      expect(contracts.has(id), `${id} is not registered as a contract`).toBe(true);
    }

    // The catalog is whole (#1065): no `defineScenario` left. A family written
    // back in the legacy shape would speak from code and bypass every check in
    // this file, so the legacy spy must have seen nothing at all.
    expect([...legacyScenarios.keys()], "legacy scenarios registered by the catalog").toEqual([]);
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

/**
 * Where a pool reference's clips live. A slashed name IS its source
 * (`group/base`, addressed directly — the normal spelling); a plain name is an
 * alias the script defines under `pools` — the only place a name can be
 * defined since #1065 deleted the code registry — and `null` when it is not,
 * which the definedness test below names.
 */
function poolSource(name: string): { group: string; base: string } | null {
  const slash = name.indexOf("/");

  if (slash > 0) return { group: name.slice(0, slash), base: name.slice(slash + 1) };

  // `hasOwn`, not a lookup: `pool:constructor` is a well-formed name and must
  // not resolve to `Object.prototype.constructor` (the compiler refuses it too).
  if (Object.hasOwn(SCRIPT.pools, name)) return SCRIPT.pools[name];

  return null;
}

describe("everything the bundled script references by name is defined (issue #1064)", () => {
  it("every named pool a sequence draws from is defined by the script under `pools` — a slashed name needs no definition", () => {
    // The named form is the alias path: a name earns its place only where it
    // decides something the path does not (an alias onto another group, or a
    // second line that must not share a no-repeat tracker with the first),
    // and then the script has to define it — there is no code registry to
    // fall back on since #1065. The slashed form addresses a clip group
    // directly and is checked against the manifest below instead.
    const refs = collectScriptReferences(SCRIPT);
    const unknown = refs.pools.filter((name) => poolSource(name) === null);

    expect(unknown, "named pools referenced but defined nowhere").toEqual([]);
  });

  it("every pool the script draws from — a slashed reference, or a named pool it defines — resolves to at least one clip of the bundled voice", () => {
    // An empty pool aborts its callout at fire time, silently (issue #835),
    // and the compiler never looks at the manifest: a typo'd `pool:flags/redd`
    // compiles clean and ships a registered, scripted, mute flag. Membership is
    // the interpreter's own rule (`poolMemberPattern`), so this test can never
    // accept a clip the engine would not pick.
    const refs = collectScriptReferences(SCRIPT);
    const sources = new Map<string, { group: string; base: string }>();

    for (const name of refs.pools) {
      const source = poolSource(name);

      if (source) sources.set(name, source);
    }

    for (const [name, { group, base }] of Object.entries(SCRIPT.pools)) sources.set(name, { group, base });

    const empty = [...sources]
      .filter(([, { group, base }]) => {
        const pattern = poolMemberPattern(group, base);

        return !MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE);
      })
      .map(([name, { group, base }]) => `${name} → ${group}/${base}`);

    // The vacuity floor: the whole catalog addresses at least this many clip
    // sources (and the flags alone at least theirs), so a walk that resolved
    // fewer went blind rather than finding the script clean.
    expect(sources.size).toBeGreaterThanOrEqual(CLIP_SOURCE_FLOOR);
    expect(sources.size).toBeGreaterThanOrEqual(FLAG_CLIP_SOURCES.length);
    expect(empty, `pools with no voice/${VOICE}/<group>/<base>(-NN).mp3 in manifest.json`).toEqual([]);
  });

  it("every literal clip a frame, a fragment or a sequence plays is in the bundled manifest", () => {
    // A frame's ticks are literal `sfx/…` paths, not pools: a typo there is
    // not caught by the pool checks, and at fire time it aborts EVERY framed
    // callout of the voice (the frame is part of the callout, #835). `sfx/`
    // paths are voice-independent; a `{voice}` placeholder is resolved to the
    // bundled voice the way `substituteVoice` would. A fragment is inlined
    // into every entry that includes it, so a typo there aborts each of them.
    const sources: [where: string, steps: readonly ScriptStep[]][] = [
      ...Object.entries(SCRIPT.frames).flatMap(([name, frame]): [string, readonly ScriptStep[]][] => [
        [`frame "${name}" open`, frame.open],
        [`frame "${name}" close`, frame.close],
      ]),
      ...Object.entries(SCRIPT.fragments ?? {}).map(([name, fragment]): [string, readonly ScriptStep[]] => [
        `fragment "${name}"`,
        fragment.sequence,
      ]),
      ...Object.entries(SCRIPT.scenarios).flatMap(([id, entry]): [string, readonly ScriptStep[]][] =>
        entry.sequence ? [[id, entry.sequence]] : [],
      ),
    ];
    const clips = new Set(MANIFEST.clips);
    const seen: string[] = [];
    const missing: string[] = [];

    for (const [where, steps] of sources) {
      for (const path of literalClips(steps)) {
        const resolved = path.replaceAll("{voice}", VOICE);
        seen.push(resolved);

        if (!clips.has(resolved)) missing.push(`${where} → ${resolved}`);
      }
    }

    // The vacuity floor: the radio frame's two ticks are literal clips, so an
    // empty walk means the walker went blind, not that the script is clean.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(missing, "literal clip steps naming no clip in manifest.json").toEqual([]);
  });

  it("every frame an entry or a contract names is defined by the script", () => {
    const defined = new Set(Object.keys(SCRIPT.frames));
    const problems: string[] = [];

    // Effective frame per contract: entry override → contract default → DEFAULT_FRAME.
    // A frame the script lacks compiles as `unknown frame` and skips the
    // callout for the voice, which the bundle must never do.
    for (const [id, contract] of contracts) {
      const frame = SCRIPT.scenarios[id]?.frame ?? contract.frame ?? DEFAULT_FRAME;

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

  it("every include names a fragment the script defines — an include resolves only within the same script", () => {
    // The compiler inlines a fragment at compile time and refuses an unknown
    // name (issue #1065); `collectScriptReferences` lists both sides, so the
    // whole rule is `includes ⊆ fragments`.
    const refs = collectScriptReferences(SCRIPT);
    const defined = new Set(refs.fragments);
    const unknown = refs.includes.filter((name) => !defined.has(name));

    expect(unknown, "included names that are not defined under `fragments`").toEqual([]);
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
