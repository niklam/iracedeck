// The pack linter and the plugin's scanner refuse the same packs (#1134).
//
// `lint:pack` exists to tell an author, before they install, what the scanner
// will do with their pack. Until #1134 it restated the scanner's rules as
// plain-JSON checks — the manifest schema, the id-vs-folder rule, the usable
// clip grammar, the script size cap — and nothing held the copies to the
// originals: the linter's semver regex refused a `v1.2.3` the scanner
// accepted, and a scanner change would have made the linter lie in silence.
// The rules now live once, in `@iracedeck/callout-script`'s `voice-pack.ts`;
// this test is the claim itself, stated over packs rather than over rules, so
// it holds whichever file a future rule lands in.
//
// Both are imported from SOURCE by path, the way `website-device-list.test.mjs`
// reaches deck-core: the scanner module, not deck-core's barrel (which would
// pull in far more than a scan), and `lint-pack.ts`, not the audio-scenarios
// barrel. One in-memory filesystem serves both — the two ports are the same
// three operations.
//
// The verdicts compared: the scanner REFUSES when it reports any problem for
// the pack's folder (a refused manifest, a dropped voice, a repeated voice); the
// linter refuses when it reports a problem of kind `manifest`, `clips` or
// `script` that the scanner would also act on. Three linter findings are the
// linter's alone, by design, and each has its own case below rather than
// hiding inside the predicate:
//
// - a clips-only voice (no `callouts.json`) — valid to the plugin, silent for
//   every callout, so the linter says so;
// - an unplayable file beside playable ones in the same voice — the scanner
//   drops the file quietly and loads the voice, and the website's format page
//   names `lint:pack` as the one place that says so;
// - a folder under `voice/` the manifest does not declare — the scanner never
//   looks at it.
//
// Every case states its expected verdict, and BOTH sides are held to it, so a
// case both sides got wrong the same way still fails — agreement alone is not
// the claim.
import { VOICE_SCRIPT_MAX_BYTES } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import { lintPack } from "../../packages/audio-scenarios/src/reference/lint-pack.ts";
import { scanVoicePacks } from "../../packages/deck-core/src/voice-pack-scanner.ts";

const ROOT = "/packs";
const FOLDER = "demo";
const VOICE = "demo";

const MANIFEST = Object.freeze({
  schema: 1,
  id: "demo",
  label: "Demo",
  version: "1.0.0",
  voices: [{ id: VOICE, label: "Demo voice" }],
});

const SCRIPT = JSON.stringify({ schema: 1, scenarios: {}, frames: {}, pools: {} });

const CLIPS = [`voice/${VOICE}/flags/green-01.mp3`, `voice/${VOICE}/flags/green-02.mp3`];

/** A file whose text is this marker exists but cannot be read — both ports answer `{ ok: false, missing: false }`. */
const UNREADABLE = "<locked>";

/** The manifest with `changes` applied; a key set to `undefined` is left out of the file. */
const manifest = (changes) => JSON.stringify({ ...MANIFEST, ...changes });

/**
 * One pack folder under {@link ROOT} as files: `manifest` is the file's text
 * (`null` for none), `scripts` maps a voice id to its `callouts.json` text,
 * `clips` are pack-relative paths.
 */
function pack({
  folder = FOLDER,
  manifest: text = JSON.stringify(MANIFEST),
  clips = CLIPS,
  scripts = { [VOICE]: SCRIPT },
} = {}) {
  const dir = `${ROOT}/${folder}`;
  const files = {};

  if (text !== null) files[`${dir}/voice-pack.json`] = text;

  for (const [voice, script] of Object.entries(scripts)) files[`${dir}/voice/${voice}/callouts.json`] = script;

  for (const clip of clips) files[`${dir}/${clip}`] = "<mp3>";

  return { folder, files };
}

/**
 * The three port operations over a map of absolute POSIX paths. The scanner
 * joins with `node:path`, which writes backslashes on Windows, so every path
 * asked for is normalised first; the linter already speaks POSIX.
 */
function memoryFs(files) {
  const norm = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const under = (dir) => {
    const prefix = `${norm(dir)}/`;

    return Object.keys(files)
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
  };

  return {
    listDirectories: (dir) => [
      ...new Set(under(dir).flatMap((file) => (file.includes("/") ? [file.split("/")[0]] : []))),
    ],
    readTextFile: (file) => {
      const text = files[norm(file)];

      if (text === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (text === UNREADABLE) return { ok: false, missing: false, reason: "EBUSY" };

      return { ok: true, text };
    },
    listMp3Files: (dir) => under(dir).filter((file) => /\.mp3$/i.test(file)),
  };
}

/** What the engine's compile returns for a script with nothing in it — the linter's verdicts here never reach it. */
const EMPTY_COMPILE = {
  scenarios: new Map(),
  frames: new Map(),
  failedFrames: new Map(),
  pools: new Map(),
  skipped: [],
  fragmentProblems: new Map(),
};

function scan({ folder, files }) {
  return scanVoicePacks({ root: ROOT, fs: memoryFs(files) }).problems.filter((problem) => problem.pack === folder);
}

function lint({ folder, files }) {
  return lintPack({
    packDir: `${ROOT}/${folder}`,
    packDirName: folder,
    fs: memoryFs(files),
    contracts: [],
    vocabulary: { vars: [], conds: [], cases: [] },
    compile: () => EMPTY_COMPILE,
    sharedClips: [],
    pluginPlayedBases: [],
  });
}

const UNDECLARED_FOLDER = /^voice\/[^/]+\/ exists but voice-pack\.json does not declare it/;

/**
 * The linter's problems the scanner would also act on: every manifest problem
 * but an undeclared folder, a clips problem only for a voice the linter
 * DROPPED (a stray file beside playable clips is the linter's alone), a script
 * problem only for a voice whose script it could not use (a clips-only voice
 * is valid to the plugin). Orphans, dangling references and compile findings
 * are the linter's own subject and are never compared.
 */
function refusals(report) {
  const status = new Map(report.voices.map((voice) => [voice.id, voice.status]));

  return report.problems.filter((problem) => {
    if (problem.kind === "manifest") return !UNDECLARED_FOLDER.test(problem.message);

    if (problem.kind === "clips") return status.get(problem.voice) === "dropped";

    if (problem.kind === "script") return status.get(problem.voice) === "broken-script";

    return false;
  });
}

// ─── The fixtures ────────────────────────────────────────────────────────────

const ACCEPTED = [
  ["a valid pack", pack()],
  ["a folder that differs from the id only in case", pack({ folder: "Demo" })],
  ["a version with a leading v", pack({ manifest: manifest({ version: "v1.0.0" }) })],
  ["a version with surrounding whitespace", pack({ manifest: manifest({ version: " 1.0.0 " }) })],
  ["a pre-release and build version", pack({ manifest: manifest({ version: "1.0.0-rc.1+build.01" }) })],
  ["an author", pack({ manifest: manifest({ author: "Somebody" }) })],
  ["an unknown top-level key", pack({ manifest: manifest({ homepage: "https://example.invalid" }) })],
  ["a manifest with a leading BOM", pack({ manifest: `\ufeff${JSON.stringify(MANIFEST)}` })],
  ["a label of exactly 60 characters", pack({ manifest: manifest({ label: "x".repeat(60) }) })],
  ["a script of exactly the size cap", pack({ scripts: { [VOICE]: SCRIPT.padEnd(VOICE_SCRIPT_MAX_BYTES) } })],
];

const REFUSED = [
  ["no manifest", pack({ manifest: null })],
  ["a manifest that cannot be read", pack({ manifest: UNREADABLE })],
  ["a manifest that is not JSON", pack({ manifest: "{" })],
  ["a manifest that is an array", pack({ manifest: "[]" })],
  ["a manifest that is null", pack({ manifest: "null" })],
  ["no schema", pack({ manifest: manifest({ schema: undefined }) })],
  ["schema 0", pack({ manifest: manifest({ schema: 0 }) })],
  ["schema 2 (a newer pack)", pack({ manifest: manifest({ schema: 2 }) })],
  ["schema as a string", pack({ manifest: manifest({ schema: "1" }) })],
  ["no id", pack({ manifest: manifest({ id: undefined }) })],
  ["an id that is not kebab-case", pack({ folder: "My-Pack", manifest: manifest({ id: "My-Pack" }) })],
  ["an id holding the separator", pack({ manifest: manifest({ id: "demo::x" }) })],
  ["an id that differs from its folder", pack({ manifest: manifest({ id: "other" }) })],
  ["no label", pack({ manifest: manifest({ label: undefined }) })],
  ["an empty label", pack({ manifest: manifest({ label: "" }) })],
  ["a label of 61 characters", pack({ manifest: manifest({ label: "x".repeat(61) }) })],
  ["a label holding a newline", pack({ manifest: manifest({ label: "De\nmo" }) })],
  ["no version", pack({ manifest: manifest({ version: undefined }) })],
  ["a two-part version", pack({ manifest: manifest({ version: "1.0" }) })],
  ["a version with a leading zero", pack({ manifest: manifest({ version: "01.0.0" }) })],
  ["a version with a capital V", pack({ manifest: manifest({ version: "V1.0.0" }) })],
  ["an empty author", pack({ manifest: manifest({ author: "" }) })],
  ["no voices", pack({ manifest: manifest({ voices: undefined }) })],
  ["an empty voices list", pack({ manifest: manifest({ voices: [] }) })],
  ["voices as a string", pack({ manifest: manifest({ voices: VOICE }) })],
  ["a voice with no label", pack({ manifest: manifest({ voices: [{ id: VOICE }] }) })],
  [
    "a voice with no id",
    pack({ manifest: manifest({ voices: [{ id: VOICE, label: "Demo voice" }, { label: "Nameless" }] }) }),
  ],
  [
    "a voice id that is not kebab-case",
    pack({
      manifest: manifest({
        voices: [
          { id: VOICE, label: "Demo voice" },
          { id: "../Evil", label: "Evil" },
        ],
      }),
    }),
  ],
  [
    "a voice id holding the separator",
    pack({
      manifest: manifest({
        voices: [
          { id: VOICE, label: "Demo voice" },
          { id: "a::b", label: "A B" },
        ],
      }),
    }),
  ],
  [
    "a voice declared twice",
    pack({
      manifest: manifest({
        voices: [
          { id: VOICE, label: "Demo voice" },
          { id: VOICE, label: "Again" },
        ],
      }),
    }),
  ],
  [
    "a declared voice with no folder",
    pack({
      manifest: manifest({
        voices: [
          { id: VOICE, label: "Demo voice" },
          { id: "ghost", label: "Ghost" },
        ],
      }),
    }),
  ],
  ["a voice whose only clip has an upper-case extension", pack({ clips: [`voice/${VOICE}/flags/green-01.MP3`] })],
  ["a voice whose only clip is missing its group", pack({ clips: [`voice/${VOICE}/green-01.mp3`] })],
  ["a voice with no clips at all", pack({ clips: [] })],
  [
    "a script one code unit over the size cap",
    pack({ scripts: { [VOICE]: SCRIPT.padEnd(VOICE_SCRIPT_MAX_BYTES + 1) } }),
  ],
  ["a script that is not JSON", pack({ scripts: { [VOICE]: "{nope" } })],
  ["a script the grammar refuses", pack({ scripts: { [VOICE]: JSON.stringify({ schema: 1 }) } })],
  ["a script that cannot be read", pack({ scripts: { [VOICE]: UNREADABLE } })],
];

describe("lint:pack and the scanner refuse the same packs (#1134)", () => {
  it.each(ACCEPTED)("both accept %s", (_name, fixture) => {
    expect(scan(fixture)).toEqual([]);
    expect(refusals(lint(fixture))).toEqual([]);
  });

  it.each(REFUSED)("both refuse %s", (_name, fixture) => {
    expect(scan(fixture)).not.toEqual([]);
    expect(refusals(lint(fixture))).not.toEqual([]);
  });

  // The linter's own findings: the scanner says nothing, the linter says
  // exactly this and refuses nothing. Pinned so the predicate above cannot
  // quietly widen its exemptions.
  describe("the findings that are the linter's alone", () => {
    it("a clips-only voice — no callouts.json", () => {
      const fixture = pack({ scripts: {} });
      const report = lint(fixture);

      expect(scan(fixture)).toEqual([]);
      expect(refusals(report)).toEqual([]);
      expect(report.voices).toMatchObject([{ id: VOICE, status: "clips-only" }]);
      expect(report.problems.filter((problem) => problem.kind === "script")).toHaveLength(1);
    });

    it("an unplayable file beside playable clips", () => {
      const fixture = pack({ clips: [...CLIPS, `voice/${VOICE}/flags/yellow-01.MP3`, `voice/${VOICE}/loose.mp3`] });
      const report = lint(fixture);

      expect(scan(fixture)).toEqual([]);
      expect(refusals(report)).toEqual([]);
      expect(report.problems.filter((problem) => problem.kind === "clips").map((problem) => problem.message)).toEqual([
        `voice/${VOICE}/flags/yellow-01.MP3 is not voice/${VOICE}/<group>/<name>.mp3 (lowercase .mp3) — the engine cannot play it`,
        `voice/${VOICE}/loose.mp3 is not voice/${VOICE}/<group>/<name>.mp3 (lowercase .mp3) — the engine cannot play it`,
      ]);
    });

    it("a voice folder the manifest does not declare", () => {
      const fixture = pack({ clips: [...CLIPS, "voice/stray/flags/green-01.mp3"] });
      const report = lint(fixture);

      expect(scan(fixture)).toEqual([]);
      expect(refusals(report)).toEqual([]);
      expect(report.problems.map((problem) => problem.message)).toContain(
        "voice/stray/ exists but voice-pack.json does not declare it — the plugin ignores it",
      );
    });
  });
});
