# Voice Packs Stage 1: Discovery & Sideloading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Race Engineer voice pack placed by hand in `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\` is discovered, appears in the voice dropdown, and plays — with no plugin restart.

**Architecture:** Each installed pack becomes its own audio root, contributing clips under the same `voice/<id>/…` shape the bundled assets already use, so every downstream consumer (pool regexes, `{voice}` substitution, validation, name scanning) keeps working unchanged. `AudioService` resolves a logical clip path against an ordered root list; the scenario engine's clip set and pools become reloadable; the plugins scan on startup and on demand.

**Tech Stack:** TypeScript, Zod, Vitest, `semver` (already a `deck-core` dependency). No new runtime dependencies in this stage.

**Spec:** `docs/superpowers/specs/2026-08-25-issue-1034-downloadable-voice-packs-design.md`

**Issue:** [#1034](https://github.com/niklam/iRaceDeck/issues/1034). PR targets `master`. This is stage 1 of 3; it does **not** close the issue.

## Global Constraints

- **No network code, no archive handling, no `.install.json` writer in this stage.** Those are stages 2–3. A pack with no `.install.json` is simply a sideloaded pack.
- **Packs root has no ecosystem segment**: `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices`. A voice is content, not user state — unlike the settings store, which is per-ecosystem.
- **Clip paths keep the shape `voice/<voice-id>/<group>/<name>.mp3`.** Nothing downstream may learn a second root exists. If a change requires touching `buildManifestPool`'s regex, `substituteVoice`, `referenceVoice`, `scanRaceEngineerVoices` or `scanDriverNames`, the design is wrong — stop and re-read the spec.
- **Root precedence is plugin-first.** A pack can never shadow bundled sfx or a bundled voice.
- **Every plain-value `GlobalSettingsSchema` field must end in `.catch(<default>)`** (`.claude/rules/global-settings.md`). This stage adds no schema field, only passthrough keys.
- **Exact dependency versions, no `^`/`~`** (`.claude/rules/code-style.md`).
- **All fenced code blocks in markdown carry a language identifier.**
- **Tests are required for all new code** (`.claude/rules/testing.md`); file naming `foo.ts` → `foo.test.ts`.
- Run from the repo root: `pnpm build`, `pnpm lint`, `pnpm format:fix`, `pnpm test`. Never `pnpm --filter <pkg> test` — the per-package test scripts are broken (#1021).

## File Structure

| File | Responsibility |
|---|---|
| `packages/deck-core/src/voice-packs-path.ts` | Resolve the packs root from env. Pure. |
| `packages/deck-core/src/voice-pack-manifest.ts` | Zod schema + parse for `voice-pack.json`. Pure, no I/O. |
| `packages/deck-core/src/voice-pack-scanner.ts` | Turn a packs root into `InstalledVoicePack[]` + problems, via an injected fs port. |
| `packages/deck-core/src/voice-pack-fs.ts` | The `node:fs` implementation of that port. The only file in the feature that touches the disk. |
| `packages/audio-scenarios/src/manifest.ts` | Gains `mergeManifests`. Pure. |
| `packages/audio-scenarios/src/interpreter.ts` | Gains `setManifest` on the engine. |
| `packages/audio-service/src/audio-service.ts` | Ordered roots replacing the single `basePath`; `setRoots`. |
| `packages/deck-core/src/voice-pack-service.ts` | Composition root: scan → roots + merged manifest → apply. One place the three plugins call. |
| `packages/pi-components/partials/race-engineer-settings.ejs` | Installed-voices list + Refresh button (settings window only). |

The scanner is split from the fs port deliberately: the scan logic is then testable with an in-memory fake and has no `vi.mock("node:fs")` anywhere.

---

### Task 1: Packs-root resolution

**Files:**
- Create: `packages/deck-core/src/voice-packs-path.ts`
- Test: `packages/deck-core/src/voice-packs-path.test.ts`
- Modify: `packages/deck-core/src/index.ts` (export)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveVoicePacksPath({ env }: { env: Record<string, string | undefined> }): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { resolveVoicePacksPath } from "./voice-packs-path.js";

describe("resolveVoicePacksPath", () => {
  it("uses LOCALAPPDATA", () => {
    expect(resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" } })).toBe(
      "C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Race Engineer\\Voices",
    );
  });

  it("honours the IRACEDECK_VOICE_PACKS_PATH override", () => {
    expect(
      resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_VOICE_PACKS_PATH: "D:\\packs" } }),
    ).toBe("D:\\packs");
  });

  it("treats a blank LOCALAPPDATA as unset and still returns an absolute path", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "   ", USERPROFILE: "C:\\Users\\n" } });

    expect(resolved).toBe("C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Race Engineer\\Voices");
  });

  it("has no ecosystem segment — packs are shared across plugins", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x" } });

    expect(resolved).not.toMatch(/Stream Deck|Mirabox|Ulanzi/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/voice-packs-path.test.ts`
Expected: FAIL — cannot resolve `./voice-packs-path.js`.

- [ ] **Step 3: Implement**

Mirrors `resolveSettingsStorePath` in `settings-store.ts:41`, including the blank-variable guard and the `homedir()` last resort — deliberately, so the two paths behave identically when the environment is odd.

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolveVoicePacksPathOptions {
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices`, or the full path in
 * `IRACEDECK_VOICE_PACKS_PATH` (development / fresh-install testing).
 *
 * Deliberately NOT per-ecosystem, unlike `resolveSettingsStorePath`: a voice
 * pack is content, not user state, so a user running two plugins holds and
 * downloads one copy rather than two.
 */
export function resolveVoicePacksPath({ env }: ResolveVoicePacksPathOptions): string {
  const override = nonBlank(env.IRACEDECK_VOICE_PACKS_PATH);

  if (override !== undefined) return override;

  const base = nonBlank(env.LOCALAPPDATA) ?? join(nonBlank(env.USERPROFILE) ?? homedir(), "AppData", "Local");

  return join(base, "iRaceDeck", "Race Engineer", "Voices");
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
```

- [ ] **Step 4: Export it**

Add `resolveVoicePacksPath` and `type ResolveVoicePacksPathOptions` to the export block in `packages/deck-core/src/index.ts`, beside the `settings-store.js` exports.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test packages/deck-core/src/voice-packs-path.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/deck-core/src/voice-packs-path.ts packages/deck-core/src/voice-packs-path.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): resolve the Race Engineer voice-packs directory (#1034)"
```

---

### Task 2: `voice-pack.json` schema

**Files:**
- Create: `packages/deck-core/src/voice-pack-manifest.ts`
- Test: `packages/deck-core/src/voice-pack-manifest.test.ts`
- Modify: `packages/deck-core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type VoicePackManifest = { schema: 1; id: string; label: string; version: string; author?: string; voices: string[]; skipped?: string[] }`
  - `parseVoicePackManifest(raw: string): { ok: true; manifest: VoicePackManifest } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

const valid = JSON.stringify({
  schema: 1,
  id: "luca",
  label: "Luca",
  version: "1.2.0",
  author: "iRaceDeck",
  voices: ["luca"],
});

describe("parseVoicePackManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseVoicePackManifest(valid);

    expect(result).toEqual({
      ok: true,
      manifest: { schema: 1, id: "luca", label: "Luca", version: "1.2.0", author: "iRaceDeck", voices: ["luca"] },
    });
  });

  it("accepts a pack declaring several voices", () => {
    const raw = JSON.stringify({ schema: 1, id: "duo", label: "Duo", version: "1.0.0", voices: ["a", "b"] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.voices).toEqual(["a", "b"]);
  });

  it("keeps a skipped list without interpreting it", () => {
    const raw = JSON.stringify({
      schema: 1,
      id: "luca",
      label: "Luca",
      version: "1.0.0",
      voices: ["luca"],
      skipped: ["voice/luca/openers/hi.mp3"],
    });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.skipped).toEqual(["voice/luca/openers/hi.mp3"]);
  });

  it.each([
    ["not json at all", "{nope"],
    ["a future schema version", JSON.stringify({ schema: 2, id: "a", label: "A", version: "1.0.0", voices: ["a"] })],
    ["a non-semver version", JSON.stringify({ schema: 1, id: "a", label: "A", version: "one", voices: ["a"] })],
    ["an id that is not kebab-case", JSON.stringify({ schema: 1, id: "Luca!", label: "A", version: "1.0.0", voices: ["a"] })],
    ["an empty voices list", JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [] })],
  ])("rejects %s", (_label, raw) => {
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/voice-pack-manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import semver from "semver";
import { z } from "zod";

/** Voice and pack ids share the audio-assets kebab-case rule. */
const packId = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

export const VoicePackManifestSchema = z.object({
  // A literal, not a range: an unknown schema means a pack built by a newer
  // toolchain, and guessing at its shape is worse than declining to load it.
  schema: z.literal(1),
  id: packId,
  label: z.string().min(1),
  version: z.string().refine((v) => semver.valid(v) !== null, "must be a valid semver version"),
  author: z.string().min(1).optional(),
  voices: z.array(packId).min(1),
  // Reserved for #1033 (per-entry skip). Parsed and carried so the published
  // pack format is stable before any pack ships; nothing consumes it yet.
  skipped: z.array(z.string()).optional(),
});

export type VoicePackManifest = z.infer<typeof VoicePackManifestSchema>;

export type ParseVoicePackManifestResult =
  | { ok: true; manifest: VoicePackManifest }
  | { ok: false; reason: string };

/**
 * Parse a pack's `voice-pack.json`. Never throws: a pack folder is user-supplied
 * content, so a malformed one is a reportable problem with that pack, not a
 * plugin-startup failure.
 */
export function parseVoicePackManifest(raw: string): ParseVoicePackManifestResult {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = VoicePackManifestSchema.safeParse(json);

  if (!parsed.success) {
    const first = parsed.error.issues[0];

    return { ok: false, reason: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid shape" };
  }

  return { ok: true, manifest: parsed.data };
}
```

- [ ] **Step 4: Export it**

Add `VoicePackManifestSchema`, `type VoicePackManifest`, `parseVoicePackManifest`, `type ParseVoicePackManifestResult` to `packages/deck-core/src/index.ts`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test packages/deck-core/src/voice-pack-manifest.test.ts`
Expected: PASS, 8 tests (3 + 5 parameterised).

- [ ] **Step 6: Commit**

```bash
git add packages/deck-core/src/voice-pack-manifest.ts packages/deck-core/src/voice-pack-manifest.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): voice-pack.json schema and parser (#1034)"
```

---

### Task 3: Pack scanner

**Files:**
- Create: `packages/deck-core/src/voice-pack-scanner.ts`
- Test: `packages/deck-core/src/voice-pack-scanner.test.ts`
- Modify: `packages/deck-core/src/index.ts`

**Interfaces:**
- Consumes: `parseVoicePackManifest`, `VoicePackManifest` (Task 2).
- Produces:

```ts
export interface VoicePackFileSystem {
  listDirectories(dir: string): readonly string[];
  readTextFile(file: string): string | undefined;
  listMp3Files(packDir: string): readonly string[];
}

export type InstalledVoicePack = {
  id: string;
  label: string;
  version: string;
  author?: string;
  dir: string;
  voices: readonly string[];
  clips: readonly string[];
};

export type VoicePackProblem = { pack: string; reason: string };

export function scanVoicePacks(options: {
  root: string;
  fs: VoicePackFileSystem;
}): { packs: readonly InstalledVoicePack[]; problems: readonly VoicePackProblem[] };
```

`clips` are POSIX paths **relative to that pack's own directory** (`voice/luca/flags/blue-01.mp3`), because each pack is its own audio root.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { scanVoicePacks, type VoicePackFileSystem } from "./voice-pack-scanner.js";

function fakeFs(tree: Record<string, { manifest?: unknown; clips?: string[] }>): VoicePackFileSystem {
  return {
    listDirectories: (dir) => (dir === "/packs" ? Object.keys(tree) : []),
    readTextFile: (file) => {
      const name = file.replace(/\\/g, "/").split("/").at(-2);
      const entry = name ? tree[name] : undefined;

      if (!entry || entry.manifest === undefined) return undefined;

      return typeof entry.manifest === "string" ? entry.manifest : JSON.stringify(entry.manifest);
    },
    listMp3Files: (packDir) => tree[packDir.replace(/\\/g, "/").split("/").at(-1) ?? ""]?.clips ?? [],
  };
}

const lucaManifest = { schema: 1, id: "luca", label: "Luca", version: "1.2.0", voices: ["luca"] };

describe("scanVoicePacks", () => {
  it("returns nothing for a missing or empty root", () => {
    const result = scanVoicePacks({ root: "/packs", fs: fakeFs({}) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("reads a pack and its clips", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({ luca: { manifest: lucaManifest, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      id: "luca",
      label: "Luca",
      version: "1.2.0",
      voices: ["luca"],
      clips: ["voice/luca/flags/blue-01.mp3"],
    });
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/luca");
  });

  it("reports a folder with no voice-pack.json instead of throwing", () => {
    const result = scanVoicePacks({ root: "/packs", fs: fakeFs({ junk: { clips: [] } }) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "junk", reason: "no voice-pack.json" }]);
  });

  it("reports a malformed manifest and keeps scanning the others", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({
        broken: { manifest: "{nope", clips: [] },
        luca: { manifest: lucaManifest, clips: ["voice/luca/flags/blue-01.mp3"] },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["luca"]);
    expect(result.problems[0].pack).toBe("broken");
  });

  it("drops a pack whose clips are all outside its declared voices", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({ luca: { manifest: lucaManifest, clips: ["voice/other/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("no clips");
  });

  it("keeps only clips under a declared voice", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({
        luca: {
          manifest: lucaManifest,
          clips: ["voice/luca/flags/blue-01.mp3", "voice/other/flags/blue-01.mp3", "notes.mp3"],
        },
      }),
    });

    expect(result.packs[0].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("resolves a voice claimed by two packs to the first by sorted pack id, and reports the loser", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({
        zeta: { manifest: { ...lucaManifest, id: "zeta" }, clips: ["voice/luca/flags/blue-01.mp3"] },
        alpha: { manifest: { ...lucaManifest, id: "alpha" }, clips: ["voice/luca/flags/blue-01.mp3"] },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha"]);
    expect(result.problems[0]).toEqual({ pack: "zeta", reason: 'voice "luca" is already provided by pack "alpha"' });
  });

  it("ignores a pack whose folder name does not match its declared id", () => {
    const result = scanVoicePacks({
      root: "/packs",
      fs: fakeFs({ renamed: { manifest: lucaManifest, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("does not match");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/voice-pack-scanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { join } from "node:path";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

/**
 * The disk operations the scanner needs, and nothing more. Narrow on purpose:
 * the scan logic stays a pure function of this port, so its tests need no
 * filesystem and no module mocking.
 */
export interface VoicePackFileSystem {
  /** Immediate subdirectory names of `dir`; empty when `dir` does not exist. */
  listDirectories(dir: string): readonly string[];
  /** File contents, or `undefined` when missing or unreadable. */
  readTextFile(file: string): string | undefined;
  /** Every `.mp3` under `packDir`, recursive, as POSIX paths relative to `packDir`. */
  listMp3Files(packDir: string): readonly string[];
}

export type InstalledVoicePack = {
  id: string;
  label: string;
  version: string;
  author?: string;
  /** Absolute path to the pack folder — this is the pack's audio root. */
  dir: string;
  voices: readonly string[];
  /** POSIX paths relative to `dir`, always `voice/<voice-id>/…`. */
  clips: readonly string[];
};

export type VoicePackProblem = { pack: string; reason: string };

export interface ScanVoicePacksOptions {
  root: string;
  fs: VoicePackFileSystem;
}

export interface ScanVoicePacksResult {
  packs: readonly InstalledVoicePack[];
  problems: readonly VoicePackProblem[];
}

const MANIFEST_FILE = "voice-pack.json";

/** Folders the installer owns; never packs. */
const RESERVED = new Set([".tmp", ".trash"]);

/**
 * Read every pack under `root`. Never throws and never rejects the whole scan
 * for one bad folder: this directory is user-writable by design, so a junk
 * folder must cost that folder only.
 *
 * Pack folders are visited in sorted id order, which makes the voice-collision
 * winner deterministic rather than dependent on directory-listing order.
 */
export function scanVoicePacks({ root, fs }: ScanVoicePacksOptions): ScanVoicePacksResult {
  const packs: InstalledVoicePack[] = [];
  const problems: VoicePackProblem[] = [];
  const claimedVoices = new Map<string, string>();

  for (const folder of [...fs.listDirectories(root)].sort()) {
    if (RESERVED.has(folder) || folder.startsWith(".")) continue;

    const dir = join(root, folder);
    const raw = fs.readTextFile(join(dir, MANIFEST_FILE));

    if (raw === undefined) {
      problems.push({ pack: folder, reason: `no ${MANIFEST_FILE}` });
      continue;
    }

    const parsed = parseVoicePackManifest(raw);

    if (!parsed.ok) {
      problems.push({ pack: folder, reason: parsed.reason });
      continue;
    }

    const manifest = parsed.manifest;

    // The folder name is how the installer addresses a pack, so a mismatch
    // would make "update luca" and "the pack calling itself luca" two
    // different things. Refuse rather than pick one.
    if (manifest.id !== folder) {
      problems.push({ pack: folder, reason: `declared id "${manifest.id}" does not match its folder name` });
      continue;
    }

    const voices = manifest.voices.filter((voice) => {
      const owner = claimedVoices.get(voice);

      if (owner === undefined) return true;

      problems.push({ pack: folder, reason: `voice "${voice}" is already provided by pack "${owner}"` });

      return false;
    });

    if (voices.length === 0) continue;

    const prefixes = voices.map((voice) => `voice/${voice}/`);
    const clips = fs.listMp3Files(dir).filter((clip) => prefixes.some((prefix) => clip.startsWith(prefix)));

    // A pack that declares a voice but ships nothing under it would register an
    // empty pool for every callout, which reads at runtime exactly like a
    // missing clip. Refusing it here keeps that ambiguity out of the engine.
    if (clips.length === 0) {
      problems.push({ pack: folder, reason: `no clips found under ${prefixes.join(", ")}` });
      continue;
    }

    for (const voice of voices) claimedVoices.set(voice, folder);

    packs.push({
      id: manifest.id,
      label: manifest.label,
      version: manifest.version,
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
      dir,
      voices,
      clips,
    });
  }

  return { packs, problems };
}
```

- [ ] **Step 4: Export it**

Add `scanVoicePacks`, `type VoicePackFileSystem`, `type InstalledVoicePack`, `type VoicePackProblem`, `type ScanVoicePacksOptions`, `type ScanVoicePacksResult` to `packages/deck-core/src/index.ts`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test packages/deck-core/src/voice-pack-scanner.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/deck-core/src/voice-pack-scanner.ts packages/deck-core/src/voice-pack-scanner.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): scan installed Race Engineer voice packs (#1034)"
```

---

### Task 4: Filesystem port implementation

**Files:**
- Create: `packages/deck-core/src/voice-pack-fs.ts`
- Test: `packages/deck-core/src/voice-pack-fs.test.ts`
- Modify: `packages/deck-core/src/index.ts`

**Interfaces:**
- Consumes: `VoicePackFileSystem` (Task 3).
- Produces: `createVoicePackFileSystem(logger: ILogger): VoicePackFileSystem`

- [ ] **Step 1: Write the failing test**

Create `packages/deck-core/src/voice-pack-fs.test.ts`. This is the one test in the feature that touches a real filesystem — it uses a temp directory rather than mocking `node:fs`, so it proves the adapter against the real API.

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoicePackFileSystem } from "./voice-pack-fs.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-packs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("createVoicePackFileSystem", () => {
  it("lists only directories", () => {
    mkdirSync(join(root, "luca"));
    writeFileSync(join(root, "loose.txt"), "x");

    expect(createVoicePackFileSystem(logger as never).listDirectories(root)).toEqual(["luca"]);
  });

  it("returns an empty list for a missing directory rather than throwing", () => {
    expect(createVoicePackFileSystem(logger as never).listDirectories(join(root, "nope"))).toEqual([]);
  });

  it("reads a file and returns undefined for a missing one", () => {
    writeFileSync(join(root, "a.json"), "{}");
    const fs = createVoicePackFileSystem(logger as never);

    expect(fs.readTextFile(join(root, "a.json"))).toBe("{}");
    expect(fs.readTextFile(join(root, "missing.json"))).toBeUndefined();
  });

  it("walks mp3 files recursively as POSIX paths relative to the pack dir", () => {
    mkdirSync(join(root, "voice", "luca", "flags"), { recursive: true });
    writeFileSync(join(root, "voice", "luca", "flags", "blue-01.mp3"), "");
    writeFileSync(join(root, "voice", "luca", "flags", "notes.txt"), "");

    expect(createVoicePackFileSystem(logger as never).listMp3Files(root)).toEqual([
      "voice/luca/flags/blue-01.mp3",
    ]);
  });

  it("does not follow symlinked directories out of the pack", () => {
    // A sideloaded pack is user-supplied; a symlink must not let its clip list
    // escape the pack folder that will become its audio root.
    mkdirSync(join(root, "voice", "luca"), { recursive: true });
    writeFileSync(join(root, "voice", "luca", "a.mp3"), "");

    const files = createVoicePackFileSystem(logger as never).listMp3Files(root);

    expect(files.every((f) => !f.includes(".."))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/voice-pack-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ILogger } from "@iracedeck/logger";

import type { VoicePackFileSystem } from "./voice-pack-scanner.js";

/** Depth cap: a pack is `voice/<id>/<group>/<file>`, so anything deeper is not ours. */
const MAX_DEPTH = 6;

/**
 * `node:fs` implementation of the scanner's port — the only file in the voice-pack
 * feature that touches the disk.
 *
 * Every method swallows its errors and returns an empty/undefined result. The
 * packs directory is user-writable by design: a permission error or a folder
 * deleted mid-scan must cost that entry, never the plugin's startup.
 */
export function createVoicePackFileSystem(logger: ILogger): VoicePackFileSystem {
  return {
    listDirectories(dir) {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (err) {
        logger.debug(`Voice packs: cannot list "${dir}": ${err instanceof Error ? err.message : String(err)}`);

        return [];
      }
    },

    readTextFile(file) {
      try {
        return readFileSync(file, "utf-8");
      } catch {
        return undefined;
      }
    },

    listMp3Files(packDir) {
      const found: string[] = [];

      const walk = (dir: string, relative: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;

        let entries: ReturnType<typeof readdirSync>;

        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
          logger.debug(`Voice packs: cannot walk "${dir}": ${err instanceof Error ? err.message : String(err)}`);

          return;
        }

        for (const entry of entries) {
          const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;

          // `isDirectory()` is false for a symlink, so a symlinked directory is
          // simply not descended into — the clip list can never leave the pack.
          if (entry.isDirectory()) {
            walk(join(dir, entry.name), childRelative, depth + 1);
            continue;
          }

          if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) found.push(childRelative);
        }
      };

      walk(packDir, "", 0);
      found.sort();

      return found;
    },
  };
}
```

- [ ] **Step 4: Export it**

Add `createVoicePackFileSystem` to `packages/deck-core/src/index.ts`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test packages/deck-core/src/voice-pack-fs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/deck-core/src/voice-pack-fs.ts packages/deck-core/src/voice-pack-fs.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): filesystem adapter for the voice-pack scanner (#1034)"
```

---

### Task 5: Manifest union

**Files:**
- Modify: `packages/audio-scenarios/src/manifest.ts`
- Test: `packages/audio-scenarios/src/manifest.test.ts` (exists — append a `describe`)

**Interfaces:**
- Consumes: `AudioAssetsManifest` (existing).
- Produces: `mergeManifests(builtIn: AudioAssetsManifest, fragments: readonly (readonly string[])[]): AudioAssetsManifest`

Fragments are clip lists already rebased to the `voice/<id>/…` shape by the caller, so this function stays a pure list merge with no knowledge of packs.

- [ ] **Step 1: Write the failing test**

```ts
describe("mergeManifests", () => {
  const builtIn = {
    clips: ["sfx/IRD-tick-open.mp3", "voice/default/flags/blue-01.mp3"],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  it("returns the built-in manifest unchanged when there are no fragments", () => {
    expect(mergeManifests(builtIn, [])).toEqual(builtIn);
  });

  it("adds fragment clips and keeps the built-in special paths", () => {
    const merged = mergeManifests(builtIn, [["voice/luca/flags/blue-01.mp3"]]);

    expect(merged.clips).toContain("voice/luca/flags/blue-01.mp3");
    expect(merged.ambientLoop).toBe(builtIn.ambientLoop);
    expect(merged.ticks).toEqual(builtIn.ticks);
  });

  it("de-duplicates and sorts so the result is stable regardless of fragment order", () => {
    const a = mergeManifests(builtIn, [["voice/b/x.mp3"], ["voice/a/x.mp3", "voice/b/x.mp3"]]);
    const b = mergeManifests(builtIn, [["voice/a/x.mp3", "voice/b/x.mp3"], ["voice/b/x.mp3"]]);

    expect(a.clips).toEqual(b.clips);
    expect(a.clips.filter((c) => c === "voice/b/x.mp3")).toHaveLength(1);
    expect([...a.clips]).toEqual([...a.clips].sort());
  });

  it("does not mutate the built-in manifest", () => {
    const clips = [...builtIn.clips];
    mergeManifests(builtIn, [["voice/luca/flags/blue-01.mp3"]]);

    expect(builtIn.clips).toEqual(clips);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/audio-scenarios/src/manifest.test.ts`
Expected: FAIL — `mergeManifests is not defined`.

- [ ] **Step 3: Implement**

Append to `packages/audio-scenarios/src/manifest.ts`, and add `mergeManifests` to the import/export list in `packages/audio-scenarios/src/index.ts`.

```ts
/**
 * Union the compiled-in manifest with clip lists contributed by installed voice
 * packs (issue #1034).
 *
 * `ambientLoop` and `ticks` always come from the built-in manifest: those assets
 * ship with the plugin, and a pack must not be able to redefine the radio frame.
 * The result is de-duplicated and sorted so a reload produces an identical
 * manifest for an identical set of packs, whatever order they were scanned in.
 */
export function mergeManifests(
  builtIn: AudioAssetsManifest,
  fragments: readonly (readonly string[])[],
): AudioAssetsManifest {
  if (fragments.length === 0) return builtIn;

  const clips = new Set(builtIn.clips);

  for (const fragment of fragments) {
    for (const clip of fragment) clips.add(clip);
  }

  return { ...builtIn, clips: Array.from(clips).sort() };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test packages/audio-scenarios/src/manifest.test.ts`
Expected: PASS — the existing tests plus 4 new.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-scenarios/src/manifest.ts packages/audio-scenarios/src/manifest.test.ts packages/audio-scenarios/src/index.ts
git commit -m "feat(audio-scenarios): union the built-in manifest with voice-pack clips (#1034)"
```

---

### Task 6: `AudioService` ordered roots

**Files:**
- Modify: `packages/audio-service/src/audio-service.ts` (constructor, `resolvePath`, `initializeAudio`, add `setRoots`)
- Modify: `packages/audio-service/src/audio-service.test.ts` (4 call sites pass a base-path string)
- Modify: `packages/scenario-harness/src/main.ts:90`

**Interfaces:**
- Consumes: nothing.
- Produces: `IAudioService.setRoots(roots: readonly string[]): void`; `initializeAudio(logger, native, roots: readonly string[] = [])`.

The third parameter changes from `basePath: string | null` to `roots: readonly string[]`. A union type would keep the old calls compiling, but it would also leave two ways to say the same thing forever; there are only five production call sites and four test ones.

- [ ] **Step 1: Write the failing test**

Add to `packages/audio-service/src/audio-service.test.ts`:

```ts
describe("root resolution", () => {
  it("resolves against the first root that has the file", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio", "/packs/luca"]);
    getAudio().setFileProbe((p) => p.replace(/\\/g, "/") === "/packs/luca/voice/luca/a.mp3");

    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3", false);

    expect(native.playOnChannel).toHaveBeenCalledWith(
      AudioChannel.Voice,
      expect.stringContaining("packs"),
      false,
      expect.any(Number),
    );
  });

  it("prefers the plugin root when both roots have the file", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio", "/packs/luca"]);
    getAudio().setFileProbe(() => true);

    getAudio().playOnChannel(AudioChannel.Voice, "voice/default/a.mp3", false);

    expect(native.playOnChannel).toHaveBeenCalledWith(
      AudioChannel.Voice,
      expect.stringContaining("plugin"),
      false,
      expect.any(Number),
    );
  });

  it("falls back to the first root when no root has the file", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio", "/packs/luca"]);
    getAudio().setFileProbe(() => false);

    getAudio().playOnChannel(AudioChannel.Voice, "voice/ghost/a.mp3", false);

    expect(native.playOnChannel).toHaveBeenCalledWith(
      AudioChannel.Voice,
      expect.stringContaining("plugin"),
      false,
      expect.any(Number),
    );
  });

  it("still rejects a path escaping every root", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);

    expect(() => getAudio().playOnChannel(AudioChannel.Voice, "../../etc/passwd", false)).toThrow("escapes");
  });

  it("passes absolute paths through unchanged", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);

    getAudio().playOnChannel(AudioChannel.Voice, path.resolve("/tmp/x.mp3"), false);

    expect(native.playOnChannel).toHaveBeenCalledWith(
      AudioChannel.Voice,
      path.resolve("/tmp/x.mp3"),
      false,
      expect.any(Number),
    );
  });

  it("re-probes after setRoots so a newly installed pack resolves without a restart", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);
    getAudio().setFileProbe((p) => p.replace(/\\/g, "/").startsWith("/packs/luca"));

    getAudio().setRoots(["/plugin/assets/audio", "/packs/luca"]);
    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3", false);

    expect(native.playOnChannel).toHaveBeenCalledWith(
      AudioChannel.Voice,
      expect.stringContaining("packs"),
      false,
      expect.any(Number),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/audio-service/src/audio-service.test.ts`
Expected: FAIL — `setRoots`/`setFileProbe` are not functions.

- [ ] **Step 3: Implement**

Replace the `basePath` field and `resolvePath` in `packages/audio-service/src/audio-service.ts`:

```ts
private roots: readonly string[];
private readonly resolvedCache = new Map<string, string>();
private fileProbe: (absolutePath: string) => boolean = (absolutePath) => existsSync(absolutePath);
```

Add `import { existsSync } from "node:fs";` at the top, and these methods:

```ts
/**
 * Replace the ordered root list — called after a voice-pack scan, since each
 * installed pack is its own root (issue #1034). Clears the resolution cache:
 * a path that resolved to a fallback before a pack arrived must be re-probed.
 */
setRoots(roots: readonly string[]): void {
  this.roots = [...roots];
  this.resolvedCache.clear();
}

/** @internal Test seam for the existence probe; production uses `existsSync`. */
setFileProbe(probe: (absolutePath: string) => boolean): void {
  this.fileProbe = probe;
  this.resolvedCache.clear();
}
```

And the new `resolvePath`:

```ts
/**
 * Turn a manifest-relative clip path into a real file under one of the
 * permitted roots. Absolute paths pass through.
 *
 * With more than one root, containment alone cannot pick between them — a
 * relative path is "inside" every root — so the first root that actually HAS
 * the file wins, and the plugin's own root is first so a pack can never shadow
 * a bundled clip. When no root has it we return the first root's resolution:
 * the native layer then fails to open it exactly as it did before packs
 * existed, which keeps "missing clip" one behaviour rather than two.
 *
 * Only successful probes are cached, so a clip that appears later (a pack
 * installed mid-session) is found on its next play without any invalidation.
 */
private resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;

  if (this.roots.length === 0) return filePath;

  const cached = this.resolvedCache.get(filePath);

  if (cached !== undefined) return cached;

  let firstResolved: string | null = null;

  for (const root of this.roots) {
    const base = path.resolve(root);
    const resolved = path.resolve(base, filePath);
    const rel = path.relative(base, resolved);

    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

    if (firstResolved === null) firstResolved = resolved;

    if (this.fileProbe(resolved)) {
      this.resolvedCache.set(filePath, resolved);

      return resolved;
    }
  }

  if (firstResolved === null) {
    throw new Error(`Audio clip path escapes every audio root: ${filePath}`);
  }

  return firstResolved;
}
```

Update the constructor to take `roots: readonly string[]` and assign `this.roots = [...roots]`. Update `initializeAudio`'s third parameter to `roots: readonly string[] = []` and its JSDoc. Add `setRoots` and `setFileProbe` to the `IAudioService` interface, marking `setFileProbe` `@internal`.

- [ ] **Step 4: Update the existing call sites**

In `packages/audio-service/src/audio-service.test.ts`, change the four calls passing `"/plugin/assets/audio"` to `["/plugin/assets/audio"]`. In `packages/scenario-harness/src/main.ts:90`, change `audioBasePath` to `[audioBasePath]`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm test packages/audio-service packages/scenario-harness`
Expected: PASS, including the 6 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/audio-service/src packages/scenario-harness/src/main.ts
git commit -m "feat(audio-service): resolve clips against an ordered list of audio roots (#1034)"
```

---

### Task 7: Engine manifest reload

**Files:**
- Modify: `packages/audio-scenarios/src/interpreter.ts` (`IScenarioEngine`, `ScenarioEngine`)
- Test: `packages/audio-scenarios/src/interpreter.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `mergeManifests` (Task 5).
- Produces: `IScenarioEngine.setManifest(manifest: AudioAssetsManifest): void`

- [ ] **Step 1: Write the failing test**

```ts
describe("setManifest", () => {
  it("makes a clip from a newly added voice resolvable without re-initialising", async () => {
    // Build with `default` only, then add `luca` and switch to it.
    engine.setManifest({
      ...voicedManifest,
      clips: [...voicedManifest.clips, "voice/luca/flags/blue-01.mp3"],
    });
    activeVoice = "luca";

    engine.register({
      id: "t.blue",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["voice/{voice}/flags/blue-01.mp3"],
    });
    engine.fire("t.blue");

    expect(audio.playVoiceSequence).toHaveBeenCalledWith(
      expect.arrayContaining(["voice/luca/flags/blue-01.mp3"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("re-derives manifest-backed pools so a new voice's variants are picked up", () => {
    engine.definePoolFromManifest("blue", "flags", "blue");
    engine.setManifest({
      ...voicedManifest,
      clips: [...voicedManifest.clips, "voice/luca/flags/blue-01.mp3", "voice/luca/flags/blue-02.mp3"],
    });
    activeVoice = "luca";

    // Two members for the new voice; drawing repeatedly must never repeat
    // immediately, which only holds if the pool was actually rebuilt.
    const picks = new Set<string>();
    for (let i = 0; i < 10; i++) picks.add(engine.pickForTest("blue") ?? "");

    expect(picks.size).toBe(2);
  });

  it("drops a voice that is no longer in the manifest", () => {
    engine.setManifest({ ...voicedManifest, clips: voicedManifest.clips.filter((c) => !c.includes("/luca/")) });

    expect(scanRaceEngineerVoices(engine.manifestForTest())).not.toContain("luca");
  });
});
```

If `pickForTest` / `manifestForTest` do not exist, add them to `ScenarioEngine` as `@internal` accessors — the codebase already uses `@internal Exported for testing` for exactly this.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/audio-scenarios/src/interpreter.test.ts`
Expected: FAIL — `engine.setManifest is not a function`.

- [ ] **Step 3: Implement**

In `ScenarioEngine`, make `manifest` and `clipSet` mutable (`private manifest: AudioAssetsManifest`), record each manifest-backed pool's source at definition time, and add:

```ts
/**
 * Swap the manifest — after a voice-pack scan (issue #1034). The engine stays a
 * once-only singleton; only its view of the available clips changes.
 *
 * Manifest-backed pools are re-derived from their recorded `(group, base)`, and
 * every pool's no-repeat tracker is reset, exactly as an active-voice change
 * already does: variant counts differ per voice, so a retained index would
 * point at the wrong member.
 *
 * In-flight fires are untouched — their ops were expanded to concrete paths
 * before playback started.
 */
setManifest(manifest: AudioAssetsManifest): void {
  this.manifest = manifest;
  this.clipSet = new Set(manifest.clips);

  for (const [name, source] of this.manifestPoolSources) {
    this.pools.set(name, this.buildManifestPool(source.group, source.base));
  }

  // Dynamic `pool:<group>/<base>` refs (issue #836) are built lazily on first
  // use and cached under the ref string; drop them so they rebuild against the
  // new manifest rather than serving a stale member list.
  for (const key of [...this.pools.keys()]) {
    if (key.startsWith("pool:")) this.pools.delete(key);
  }

  this.logger.info("Audio manifest reloaded");
  this.logger.debug(`Clips: ${manifest.clips.length}`);
}
```

Add `manifestPoolSources: Map<string, { group: string; base: string }>`, populated in `definePoolFromManifest`. Declare `setManifest` on `IScenarioEngine`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test packages/audio-scenarios`
Expected: PASS, including the 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-scenarios/src/interpreter.ts packages/audio-scenarios/src/interpreter.test.ts
git commit -m "feat(audio-scenarios): reload the scenario engine's manifest and pools (#1034)"
```

---

### Task 8: Voice-pack service (composition root)

**Files:**
- Create: `packages/deck-core/src/voice-pack-service.ts`
- Test: `packages/deck-core/src/voice-pack-service.test.ts`
- Modify: `packages/deck-core/src/index.ts`

**Interfaces:**
- Consumes: `scanVoicePacks`, `InstalledVoicePack`, `VoicePackFileSystem` (Tasks 3–4).
- Produces:

```ts
export interface VoicePackServiceDeps {
  root: string;
  fs: VoicePackFileSystem;
  logger: ILogger;
  pluginAudioDir: string;
  applyRoots(roots: readonly string[]): void;
  applyManifest(fragments: readonly (readonly string[])[]): void;
  onPacksChanged(packs: readonly InstalledVoicePack[], problems: readonly VoicePackProblem[]): void;
}

export function createVoicePackService(deps: VoicePackServiceDeps): {
  refresh(): readonly InstalledVoicePack[];
  installed(): readonly InstalledVoicePack[];
};
```

This is the seam that keeps `deck-core` free of an `audio-service` / `audio-scenarios` import: the plugin injects the two `apply*` callbacks.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

import { createVoicePackService } from "./voice-pack-service.js";
import type { VoicePackFileSystem } from "./voice-pack-scanner.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const manifest = { schema: 1, id: "luca", label: "Luca", version: "1.0.0", voices: ["luca"] };

function fs(packs: Record<string, string[]>): VoicePackFileSystem {
  return {
    listDirectories: () => Object.keys(packs),
    readTextFile: () => JSON.stringify(manifest),
    listMp3Files: (dir) => packs[dir.replace(/\\/g, "/").split("/").at(-1) ?? ""] ?? [],
  };
}

function make(packs: Record<string, string[]>) {
  const applyRoots = vi.fn();
  const applyManifest = vi.fn();
  const onPacksChanged = vi.fn();
  const service = createVoicePackService({
    root: "/packs",
    fs: fs(packs),
    logger: logger as never,
    pluginAudioDir: "/plugin/assets/audio",
    applyRoots,
    applyManifest,
    onPacksChanged,
  });

  return { service, applyRoots, applyManifest, onPacksChanged };
}

describe("createVoicePackService", () => {
  it("puts the plugin audio dir first and each pack dir after it", () => {
    const { service, applyRoots } = make({ luca: ["voice/luca/a.mp3"] });
    service.refresh();

    expect(applyRoots).toHaveBeenCalledWith(["/plugin/assets/audio", expect.stringContaining("luca")]);
  });

  it("passes each pack's clips through as a fragment", () => {
    const { service, applyManifest } = make({ luca: ["voice/luca/a.mp3"] });
    service.refresh();

    expect(applyManifest).toHaveBeenCalledWith([["voice/luca/a.mp3"]]);
  });

  it("applies roots before the manifest so a clip is never advertised before it can resolve", () => {
    const order: string[] = [];
    const applyRoots = vi.fn(() => void order.push("roots"));
    const applyManifest = vi.fn(() => void order.push("manifest"));
    createVoicePackService({
      root: "/packs",
      fs: fs({ luca: ["voice/luca/a.mp3"] }),
      logger: logger as never,
      pluginAudioDir: "/plugin/assets/audio",
      applyRoots,
      applyManifest,
      onPacksChanged: vi.fn(),
    }).refresh();

    expect(order).toEqual(["roots", "manifest"]);
  });

  it("reports installed packs and survives a scan that finds nothing", () => {
    const { service, applyRoots, onPacksChanged } = make({});

    expect(service.refresh()).toEqual([]);
    expect(applyRoots).toHaveBeenCalledWith(["/plugin/assets/audio"]);
    expect(onPacksChanged).toHaveBeenCalledWith([], []);
  });

  it("keeps the last successful scan available via installed()", () => {
    const { service } = make({ luca: ["voice/luca/a.mp3"] });
    service.refresh();

    expect(service.installed().map((p) => p.id)).toEqual(["luca"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/voice-pack-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ILogger } from "@iracedeck/logger";

import {
  type InstalledVoicePack,
  scanVoicePacks,
  type VoicePackFileSystem,
  type VoicePackProblem,
} from "./voice-pack-scanner.js";

export interface VoicePackServiceDeps {
  root: string;
  fs: VoicePackFileSystem;
  logger: ILogger;
  /** The plugin's own `assets/audio` — always the first, highest-precedence root. */
  pluginAudioDir: string;
  applyRoots(roots: readonly string[]): void;
  applyManifest(fragments: readonly (readonly string[])[]): void;
  onPacksChanged(packs: readonly InstalledVoicePack[], problems: readonly VoicePackProblem[]): void;
}

export interface VoicePackService {
  /** Re-scan the packs directory and apply the result. Returns the installed packs. */
  refresh(): readonly InstalledVoicePack[];
  /** The most recent scan result. */
  installed(): readonly InstalledVoicePack[];
}

/**
 * Composition root for installed voice packs (issue #1034).
 *
 * `deck-core` must not import `audio-service` or `audio-scenarios`, so applying
 * a scan is expressed as two injected callbacks. That also makes the ordering
 * rule below explicit and testable rather than implicit in a plugin's startup
 * sequence.
 */
export function createVoicePackService(deps: VoicePackServiceDeps): VoicePackService {
  let packs: readonly InstalledVoicePack[] = [];

  return {
    refresh() {
      const { packs: scanned, problems } = scanVoicePacks({ root: deps.root, fs: deps.fs });
      packs = scanned;

      // Roots BEFORE the manifest: the manifest is what tells the engine a clip
      // exists, and a clip must never be advertised before there is a root that
      // can resolve it.
      deps.applyRoots([deps.pluginAudioDir, ...scanned.map((pack) => pack.dir)]);
      deps.applyManifest(scanned.map((pack) => pack.clips));
      deps.onPacksChanged(scanned, problems);

      deps.logger.info("Voice packs scanned");
      deps.logger.debug(
        `Installed: ${scanned.map((p) => `${p.id}@${p.version}`).join(", ") || "(none)"}; ` +
          `problems: ${problems.map((p) => `${p.pack} (${p.reason})`).join(", ") || "(none)"}`,
      );

      for (const problem of problems) deps.logger.warn(`Voice pack "${problem.pack}" ignored: ${problem.reason}`);

      return scanned;
    },

    installed() {
      return packs;
    },
  };
}
```

- [ ] **Step 4: Export it**

Add `createVoicePackService`, `type VoicePackService`, `type VoicePackServiceDeps` to `packages/deck-core/src/index.ts`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test packages/deck-core/src/voice-pack-service.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/deck-core/src/voice-pack-service.ts packages/deck-core/src/voice-pack-service.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): voice-pack service wiring scan results into audio (#1034)"
```

---

### Task 9: Plugin wiring (all three plugins)

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts`

The three files are byte-identical in this region by convention — make the same edit in each.

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: the `voicePacks` service instance and a `pushVoicePackListIfChanged(packs)` publisher. Task 10 passes `() => voicePacks.refresh()` into the settings-window command deps; nothing is exported from `plugin.ts`, which is a bundled entry point rather than a module anything imports.

- [ ] **Step 1: Replace the static voice derivation**

The current block (`plugin.ts` around line 379) reads:

```ts
const raceEngineerVoices = scanRaceEngineerVoices(audioAssetsManifest);
const driverNames = scanDriverNames(audioAssetsManifest);
```

with its comment claiming both are static for the process lifetime. That comment is now wrong. Replace the block with:

```ts
// Installed voice packs (issue #1034). The compiled-in manifest is the built-in
// half — sfx plus any bundled voice; each installed pack contributes its own
// root and clips on top. Rescanned on demand, so a sideloaded pack needs a
// button press rather than a restart.
const audioRootDir = join(__binDir, "..", "assets", "audio");

let activeManifest = audioAssetsManifest as AudioAssetsManifest;
let raceEngineerVoices = scanRaceEngineerVoices(activeManifest);
let driverNames = scanDriverNames(activeManifest);

const voicePacks = createVoicePackService({
  root: resolveVoicePacksPath({ env: process.env }),
  fs: createVoicePackFileSystem(adapter.createLogger("VoicePacks")),
  logger: adapter.createLogger("VoicePacks"),
  pluginAudioDir: audioRootDir,
  applyRoots: (roots) => getAudio().setRoots(roots),
  applyManifest: (fragments) => {
    activeManifest = mergeManifests(audioAssetsManifest as AudioAssetsManifest, fragments);
    raceEngineerVoices = scanRaceEngineerVoices(activeManifest);
    driverNames = scanDriverNames(activeManifest);

    if (isAudioScenariosInitialized()) getScenarioEngine().setManifest(activeManifest);
  },
  onPacksChanged: (packs) => {
    pushRaceEngineerVoicesIfChanged();
    pushDriverNamesIfChanged();
    pushVoicePackListIfChanged(packs);
  },
});

// First scan BEFORE the engine is constructed, so startup needs no reload.
voicePacks.refresh();
```

`initializeAudio` on line 340 becomes `initializeAudio(adapter.createLogger("Audio"), audioNative, [audioRootDir])`; the `voicePacks.refresh()` call then replaces that root list with the full one.

`initializeAudioScenarios(...)` passes `activeManifest` instead of `audioAssetsManifest`, and `getActiveVoice` becomes `() => resolveActiveRaceEngineerVoice(raceEngineerVoices)` reading the mutable binding.

- [ ] **Step 2: Make the voice/name pushes read live values**

The `pushRaceEngineerVoicesIfChanged` block (line ~762) computes `raceEngineerVoiceListJson` once at module scope. Change it to compute inside the function so a rescan publishes the new list:

```ts
let lastPushedVoiceListJson = "";

function pushRaceEngineerVoicesIfChanged(): void {
  const json = JSON.stringify(raceEngineerVoices);

  if (json === lastPushedVoiceListJson) return;

  lastPushedVoiceListJson = json;
  updateGlobalSettings({ _raceEngineerVoices: json });
}
```

Make the same change to `pushDriverNamesIfChanged`. Delete the now-stale comment claiming both lists "never change at runtime".

Hoisting note: `pushRaceEngineerVoicesIfChanged` is a function declaration, so it is hoisted and safe to reference from the `onPacksChanged` closure defined above it.

- [ ] **Step 3: Add the imports**

To each plugin's import block:

```ts
import {
  createVoicePackFileSystem,
  createVoicePackService,
  resolveVoicePacksPath,
} from "@iracedeck/deck-core";
import {
  getScenarioEngine,
  isAudioScenariosInitialized,
  mergeManifests,
  type AudioAssetsManifest,
} from "@iracedeck/audio-scenarios";
```

Merge these into the existing import statements for those packages rather than adding new ones.

- [ ] **Step 4: Build and confirm it compiles**

Run: `pnpm build`
Expected: all packages build. This is the step that catches a `TranslatorState`-style type mismatch that vitest's esbuild path would let through.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(plugins): discover installed Race Engineer voice packs at startup (#1034)"
```

---

### Task 10: Refresh command and the Voices list in the settings window

**Files:**
- Modify: `packages/deck-core/src/settings-window-commands.ts`
- Modify: `packages/pi-components/partials/race-engineer-settings.ejs`
- Create: `packages/pi-components/src/components/voice-pack-list.ts`
- Modify: `packages/pi-components/src/components/index.ts`
- Modify: the three `plugin.ts` files (wire the command dep)
- Test: `packages/deck-core/src/settings-window-commands.test.ts`, `packages/pi-components/src/…` partial test

**Interfaces:**
- Consumes: the `voicePacks` service (Task 9), whose `refresh()` is passed to the command handler as the `refreshVoicePacks` dep.
- Produces: the `voicePackRefresh` settings-window command; the `_voicePacks` passthrough global (JSON array of `{ id, label, version, voices }`); `<ird-voice-pack-list>`.

`_voicePacks` is enrolled in `RUN_SCOPED_SETTING_KEYS` (`packages/deck-core/src/run-scoped-settings.ts`): it is an observation about this run — what is on disk right now — not user state, and #1014's rule is that such a key must never be persisted or accepted from a UI.

- [ ] **Step 1: Write the failing command test**

```ts
it("routes voicePackRefresh to the injected refresher", () => {
  const refreshVoicePacks = vi.fn();
  const handler = createSettingsWindowCommandHandler({ ...baseDeps, refreshVoicePacks });

  handler({ event: "voicePackRefresh" });

  expect(refreshVoicePacks).toHaveBeenCalledTimes(1);
});

it("ignores a voicePackRefresh payload carrying anything else", () => {
  const refreshVoicePacks = vi.fn();
  const handler = createSettingsWindowCommandHandler({ ...baseDeps, refreshVoicePacks });

  handler({ event: "voicePackRefresh", path: "C:\\somewhere" } as never);

  expect(refreshVoicePacks).toHaveBeenCalledTimes(1);
});
```

The second test pins the existing rule that the page never supplies a path — the same reason `openSettingsFolder` takes none.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test packages/deck-core/src/settings-window-commands.test.ts`
Expected: FAIL — the handler ignores the unknown event.

- [ ] **Step 3: Implement the command**

Add `refreshVoicePacks(): void` to the handler's deps and a `voicePackRefresh` case beside `openSettingsFolder`, following that case's shape exactly (validate the event name, take nothing from the payload, swallow and log a throwing dep).

- [ ] **Step 4: Publish the installed list**

Define the publisher Task 9's `onPacksChanged` calls, beside the existing
`pushRaceEngineerVoicesIfChanged` in each plugin, following its dedupe shape:

```ts
let lastPushedVoicePackListJson = "";

function pushVoicePackListIfChanged(packs: readonly InstalledVoicePack[]): void {
  const json = JSON.stringify(
    packs.map((pack) => ({ id: pack.id, label: pack.label, version: pack.version, voices: pack.voices })),
  );

  if (json === lastPushedVoicePackListJson) return;

  lastPushedVoicePackListJson = json;
  updateGlobalSettings({ _voicePacks: json });
}
```

Import `type InstalledVoicePack` from `@iracedeck/deck-core`, and add `_voicePacks`
to `RUN_SCOPED_SETTING_KEYS` in `packages/deck-core/src/run-scoped-settings.ts`.

- [ ] **Step 5: Add the UI**

In `race-engineer-settings.ejs`, under the existing `ird-voice-select` row and only when `locals.settingsWindow` is set, render the installed list and a refresh button:

```html
<sdpi-item label="Installed Voices">
  <ird-voice-pack-list packs="_voicePacks"></ird-voice-pack-list>
</sdpi-item>
<ird-voice-pack-refresh label="Rescan voices"></ird-voice-pack-refresh>
<div class="ird-supporting-text">
  Voice packs live in <code>%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices</code>. Add a pack folder there, then rescan.
</div>
```

`ird-voice-pack-refresh` is built with the shared `defineSendToPluginButton` factory (`pi-components/src/components/send-to-plugin-button.ts`) that already backs `ird-open-settings` and `ird-open-folder` — sending `{ event: "voicePackRefresh" }`. Do not hand-roll a third button. `ird-voice-pack-list` is a read-only renderer over the `_voicePacks` global, following `ird-audio-device-select`'s pattern for reading a plugin-published list.

- [ ] **Step 6: Build, lint, format, test**

```bash
pnpm build
pnpm lint
pnpm format:fix
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add packages/deck-core/src packages/pi-components packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(settings): list installed Race Engineer voices and rescan on demand (#1034)"
```

---

### Task 11: Documentation

**Files:**
- Create: `packages/website/src/content/docs/docs/features/race-engineer-voices.md`
- Modify: `packages/website/src/content/docs/changelog.mdx` + run `pnpm generate:changelog-data`
- Modify: `packages/audio-assets/CLAUDE.md`, `.claude/rules/race-engineer-callouts.md`, `.claude/rules/settings-window.md`
- Modify: `packages/website/src/content/docs/docs/development/architecture.md`

- [ ] **Step 1: Write the website feature page**

Cover: what a voice pack is, where packs live (with the full path), how to install one by hand, the rescan button, that packs survive plugin updates, what happens when two packs claim the same voice, and that downloading from within the plugin arrives in a later release. Follow the house style of the neighbouring pages in `docs/features/`.

- [ ] **Step 2: Add the changelog entry**

One `**Features**` line under the in-development version, per `.claude/rules/changelog.md` — one change, one line, describing the shipped behaviour:

```markdown
- Race Engineer voices can now be installed as voice packs in `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices`, which survive plugin updates; new packs appear after a rescan in Settings.
```

Then run `pnpm generate:changelog-data` and commit the regenerated JSON.

- [ ] **Step 3: Update the rules and package docs**

- `packages/audio-assets/CLAUDE.md` — the runtime manifest is no longer the whole picture; installed packs contribute clips at runtime.
- `.claude/rules/race-engineer-callouts.md` — the "Audio pools" and manifest rows in the *Where things live* table.
- `.claude/rules/settings-window.md` — the new `voicePackRefresh` command in the Commands row, and `_voicePacks` in the passthrough-keys rule.
- `architecture.md` — voice packs as a runtime input to the audio layer.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @iracedeck/website build
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/website packages/audio-assets/CLAUDE.md .claude/rules packages/iracing-actions/src/actions/data/changelog.json
git commit -m "docs(website): document Race Engineer voice packs (#1034)"
```

---

## Manual test plan

With a Stream Deck plugin build linked (verify the link target first — one shared link slot across worktrees):

1. Start with no packs directory. The Race Engineer works exactly as before, using the bundled `default`. Settings shows one installed voice.
2. Copy `packages/audio-assets/voice/default` into `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\testvoice\voice\testvoice\`, add a `voice-pack.json` declaring `id: "testvoice"`, `voices: ["testvoice"]`. Press **Rescan voices**.
3. `testvoice` appears in the voice dropdown without restarting the deck software. Select it and fire a callout from the scenario harness or in-sim — it plays from AppData.
4. Delete the pack folder, rescan: the dropdown falls back to `default` and playback keeps working.
5. Put a folder with no `voice-pack.json` in the directory and rescan: it is ignored, the log names it, and every other pack still loads.
6. Restart the deck software with the pack present: it is discovered at startup with no button press.

## Self-review notes

- Spec coverage for stage 1: packs root (Task 1), pack format (Task 2), scanning and collisions (Tasks 3–4), manifest union (Task 5), multi-root resolution (Task 6), engine reload (Task 7), composition (Task 8), plugin wiring (Task 9), refresh + UI (Task 10), docs (Task 11). Catalog, download, extraction, seeding and the packer are stages 2–3 by design.
- `skipped` is parsed but unused until #1033 — deliberate, so the published pack format is stable before any pack ships.
- `.install.json` is not read or written in this stage; every discovered pack is a sideloaded pack.
