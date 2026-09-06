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
 * `configs/<voice-id>.voice.json` — (a) ORPHANS, (b) DANGLING, (c) FRAGMENTS,
 * stated in full on `@iracedeck/callout-script`'s `coverage.ts`, where they
 * live since #1066 so that `lint:pack` runs the very same rules over the clip
 * files a pack ships — plus (d) a vacuity floor for the bundled voice, so a
 * walk that resolved nothing reads as blind rather than clean. The glue from
 * a config to the rules is `script-coverage.ts` beside this file.
 *
 * What the check cannot see, and how that is handled: a var resolver produces
 * a `poolRef(group, base)` at fire time, and the vocabulary lives in
 * `@iracedeck/audio-scenarios`, which depends on this package. A group NO
 * script step addresses (`position-number`, `names`, `lap-time-*`, …) is
 * therefore skipped whole — it is var-driven, and nothing here can say which
 * of its bases a resolver may pick. A group a script addresses for SOME bases
 * while a resolver produces the rest (`session-start`, `incidents`, …) is the
 * case the group rule cannot express, so those bases are declared below by
 * shape, each naming its resolver. `lint:pack` reads both off the vocabulary
 * instead, which is why the two lists below stay HERE: they are facts about
 * the bundled voice, not rules.
 */
import { type Coverage, danglingOf, orphansOf } from "@iracedeck/callout-script";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { loadVoiceConfigs, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import { coverageOfConfig, unscriptedGroupsAreVarDriven } from "./script-coverage.ts";

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

/**
 * Rule (a) as this test reads it: the shared `orphansOf` under the
 * unscripted-group reading (the vocabulary is out of reach here), less the
 * two declared lists above.
 */
function bundledOrphansOf(coverage: Coverage): string[] {
  return orphansOf(coverage, unscriptedGroupsAreVarDriven(coverage)).filter(
    (base) =>
      !VAR_DRIVEN_BASES.some(({ pattern }) => pattern.test(base)) &&
      !DELIBERATELY_UNSPOKEN.some((entry) => entry.base === base),
  );
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
    const coverage = coverageOfConfig(
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

    expect(bundledOrphansOf(coverage)).toEqual(["flags/blu"]);
    expect(danglingOf(coverage)).toEqual([]);
  });

  it("names a referenced base nothing authors, in every spelling — slashed step, object step, named alias, literal clip", () => {
    const coverage = coverageOfConfig(
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
    expect(bundledOrphansOf(coverage)).toEqual([]);
  });

  it("names a plain pool the script draws from but never defines — a `connector` step included", () => {
    const coverage = coverageOfConfig(
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
    const coverage = coverageOfConfig(
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
    expect(bundledOrphansOf(coverage)).toEqual([]);
  });

  it("reads a skipped entry as referencing nothing, and a fragment or frame as referencing what it plays", () => {
    const coverage = coverageOfConfig(
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

    expect(bundledOrphansOf(coverage)).toEqual(["flags/green"]);
    expect(danglingOf(coverage)).toEqual([]);
  });

  // The engine's pool rule (`poolMemberPattern`) admits `<base>-NN.mp3` AND
  // the bare `<base>.mp3`, so an authored `countdown-90` with no `-01` take
  // is a member of the `countdown-90` pool in its own right — and, `90`
  // being two digits, of the `countdown` pool as well. The check has to read
  // an authored name both ways too, or it reports the clip as an orphan and
  // its own reference as dangling.
  it("reads an unsuffixed two-digit base the way the engine does — matched as itself and as a variant", () => {
    const coverage = coverageOfConfig(
      fixture({
        groups: {
          "start-lights": [
            { name: "countdown-90", text: "Ninety." },
            { name: "countdown-60", text: "Sixty." },
          ],
        },
        scenarios: {
          "pit-crew.start-countdown-90": { ...ENTRY, sequence: ["pool:start-lights/countdown-90"] },
          "pit-crew.start-countdown-60": { ...ENTRY, sequence: ["pool:start-lights/countdown"] },
        },
      }),
    );

    expect(bundledOrphansOf(coverage)).toEqual([]);
    expect(danglingOf(coverage)).toEqual([]);
  });

  // The compiler converts a fragment only when something includes it, so a
  // fragment nothing includes — or that only a skipped entry includes — is
  // dead: what it references is resolved by no entry the engine compiles.
  it("names a defined fragment nothing includes, and counts what only it references as unreferenced", () => {
    const coverage = coverageOfConfig(
      fixture({
        groups: {
          flags: [
            { name: "blue-01", text: "Blue flag." },
            { name: "white-01", text: "White flag." },
          ],
        },
        fragments: {
          tail: { sequence: ["pool:flags/white", "pool:flags/ghost"] },
        },
        scenarios: {
          "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] },
          "pit-crew.flag-green": { ...ENTRY, skip: true, sequence: ["@tail"] },
        },
      }),
    );

    expect(coverage.unincludedFragments).toEqual(["tail"]);
    // `white` is referenced only from the dead fragment: an orphan. The dead
    // fragment's own dangling `ghost` is the compiler's to report, not this
    // check's — it is not a reference anything live resolves.
    expect(bundledOrphansOf(coverage)).toEqual(["flags/white"]);
    expect(danglingOf(coverage)).toEqual([]);
  });

  it("names an include of a fragment the script never defines", () => {
    const coverage = coverageOfConfig(
      fixture({
        groups: { flags: [{ name: "blue-01", text: "Blue flag." }] },
        fragments: { "readback-body": { sequence: ["pool:flags/blue"] } },
        scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["@readback-bod"] } },
      }),
    );

    expect(coverage.unknownIncludes).toEqual(["readback-bod"]);
  });

  // A literal clip step is checked when it addresses one of the voice's own
  // clips (`voice/<voice>/<group>/<name>.mp3`) and left alone when it
  // addresses a shared built-in (`sfx/…`, the bundled frame's ticks). Any
  // other spelling — a base-relative `flags/blue-01.mp3`, which the engine
  // would resolve against the contract's `base` — cannot be placed by this
  // check, so it is a finding rather than a silent drop.
  it("names a literal clip path it cannot place — base-relative — and passes the shared sfx paths", () => {
    const coverage = coverageOfConfig(
      fixture({
        groups: { flags: [{ name: "blue-01", text: "Blue flag." }] },
        frames: { radio: { open: [{ clip: "sfx/IRD-tick-open.mp3" }], close: ["/sfx/IRD-tick-close.mp3"] } },
        scenarios: {
          "pit-crew.flag-blue": {
            ...ENTRY,
            sequence: ["/voice/{voice}/flags/blue-01.mp3", "flags/blue-01.mp3", { clip: "voice/flags/blue-01.mp3" }],
          },
        },
      }),
    );

    expect(bundledOrphansOf(coverage)).toEqual([]);
    expect(danglingOf(coverage)).toEqual([
      'literal "flags/blue-01.mp3" (not voice/<voice>/<group>/<name>.mp3 — a path this check cannot place)',
      'literal "voice/flags/blue-01.mp3" (not voice/<voice>/<group>/<name>.mp3 — a path this check cannot place)',
    ]);
  });
});

describe("the two declared lists are alive — nothing parked here has quietly stopped being true", () => {
  const defaultVoice = loadVoiceConfigs(CONFIGS_DIR).get(DEFAULT_VOICE_ID);

  it("includes the canonical default voice", () => {
    expect(defaultVoice).toBeDefined();
  });

  if (!defaultVoice) return;

  const coverage = coverageOfConfig(defaultVoice);

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
      const coverage = coverageOfConfig(voice);

      it("references every clip it authors in a group its script addresses — an unreferenced base is a typo or a lost consumer", () => {
        const orphans = bundledOrphansOf(coverage);

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

      it("includes every fragment it defines, from a live entry or frame — a fragment nothing includes is checked by nobody", () => {
        expect(coverage.unincludedFragments, `fragments in "${voiceId}" no live entry or frame includes`).toEqual([]);
      });

      it("defines every fragment it includes — an include resolves only within the same script", () => {
        expect(coverage.unknownIncludes, `includes in "${voiceId}" of fragments it does not define`).toEqual([]);
      });

      if (voiceId === DEFAULT_VOICE_ID) {
        it(`addresses at least ${SCRIPTED_GROUPS_FLOOR} clip groups directly — the bundled walk is not blind`, () => {
          expect(coverage.scriptedGroups.size).toBeGreaterThanOrEqual(SCRIPTED_GROUPS_FLOOR);
        });
      }
    });
  }
});
