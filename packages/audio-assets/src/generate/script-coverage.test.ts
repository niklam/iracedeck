/**
 * Within-pack script coverage (issue #1065).
 *
 * Replaces `voice-parity.test.ts` (issue #664), which failed CI for any
 * non-default voice carrying a `<group>/<base>` the default voice lacked,
 * reasoning that a base the canonical voice does not know is referenced by no
 * pool and would never play. That premise held only while every pool came from
 * a code registry. Once a voice ships its own script, its own base is
 * referenced by its own sequence — not dead, just not ours — and enforcing
 * parity would forbid the central thing the format exists to allow.
 *
 * The replacement is per voice and stronger: a base that no script in the SAME
 * voice references is the typo. It needs no parity with default, it applies to
 * every voice including the bundled one, and it catches what the old test never
 * could — a typo in `default.voice.json` itself. Three rules, for every
 * `configs/<voice-id>.voice.json`:
 *
 * (a) ORPHANS — every `<group>/<base>` the config's `groups` author (base = the
 *     entry name minus its `-NN` variant suffix) inside a group the script
 *     addresses must be referenced by the script. A base in such a group that
 *     nothing references is a clip that never plays: a misspelling, or a line
 *     that lost its consumer.
 * (b) DANGLING — every `<group>/<base>` the script references, in either
 *     spelling, must be authored in `groups`; and every plain pool NAME must be
 *     defined under `pools`, a `{ connector: true }` step included (the engine
 *     draws it from the named `connector` pool, so a script that uses one has
 *     to define it). A reference to nothing is a callout the engine aborts at
 *     fire time (#835), silently.
 * (c) A vacuity floor for the bundled voice, so a walk that resolved nothing
 *     reads as blind rather than clean.
 *
 * What the check cannot see, and how that is handled: a var resolver produces
 * a `poolRef(group, base)` at fire time, and the vocabulary lives in
 * `@iracedeck/audio-scenarios`, which depends on this package. A group NO
 * script step addresses (`position-number`, `names`, `lap-time-*`, …) is
 * therefore skipped whole — it is var-driven, and nothing here can say which
 * of its bases a resolver may pick. A group a script addresses for SOME bases
 * while a resolver produces the rest (`session-start`, `incidents`, …) is the
 * case the group rule cannot express, so those bases are declared below by
 * shape, each naming its resolver. Declaring source groups per var — which
 * would let this check read them instead of carrying a list — is #1066's
 * `lint:pack`.
 */
import {
  type CalloutScript,
  collectScriptReferences,
  parseStringStep,
  type ScriptStep,
} from "@iracedeck/callout-script";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { buildCalloutScript } from "../build/callout-scripts.mjs";
import { loadVoiceConfigs, type VoiceConfig, VoiceConfigSchema } from "./config.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const CONFIGS_DIR = path.join(PACKAGE_ROOT, "configs");

const DEFAULT_VOICE_ID = "default";

/**
 * How many clip groups the bundled voice's script addresses directly — the
 * vacuity floor for rule (a): a walk that touched fewer went blind rather than
 * finding the script clean. Bump it when a new family brings a new group.
 */
const SCRIPTED_GROUPS_FLOOR = 20;

/**
 * Bases a var resolver in the catalog produces (`poolRef(group, base)`) inside
 * a group a script ALSO addresses directly, so the group rule cannot skip
 * them. Declared by shape, each naming the resolver, because the vocabulary
 * is unreachable from here (see the header). Every pattern must match at least
 * one authored base of the bundled voice — a pattern that matches nothing is
 * a resolver that went away, and the allowlist test below says so.
 */
const VAR_DRIVEN_BASES: readonly { pattern: RegExp; resolver: string }[] = [
  { pattern: /^incidents\/points-\d+$/, resolver: "incident.points" },
  { pattern: /^pit-limiter\/unit-(kmh|mph)$/, resolver: "pitSpeed.limitUnit" },
  { pattern: /^session-start\/session-(practice|qualifying|race)$/, resolver: "sessionStart.sessionLine" },
  { pattern: /^session-start\/speed-unit-(kmh|mph)$/, resolver: "sessionStart.speedUnit" },
  {
    pattern: /^session-start\/degrees-(celsius|fahrenheit)$/,
    resolver: "sessionStart.degreesUnit, raceStart.degreesUnit",
  },
  { pattern: /^session-start\/wetness-[a-z-]+$/, resolver: "sessionStart.wetness, raceStart.wetness" },
];

/**
 * Authored clips no script references ON PURPOSE. Each entry carries the
 * reason, and the allowlist test below insists the clip still exists and is
 * still unreferenced — an entry that stopped being either is stale and comes
 * out. A finding this check makes that is NOT deliberate is reported to the
 * maintainer, never parked here.
 */
const DELIBERATELY_UNSPOKEN: readonly { base: string; reason: string }[] = [
  {
    base: "pit-readback/windshield-off",
    reason:
      "The readback never speaks the negative for the windshield: open-wheel cars have no windshield and telemetry cannot tell, so 'no windshield' would be wrong for half the field. The clip shipped with the readback (#476) and stays until the maintainer rules on it.",
  },
];

/** Strip the `-NN` variant suffix from an entry name (`blue-01` → `blue`). */
function stripVariantSuffix(name: string): string {
  return name.replace(/-\d{2}$/, "");
}

/** `voice/<voice>/<group>/<name>.mp3` — a literal clip step addressing one of the voice's own clips. */
const VOICE_CLIP_PATH = /^voice\/[^/]+\/([^/]+)\/([^/]+)\.mp3$/;

/**
 * Every literal clip a step list plays — a bare path string or a `{ clip }`
 * object — through every `optional` / `then` / `else` / `of` branch. A fragment
 * is walked as a source of its own, not through its includes.
 * `collectScriptReferences` deliberately leaves clips out (they are not
 * references by NAME), so the walk lives here.
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

/** Every step list a script plays: entries (skipped ones excluded), frames, fragments. */
function stepLists(script: CalloutScript): readonly ScriptStep[][] {
  return [
    ...Object.values(script.scenarios).flatMap((entry) =>
      entry.skip !== true && entry.sequence ? [entry.sequence] : [],
    ),
    ...Object.values(script.frames).flatMap((frame) => [frame.open, frame.close]),
    ...Object.values(script.fragments ?? {}).map((fragment) => fragment.sequence),
  ];
}

type Coverage = {
  /** `<group>/<base>` keys the config authors. */
  authored: Set<string>;
  /** `<group>/<base>` keys the script references, in any spelling, plus every defined pool's source. */
  referenced: Set<string>;
  /** The groups `referenced` touches. */
  scriptedGroups: Set<string>;
  /** Plain pool names a sequence draws from that `pools` does not define. */
  undefinedPools: string[];
};

/**
 * What a voice's script covers of its own clips. Pure over the parsed config,
 * so a fixture can prove the rules bite before the real configs are held to
 * them.
 */
function coverageOf(config: VoiceConfig): Coverage {
  const script = buildCalloutScript(config);
  const refs = collectScriptReferences(script);
  const authored = new Set<string>();
  const referenced = new Set<string>();
  const undefinedPools: string[] = [];

  for (const [group, entries] of Object.entries(config.groups)) {
    for (const entry of entries) authored.add(`${group}/${stripVariantSuffix(entry.name)}`);
  }

  for (const name of refs.pools) {
    const slash = name.indexOf("/");

    if (slash > 0) {
      referenced.add(name);
    } else if (Object.hasOwn(script.pools, name)) {
      // `hasOwn`, not a lookup: `pool:constructor` is a well-formed name and
      // must not resolve to `Object.prototype.constructor`.
      const { group, base } = script.pools[name];
      referenced.add(`${group}/${base}`);
    } else {
      undefinedPools.push(name);
    }
  }

  // A defined alias is a reference too: its source must exist even when no
  // sequence draws from the name yet.
  for (const { group, base } of Object.values(script.pools)) referenced.add(`${group}/${base}`);

  for (const steps of stepLists(script)) {
    for (const clip of literalClips(steps)) {
      const match = VOICE_CLIP_PATH.exec(clip);

      if (match) referenced.add(`${match[1]}/${stripVariantSuffix(match[2])}`);
    }
  }

  const scriptedGroups = new Set([...referenced].map((key) => key.slice(0, key.indexOf("/"))));

  return { authored, referenced, scriptedGroups, undefinedPools };
}

/** Rule (a): authored bases in a scripted group that nothing references, less the two declared lists. */
function orphansOf({ authored, referenced, scriptedGroups }: Coverage): string[] {
  return [...authored]
    .filter((key) => scriptedGroups.has(key.slice(0, key.indexOf("/"))))
    .filter((key) => !referenced.has(key))
    .filter((key) => !VAR_DRIVEN_BASES.some(({ pattern }) => pattern.test(key)))
    .filter((key) => !DELIBERATELY_UNSPOKEN.some(({ base }) => base === key))
    .sort();
}

/** Rule (b): referenced bases nothing authors, and named pools nothing defines. */
function danglingOf({ authored, referenced, undefinedPools }: Coverage): string[] {
  return [
    ...[...referenced].filter((key) => !authored.has(key)),
    ...undefinedPools.map((name) => `pool "${name}" (named, defined nowhere under pools)`),
  ].sort();
}

/** A config carrying only what a coverage fixture needs; the generator fields are constant. */
function fixture(extra: Record<string, unknown>): VoiceConfig {
  return VoiceConfigSchema.parse({
    id: "eleven-voice-id",
    label: "Fixture",
    model_id: "eleven_test_model",
    voice_settings: { stability: 1, similarity_boost: 1 },
    ...extra,
  });
}

const ENTRY = { comment: "fixture", test: "fixture" };

describe("script coverage — the rules bite (positive controls over a mistyped fixture)", () => {
  it("names an authored base a scripted group carries that no step references — the misspelled take", () => {
    const coverage = coverageOf(
      fixture({
        groups: {
          flags: [
            { name: "blue-01", text: "Blue flag." },
            { name: "blu-02", text: "Blue flag, again." },
          ],
        },
        scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } },
      }),
    );

    expect(orphansOf(coverage)).toEqual(["flags/blu"]);
    expect(danglingOf(coverage)).toEqual([]);
  });

  it("names a referenced base nothing authors, in every spelling — slashed step, object step, named alias, literal clip", () => {
    const coverage = coverageOf(
      fixture({
        groups: { flags: [{ name: "blue-01", text: "Blue flag." }] },
        pools: { "flag-red": { group: "flags", base: "red", comment: "an alias onto a base nobody recorded" } },
        scenarios: {
          "pit-crew.flag-blue": {
            ...ENTRY,
            sequence: ["pool:flags/blue", "pool:flags/blu", { pool: "flags/green" }, "pool:flag-red"],
          },
          "pit-crew.flag-white": { ...ENTRY, sequence: [{ clip: "voice/{voice}/flags/white-01.mp3" }] },
        },
      }),
    );

    expect(danglingOf(coverage)).toEqual(["flags/blu", "flags/green", "flags/red", "flags/white"]);
    expect(orphansOf(coverage)).toEqual([]);
  });

  it("names a plain pool the script draws from but never defines — a `connector` step included", () => {
    const coverage = coverageOf(
      fixture({
        groups: { flags: [{ name: "blue-01", text: "Blue flag." }] },
        scenarios: {
          "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flag-blue", { connector: true }, "pool:flags/blue"] },
        },
      }),
    );

    expect(danglingOf(coverage)).toEqual([
      'pool "connector" (named, defined nowhere under pools)',
      'pool "flag-blue" (named, defined nowhere under pools)',
    ]);
  });

  it("skips a group no step addresses — var-driven, its bases are a resolver's to pick", () => {
    const coverage = coverageOf(
      fixture({
        groups: {
          flags: [{ name: "blue-01", text: "Blue flag." }],
          "position-number": [
            { name: "1", text: "One." },
            { name: "2", text: "Two." },
          ],
        },
        scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } },
      }),
    );

    expect(coverage.scriptedGroups).toEqual(new Set(["flags"]));
    expect(orphansOf(coverage)).toEqual([]);
  });

  it("reads a skipped entry as referencing nothing, and a fragment or frame as referencing what it plays", () => {
    const coverage = coverageOf(
      fixture({
        groups: {
          flags: [
            { name: "blue-01", text: "Blue flag." },
            { name: "green-01", text: "Green flag." },
            { name: "white-01", text: "White flag." },
          ],
          sfx: [{ name: "beep", text: "beep" }],
        },
        frames: { radio: { open: ["pool:sfx/beep"], close: [] } },
        fragments: { tail: { sequence: ["pool:flags/white"] } },
        scenarios: {
          "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue", "@tail"] },
          "pit-crew.flag-green": { ...ENTRY, skip: true, sequence: ["pool:flags/green"] },
        },
      }),
    );

    expect(orphansOf(coverage)).toEqual(["flags/green"]);
    expect(danglingOf(coverage)).toEqual([]);
  });
});

describe("the two declared lists are alive — nothing parked here has quietly stopped being true", () => {
  const defaultVoice = loadVoiceConfigs(CONFIGS_DIR).get(DEFAULT_VOICE_ID);

  it("includes the canonical default voice", () => {
    expect(defaultVoice).toBeDefined();
  });

  if (!defaultVoice) return;

  const coverage = coverageOf(defaultVoice);

  it("every var-driven pattern matches at least one authored base of the bundled voice, in a group a script addresses", () => {
    // A pattern matching nothing is a resolver that went away, or a group
    // that is no longer mixed; either way the entry is stale and comes out.
    const dead = VAR_DRIVEN_BASES.filter(
      ({ pattern }) =>
        ![...coverage.authored].some(
          (key) => pattern.test(key) && coverage.scriptedGroups.has(key.slice(0, key.indexOf("/"))),
        ),
    ).map(({ pattern, resolver }) => `${pattern} (${resolver})`);

    expect(dead, "var-driven patterns that match no authored base in a scripted group").toEqual([]);
  });

  it("every deliberately unspoken clip is still authored and still unreferenced by the bundled voice", () => {
    const stale = DELIBERATELY_UNSPOKEN.filter(
      ({ base }) => !coverage.authored.has(base) || coverage.referenced.has(base),
    ).map(({ base }) => base);

    expect(stale, "allowlist entries that are no longer an orphan (removed, or spoken again)").toEqual([]);
  });
});

describe("every voice's script covers its own clips (issue #1065)", () => {
  const voiceConfigs = loadVoiceConfigs(CONFIGS_DIR);

  it("includes the canonical default voice", () => {
    expect(voiceConfigs.has(DEFAULT_VOICE_ID)).toBe(true);
  });

  for (const [voiceId, voice] of voiceConfigs) {
    describe(`voice "${voiceId}"`, () => {
      const coverage = coverageOf(voice);

      it("references every clip it authors in a group its script addresses — an unreferenced base is a typo or a lost consumer", () => {
        const orphans = orphansOf(coverage);

        expect(
          orphans,
          `authored <group>/<base> keys no step, frame, fragment or pool alias in "${voiceId}" references:\n  ${orphans.join("\n  ")}`,
        ).toEqual([]);
      });

      it("authors every clip its script references, and defines every pool name it draws from", () => {
        const dangling = danglingOf(coverage);

        expect(
          dangling,
          `referenced in "${voiceId}" but authored nowhere (a fire-time abort, #835):\n  ${dangling.join("\n  ")}`,
        ).toEqual([]);
      });

      if (voiceId === DEFAULT_VOICE_ID) {
        it(`addresses at least ${SCRIPTED_GROUPS_FLOOR} clip groups directly — the bundled walk is not blind`, () => {
          expect(coverage.scriptedGroups.size).toBeGreaterThanOrEqual(SCRIPTED_GROUPS_FLOOR);
        });
      }
    });
  }
});
