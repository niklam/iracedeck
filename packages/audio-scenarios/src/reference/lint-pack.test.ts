import type { CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import type { ContractReport, VocabularyReport } from "../interpreter.js";
import { type CompileDeps, compileVoiceScript } from "../script-compiler.js";
import {
  formatLintReport,
  lintPack,
  type LintPackFileSystem,
  type LintPackInput,
  type LintProblem,
  type LintReport,
  SUMMARY_WIDTH,
} from "./lint-pack.js";

// ─── A tiny catalog ──────────────────────────────────────────────────────────
//
// The tutorial's three callouts plus one the fixture pack never scripts, so
// the summary has a deliberate "no script" skip to count. The vocabulary has
// one of each kind, and the var's description names a clip group — the
// heuristic that excuses a var-driven group's bases from the orphan rule.

function contract(id: string, overrides: Partial<ContractReport> = {}): ContractReport {
  return {
    id,
    event: "flag.green.raised",
    description: "Fires.",
    frame: "radio",
    family: null,
    weight: 100,
    queueable: false,
    interrupt: false,
    base: null,
    ...overrides,
  };
}

const CONTRACTS: readonly ContractReport[] = [
  contract("pit-crew.flag-green"),
  contract("pit-crew.pit-window-opened", { frame: "none" }),
  contract("pit-crew.damage-repair-needed"),
  contract("pit-crew.position-gained"),
];

const VOCABULARY: VocabularyReport = {
  vars: [
    {
      name: "position.number",
      description: "The car's position as a number, from the position-number clip group (position-number/4 is P4).",
    },
  ],
  conds: [{ name: "session.isRace", description: "The current session is a race." }],
  cases: [
    { name: "damage.severity", description: "How bad the damage is.", keys: { light: "Light.", heavy: "Heavy." } },
  ],
};

/**
 * The compile the linter is handed — in the plugin, `engine.compileScript`;
 * here the same pure compiler over deps built from the fixture catalog, the
 * shape the engine's private `compileDeps()` produces (inert resolvers:
 * nothing fires under a lint, existence is all a compile checks).
 */
const DEPS: CompileDeps = {
  contracts: new Map(CONTRACTS.map((c) => [c.id, { frame: c.frame }])),
  vars: new Set(VOCABULARY.vars.map((v) => v.name)),
  conds: new Map(VOCABULARY.conds.map((c) => [c.name, () => false])),
  cases: new Map(VOCABULARY.cases.map((c) => [c.name, { resolve: () => null, keys: new Set(Object.keys(c.keys)) }])),
  legacyPools: new Set(),
};

const compile = (script: CalloutScript) => compileVoiceScript(script, DEPS);

/** The plugin's built-ins as its manifest lists them — the frame's tick paths are checked against these. */
const SHARED_CLIPS = ["sfx/IRD-ambient-pit.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-tick-open.mp3"];

/** The voice id the plugin's own bundle provides; a pack declaring it has that voice dropped. */
const BUNDLED_VOICE_IDS = ["default"];

// ─── The fixture pack ────────────────────────────────────────────────────────

const PACK_DIR = "/packs/demo";
const PACK_DIR_NAME = "demo";
const VOICE = "demo";

const MANIFEST = JSON.stringify({
  schema: 1,
  id: "demo",
  label: "Demo",
  version: "1.0.0",
  voices: [{ id: VOICE, label: "Demo voice" }],
});

const SCRIPT = {
  schema: 1,
  scenarios: {
    "pit-crew.flag-green": { comment: "Green.", test: "Flags → Green.", sequence: ["pool:flags/green"] },
    "pit-crew.pit-window-opened": {
      comment: "Window open.",
      test: "Pit → Window.",
      sequence: [{ if: "session.isRace", then: ["pool:pit-window/open"] }],
    },
    "pit-crew.damage-repair-needed": {
      comment: "Damage.",
      test: "Damage → Heavy.",
      sequence: [{ case: "damage.severity", of: { heavy: ["pool:damage/repair"], default: [] } }],
    },
  },
  frames: { radio: { open: [{ clip: "sfx/IRD-tick-open.mp3" }], close: [] } },
  pools: {},
  fragments: {},
};

const CLIPS = [
  `voice/${VOICE}/flags/green-01.mp3`,
  `voice/${VOICE}/flags/green-02.mp3`,
  `voice/${VOICE}/pit-window/open-01.mp3`,
  `voice/${VOICE}/damage/repair-01.mp3`,
];

/** A pack as files: POSIX paths relative to the pack folder → text (clips carry a placeholder). */
type Files = Readonly<Record<string, string>>;

function packFiles(overrides: { manifest?: string | null; script?: unknown | null; clips?: readonly string[] }): Files {
  const files: Record<string, string> = {};
  const manifest = overrides.manifest === undefined ? MANIFEST : overrides.manifest;
  const script = overrides.script === undefined ? SCRIPT : overrides.script;

  if (manifest !== null) files["voice-pack.json"] = manifest;

  if (script !== null)
    files[`voice/${VOICE}/callouts.json`] = typeof script === "string" ? script : JSON.stringify(script);

  for (const clip of overrides.clips ?? CLIPS) files[clip] = "<mp3>";

  return files;
}

/** A file whose text is this marker is present but unreadable — the port answers `{ ok: false, missing: false }` for it. */
const UNREADABLE = "<locked>";

/** The scanner's three operations over a map of files; nothing here touches a disk. */
function memoryFs(files: Files): LintPackFileSystem {
  const relative = (path: string): string => path.slice(PACK_DIR.length + 1);
  const within = (dir: string): string[] => {
    const prefix = dir === PACK_DIR ? "" : `${relative(dir)}/`;

    return Object.keys(files)
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
  };

  return {
    listDirectories: (dir) => [...new Set(within(dir).flatMap((f) => (f.includes("/") ? [f.split("/")[0]] : [])))],
    readTextFile: (file) => {
      const text = files[relative(file)];

      if (text === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (text === UNREADABLE) return { ok: false, missing: false, reason: "EBUSY" };

      return { ok: true, text };
    },
    listMp3Files: (dir) => within(dir).filter((f) => /\.mp3$/i.test(f)),
  };
}

function lint(files: Files, overrides: Partial<Omit<LintPackInput, "fs" | "packDir">> = {}) {
  return lintPack({
    packDir: PACK_DIR,
    packDirName: PACK_DIR_NAME,
    fs: memoryFs(files),
    contracts: CONTRACTS,
    vocabulary: VOCABULARY,
    compile,
    sharedClips: SHARED_CLIPS,
    bundledVoiceIds: BUNDLED_VOICE_IDS,
    pluginPlayedBases: [],
    ...overrides,
  });
}

const messages = (problems: readonly LintProblem[]) =>
  problems.map((p) => `${p.voice ?? "(pack)"} ${p.kind}: ${p.message}`);

// ─── The cases ───────────────────────────────────────────────────────────────

describe("lintPack", () => {
  it("passes a clean three-callout pack, counting the fourth contract as a deliberate skip", () => {
    const report = lint(packFiles({}));

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.voices).toEqual([
      { id: VOICE, status: "linted", scripted: 3, total: 4, skipped: ["pit-crew.position-gained"] },
    ]);
  });

  it("names a referenced base the pack does not ship — the typo'd pool", () => {
    const script = structuredClone(SCRIPT);
    script.scenarios["pit-crew.flag-green"].sequence = ["pool:flags/gren"];

    const report = lint(packFiles({ script }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} dangling: "flags/gren" is referenced but the pack ships no voice/${VOICE}/flags/gren*.mp3 — a required step that resolves to nothing aborts the whole callout at fire time`,
      `${VOICE} orphan: "flags/green" is shipped as voice/${VOICE}/flags/green*.mp3 but nothing in the script references it — it never plays`,
    ]);
    expect(report.ok).toBe(false);
  });

  // A frame's built-in paths used to be skipped unread; a misspelled tick
  // linted clean and aborted every framed callout at fire time.
  it("names a built-in the plugin does not ship — the misspelled tick in a frame", () => {
    const script = structuredClone(SCRIPT);
    script.frames.radio.open = [{ clip: "sfx/IRD-tick-opne.mp3" }];

    const report = lint(packFiles({ script }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} dangling: literal "sfx/IRD-tick-opne.mp3" names a built-in clip the plugin does not ship — a step that resolves to nothing aborts the callout at fire time, and in a frame every callout it wraps`,
    ]);
    // The right path, with or without the leading-slash escape, is not a finding.
    script.frames.radio.open = [{ clip: "/sfx/IRD-tick-open.mp3" }];
    expect(lint(packFiles({ script })).problems).toEqual([]);
  });

  // An alias no step names used to count as a reference on its own, which
  // hid the orphan its source had become.
  it("names a pools alias nothing uses, and still reports its source — as an orphan when shipped, as dangling when not", () => {
    const script = structuredClone(SCRIPT) as typeof SCRIPT & { pools: Record<string, unknown> };
    script.pools = {
      "flag-green": { group: "flags", base: "green", comment: "the entry names flags/green directly now" },
      "flag-red": { group: "flags", base: "red", comment: "nothing names this, and red was never recorded" },
    };

    const report = lint(packFiles({ script }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} dangling: "flags/red" is referenced but the pack ships no voice/${VOICE}/flags/red*.mp3 — a required step that resolves to nothing aborts the whole callout at fire time`,
      `${VOICE} orphan: pool alias "flag-green" is defined but nothing uses it — a name that decides nothing`,
      `${VOICE} orphan: pool alias "flag-red" is defined but nothing uses it — a name that decides nothing`,
    ]);

    // Used by an entry, the alias is a reference like any other and its source is no orphan.
    script.scenarios["pit-crew.flag-green"].sequence = ["pool:flag-green"];
    delete script.pools["flag-red"];
    expect(lint(packFiles({ script })).problems).toEqual([]);
  });

  it("compiles every linted voice through the injected compile — the engine's own, in the plugin", () => {
    const seen: CalloutScript[] = [];
    const report = lint(packFiles({}), {
      compile: (script) => {
        seen.push(script);

        return compile(script);
      },
    });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].scenarios)).toEqual(Object.keys(SCRIPT.scenarios));
    expect(report.voices[0]).toMatchObject({ status: "linted", scripted: 3 });
  });

  it("names a shipped clip nothing references — the orphan — and excuses a group a var draws from", () => {
    const report = lint(
      packFiles({ clips: [...CLIPS, `voice/${VOICE}/flags/blue-01.mp3`, `voice/${VOICE}/position-number/4.mp3`] }),
    );

    expect(messages(report.problems)).toEqual([
      `${VOICE} orphan: "flags/blue" is shipped as voice/${VOICE}/flags/blue*.mp3 but nothing in the script references it — it never plays`,
    ]);
  });

  it("reports every skip the pack did not mean, with the compiler's reason", () => {
    const script = structuredClone(SCRIPT);
    script.scenarios["pit-crew.flag-green"].sequence = ["{{position.numbr}}", "pool:flags/green"];

    const report = lint(packFiles({ script }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} callout: "pit-crew.flag-green" is skipped — unknown var "position.numbr"`,
    ]);
    expect(report.voices[0]).toMatchObject({ scripted: 2, skipped: ["pit-crew.position-gained"] });
  });

  it("counts a skip: true entry as deliberate — listed in the summary, never a problem", () => {
    const script = structuredClone(SCRIPT);
    (script.scenarios as Record<string, unknown>)["pit-crew.flag-green"] = { skip: true };

    const report = lint(packFiles({ script, clips: CLIPS.filter((clip) => !clip.includes("/flags/")) }));

    expect(report.problems).toEqual([]);
    expect(report.voices[0]).toMatchObject({
      scripted: 2,
      skipped: ["pit-crew.flag-green", "pit-crew.position-gained"],
    });
  });

  it("reports a voice with no callouts.json as clips-only — every callout skipped", () => {
    const report = lint(packFiles({ script: null }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} script: no voice/${VOICE}/callouts.json — a clips-only voice: every callout is skipped in it, and the plugin shows the missing-script banner when it is selected`,
    ]);
    expect(report.voices).toEqual([
      { id: VOICE, status: "clips-only", scripted: 0, total: 4, skipped: CONTRACTS.map((c) => c.id).sort() },
    ]);
  });

  it("reports a malformed callouts.json as the grammar's problems, and compiles nothing", () => {
    const report = lint(packFiles({ script: '{"schema": 1, "scenarios": {' }));

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ voice: VOICE, kind: "script" });
    expect(report.problems[0].message).toMatch(/^voice\/demo\/callouts\.json — \(document\): not valid JSON/);
    expect(report.voices).toEqual([
      { id: VOICE, status: "broken-script", scripted: 0, total: 4, skipped: CONTRACTS.map((c) => c.id).sort() },
    ]);
  });

  it("reports a callouts.json larger than the scanner reads, unparsed — the plugin refuses it and drops the voice", () => {
    // Exactly the scanner's boundary: one code unit over 1 MiB, in an
    // otherwise perfect script (padding inside a comment keeps it valid JSON).
    const script = structuredClone(SCRIPT) as typeof SCRIPT & { scenarios: Record<string, { comment: string }> };
    const text = JSON.stringify(script);
    script.scenarios["pit-crew.flag-green"].comment += "x".repeat(1024 * 1024 + 1 - text.length);

    const atLimit = JSON.stringify(structuredClone(script));
    expect(atLimit.length).toBe(1024 * 1024 + 1);

    const report = lint(packFiles({ script: atLimit }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} script: voice/${VOICE}/callouts.json is larger than 1048576 bytes — the plugin refuses it before it is parsed and drops the voice`,
    ]);
    expect(report.voices[0]).toMatchObject({ status: "broken-script", scripted: 0 });

    // One code unit shorter is read and compiles clean.
    const underLimit = JSON.stringify({
      ...script,
      scenarios: {
        ...script.scenarios,
        "pit-crew.flag-green": {
          ...script.scenarios["pit-crew.flag-green"],
          comment: script.scenarios["pit-crew.flag-green"].comment.slice(1),
        },
      },
    });
    expect(underLimit.length).toBe(1024 * 1024);
    expect(lint(packFiles({ script: underLimit })).problems).toEqual([]);
  });

  it("reports a callouts.json that exists but cannot be read — broken-script, every callout skipped", () => {
    const report = lint(packFiles({ script: UNREADABLE }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} script: voice/${VOICE}/callouts.json could not be read (EBUSY)`,
    ]);
    expect(report.voices).toEqual([
      { id: VOICE, status: "broken-script", scripted: 0, total: 4, skipped: CONTRACTS.map((c) => c.id).sort() },
    ]);
  });

  it("reports a manifest that exists but cannot be read, then scans voice/*/", () => {
    const report = lint(packFiles({ manifest: UNREADABLE }));

    expect(messages(report.problems)).toEqual([
      "(pack) manifest: voice-pack.json could not be read (EBUSY); the voices under voice/ were linted anyway",
    ]);
    expect(report.voices.map((v) => v.id)).toEqual([VOICE]);
  });

  it("never calls a clip plugin code plays by path an orphan — by exact base, or every base of a group — and holds the rest to the rule", () => {
    const files = packFiles({
      clips: [
        ...CLIPS,
        `voice/${VOICE}/names/dave.mp3`,
        `voice/${VOICE}/toggle/radio-check-01.mp3`,
        `voice/${VOICE}/toggle/radio-chek-01.mp3`,
      ],
    });

    expect(messages(lint(files).problems)).toEqual([
      `${VOICE} orphan: "names/dave" is shipped as voice/${VOICE}/names/dave*.mp3 but nothing in the script references it — it never plays`,
      `${VOICE} orphan: "toggle/radio-check" is shipped as voice/${VOICE}/toggle/radio-check*.mp3 but nothing in the script references it — it never plays`,
      `${VOICE} orphan: "toggle/radio-chek" is shipped as voice/${VOICE}/toggle/radio-chek*.mp3 but nothing in the script references it — it never plays`,
    ]);
    // The list names CLIPS: the misspelled sibling in the same group is still an orphan.
    expect(messages(lint(files, { pluginPlayedBases: ["names/*", "toggle/radio-check"] }).problems)).toEqual([
      `${VOICE} orphan: "toggle/radio-chek" is shipped as voice/${VOICE}/toggle/radio-chek*.mp3 but nothing in the script references it — it never plays`,
    ]);
    // A group wildcard excuses every base of that group and nothing outside it.
    expect(messages(lint(files, { pluginPlayedBases: ["toggle/*"] }).problems)).toEqual([
      `${VOICE} orphan: "names/dave" is shipped as voice/${VOICE}/names/dave*.mp3 but nothing in the script references it — it never plays`,
    ]);
  });

  it("reports a defined fragment nothing includes, and a frame that fails to compile, once each", () => {
    const script = structuredClone(SCRIPT) as unknown as {
      frames: Record<string, { open: unknown[]; close: unknown[] }>;
      fragments: Record<string, { sequence: unknown[] }>;
    };
    script.fragments = { tail: { sequence: ["pool:flags/green"] } };
    script.frames.radio = { open: ["{{no.such.var}}"], close: [] };

    const report = lint(packFiles({ script }));

    expect(messages(report.problems)).toEqual([
      `${VOICE} callout: "pit-crew.damage-repair-needed" is skipped — frame "radio": unknown var "no.such.var"`,
      `${VOICE} callout: "pit-crew.flag-green" is skipped — frame "radio": unknown var "no.such.var"`,
      `${VOICE} frame: "radio" does not compile — unknown var "no.such.var" — every callout framed by it is skipped`,
      `${VOICE} fragment: "tail" is defined but nothing includes it — a fragment nothing includes is checked by nobody`,
    ]);
  });

  it("falls back to scanning voice/*/ when the manifest is missing, and says so", () => {
    const report = lint(packFiles({ manifest: null }));

    expect(messages(report.problems)).toEqual([
      "(pack) manifest: voice-pack.json is missing — the plugin will not see this folder as a pack; the voices under voice/ were linted anyway",
    ]);
    expect(report.voices.map((v) => v.id)).toEqual([VOICE]);
  });

  it("reports a manifest that is not valid JSON, and one whose voices carry no ids, then scans voice/*/", () => {
    expect(messages(lint(packFiles({ manifest: "{" })).problems)[0]).toMatch(
      /^\(pack\) manifest: voice-pack\.json is not valid JSON: /,
    );

    const noIds = lint(
      packFiles({
        manifest: JSON.stringify({ schema: 1, id: "demo", label: "Demo", version: "1.0.0", voices: "demo" }),
      }),
    );

    expect(messages(noIds.problems)).toEqual([
      "(pack) manifest: voice-pack.json has no voices[].id list — the plugin reads the voices from it; the voices under voice/ were linted anyway",
    ]);
    expect(noIds.voices.map((v) => v.id)).toEqual([VOICE]);
  });

  it("keeps the per-entry problems when EVERY declared id is unusable, then scans voice/*/ — never the generic message", () => {
    const report = lint(
      packFiles({
        manifest: JSON.stringify({
          schema: 1,
          id: "demo",
          label: "Demo",
          version: "1.0.0",
          voices: [{ id: "MyVoice", label: "My Voice" }],
        }),
      }),
    );

    expect(messages(report.problems)).toEqual([
      `(pack) manifest: voice-pack.json: voices[0].id "MyVoice" is not lowercase kebab-case (a-z, 0-9, dashes) — the plugin refuses the manifest; the voices under voice/ were linted anyway`,
    ]);
    expect(report.voices.map((v) => v.id)).toEqual([VOICE]);
  });

  // The rest of the manifest is deck-core's schema to validate in full; these
  // are the fields the plugin refuses a pack over that the linter can read
  // as plain JSON, each in the scanner's own terms.
  it("reports a manifest the scanner would refuse: schema, id, label, version, a voice without a label", () => {
    const report = lint(
      packFiles({
        manifest: JSON.stringify({
          schema: 2,
          id: "other-pack",
          label: "",
          version: "1.0",
          voices: [{ id: VOICE }],
        }),
      }),
    );

    expect(messages(report.problems)).toEqual([
      "(pack) manifest: voice-pack.json: schema must be the number 1 (got 2) — the plugin refuses the manifest",
      `(pack) manifest: voice-pack.json: id "other-pack" does not match the pack folder name "${PACK_DIR_NAME}" — the plugin refuses the pack`,
      "(pack) manifest: voice-pack.json: label must be a non-empty string of at most 60 characters — the plugin refuses the manifest",
      '(pack) manifest: voice-pack.json: version "1.0" is not a semver version (major.minor.patch) — the plugin refuses the manifest',
      "(pack) manifest: voice-pack.json: voices[0] has no label — the plugin refuses the manifest",
    ]);
    // The voice itself is still linted, so the author gets the clip and script feedback too.
    expect(report.voices).toEqual([
      { id: VOICE, status: "linted", scripted: 3, total: 4, skipped: ["pit-crew.position-gained"] },
    ]);
  });

  it("reports a manifest missing its schema, id, label or version, and an id that is not kebab-case", () => {
    const report = lint(packFiles({ manifest: JSON.stringify({ voices: [{ id: VOICE, label: "Demo voice" }] }) }));

    expect(messages(report.problems)).toEqual([
      "(pack) manifest: voice-pack.json: schema is missing — must be the number 1; the plugin refuses the manifest",
      "(pack) manifest: voice-pack.json: id is missing — the plugin refuses the manifest",
      "(pack) manifest: voice-pack.json: label must be a non-empty string of at most 60 characters — the plugin refuses the manifest",
      "(pack) manifest: voice-pack.json: version is missing — the plugin refuses the manifest",
    ]);

    // The folder is `Demo/` on disk: the scanner compares case-insensitively, and the id rule is what refuses the capital.
    const capital = lint(
      packFiles({ manifest: JSON.stringify({ schema: 1, id: "Demo", label: "Demo", version: "1.0.0", voices: [] }) }),
      { packDirName: "Demo" },
    );

    expect(messages(capital.problems)).toEqual([
      '(pack) manifest: voice-pack.json: id "Demo" is not lowercase kebab-case (a-z, 0-9, dashes) — the plugin refuses the manifest',
      "(pack) manifest: voice-pack.json has no voices[].id list — the plugin reads the voices from it; the voices under voice/ were linted anyway",
    ]);
  });

  it("accepts a pack whose folder differs from its id only in case, as the scanner does", () => {
    expect(lint(packFiles({}), { packDirName: "DEMO" }).problems).toEqual([]);
  });

  it("reports a voice id the plugin's bundled audio already provides — the plugin drops that voice", () => {
    const manifest = JSON.stringify({
      schema: 1,
      id: "demo",
      label: "Demo",
      version: "1.0.0",
      voices: [
        { id: VOICE, label: "Demo voice" },
        { id: "default", label: "A second default" },
      ],
    });
    const report = lint(packFiles({ manifest, clips: [...CLIPS, "voice/default/flags/green-01.mp3"] }));

    expect(messages(report.problems)).toEqual([
      '(pack) manifest: voice-pack.json: voices[1].id "default" is provided by the plugin\'s bundled audio — the plugin drops the voice',
      "default script: no voice/default/callouts.json — a clips-only voice: every callout is skipped in it, and the plugin shows the missing-script banner when it is selected",
    ]);
    expect(report.voices.map((v) => v.id)).toEqual([VOICE, "default"]);
  });

  it("reports a declared id the plugin would refuse, or one that is not a string, and lints the rest", () => {
    const manifest = JSON.stringify({
      schema: 1,
      id: "demo",
      label: "Demo",
      version: "1.0.0",
      voices: [{ id: VOICE, label: "Demo voice" }, { id: "../Evil", label: "Evil" }, { label: "Nameless" }],
    });
    const report = lint(packFiles({ manifest }));

    expect(messages(report.problems)).toEqual([
      `(pack) manifest: voice-pack.json: voices[1].id "../Evil" is not lowercase kebab-case (a-z, 0-9, dashes) — the plugin refuses the manifest`,
      "(pack) manifest: voice-pack.json: voices[2] has no string id — the plugin refuses the manifest",
    ]);
    expect(report.voices.map((v) => v.id)).toEqual([VOICE]);
  });

  it("reports a declared voice with nothing to play, and a voice folder the manifest does not declare", () => {
    const manifest = JSON.stringify({
      schema: 1,
      id: "demo",
      label: "Demo",
      version: "1.0.0",
      voices: [
        { id: VOICE, label: "Demo voice" },
        { id: "ghost", label: "Ghost" },
      ],
    });
    const report = lint(packFiles({ manifest, clips: [...CLIPS, "voice/stray/flags/green-01.mp3"] }));

    expect(messages(report.problems)).toEqual([
      "(pack) manifest: voice/stray/ exists but voice-pack.json does not declare it — the plugin ignores it",
      "ghost clips: no clips under voice/ghost/ — the plugin drops the voice",
    ]);
    expect(report.voices.map((v) => [v.id, v.status])).toEqual([
      [VOICE, "linted"],
      ["ghost", "dropped"],
    ]);
    expect(report.voices[1].skipped).toEqual(CONTRACTS.map((c) => c.id).sort());
  });

  it("reports a file under the voice the engine cannot play — the wrong depth, or an upper-case extension", () => {
    const report = lint(
      packFiles({ clips: [...CLIPS, `voice/${VOICE}/loose.mp3`, `voice/${VOICE}/flags/yellow-01.MP3`] }),
    );

    expect(messages(report.problems)).toEqual([
      `${VOICE} clips: voice/${VOICE}/flags/yellow-01.MP3 is not voice/${VOICE}/<group>/<name>.mp3 (lowercase .mp3) — the engine cannot play it`,
      `${VOICE} clips: voice/${VOICE}/loose.mp3 is not voice/${VOICE}/<group>/<name>.mp3 (lowercase .mp3) — the engine cannot play it`,
    ]);
  });
});

describe("formatLintReport", () => {
  it("groups the problems by voice, pack-level first, then one summary line per voice", () => {
    const script = structuredClone(SCRIPT);
    script.scenarios["pit-crew.flag-green"].sequence = ["pool:flags/gren"];

    const lines = formatLintReport(lint(packFiles({ script, manifest: null })));

    expect(lines).toEqual([
      "pack:",
      "  manifest: voice-pack.json is missing — the plugin will not see this folder as a pack; the voices under voice/ were linted anyway",
      "",
      "voice demo:",
      `  dangling: "flags/gren" is referenced but the pack ships no voice/demo/flags/gren*.mp3 — a required step that resolves to nothing aborts the whole callout at fire time`,
      `  orphan: "flags/green" is shipped as voice/demo/flags/green*.mp3 but nothing in the script references it — it never plays`,
      "",
      "demo: 3 of 4 callouts scripted; skipped: 1",
      "  pit-crew.position-gained",
      "",
      "3 problems",
    ]);
  });

  it("prints the summary alone for a clean pack", () => {
    expect(formatLintReport(lint(packFiles({})))).toEqual([
      "demo: 3 of 4 callouts scripted; skipped: 1",
      "  pit-crew.position-gained",
      "",
      "No problems",
    ]);
  });

  it("wraps a long skip list into indented lines no wider than the summary width, and says none when empty", () => {
    const skipped = Array.from({ length: 40 }, (_, i) => `pit-crew.callout-number-${String(i).padStart(2, "0")}`);
    const report: LintReport = {
      ok: true,
      problems: [],
      voices: [
        { id: "many", status: "linted", scripted: 109, total: 149, skipped },
        { id: "all", status: "linted", scripted: 149, total: 149, skipped: [] },
      ],
    };

    const lines = formatLintReport(report);
    const block = lines.slice(1, lines.indexOf("all: 149 of 149 callouts scripted; skipped: none"));

    expect(lines[0]).toBe("many: 109 of 149 callouts scripted; skipped: 40");
    expect(block.length).toBeGreaterThan(1);
    expect(block.every((line) => line.startsWith("  ") && line.length <= SUMMARY_WIDTH)).toBe(true);
    // Nothing lost and nothing reordered in the wrapping.
    expect(
      block
        .join(" ")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    ).toEqual(skipped);
    expect(lines.at(-1)).toBe("No problems");
  });
});
