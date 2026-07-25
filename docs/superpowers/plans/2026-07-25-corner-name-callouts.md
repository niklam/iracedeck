# Corner-Name Callouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Race Engineer announces the upcoming corner's name ("Eau Rouge", "Turn five") in Practice/Test sessions, ~1 s (speed-scaled, tunable) before the corner, using Lovely Sim Racing's lovely-track-data dataset.

**Architecture:** New `@iracedeck/track-data` package holds a committed ~31 KB pruned snapshot + resolver (PR 1). A new `diff/corner-name.ts` in the translator fires a new `cornerName.approaching { name, slug }` bus event on lead-point marker crossings; a snapshot-driven audio scenario plays one pre-generated clip per unique corner name (PR 2). Spec: `docs/superpowers/specs/2026-07-25-corner-name-callouts-design.md`.

**Tech Stack:** TypeScript (tsc), Vitest, Zod, pnpm workspace + turbo, ElevenLabs generator (audio-assets).

## Global Constraints

- Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-888`, branch `ir-888` (PR 1). PR 2 work continues on branch `ir-888-callouts` created on top after Task 4.
- Two PRs: PR 1 = Tasks 1–4 (`feat(track-data): corner marker data layer for corner-name callouts (#888)`), PR 2 = Tasks 5–14 (`feat(race-engineer): corner-name callouts in Practice and Test sessions (#888)`, body `Closes #888`).
- Wording: bare name only. TTS text spells numbers out ("Turn five."), never "T5"/"Turn 5".
- Lead time: global setting `cornerCalloutLeadSeconds`, default **1**, clamp **0–5**.
- Opt-in: `calloutEnabledCornerNames`, default **true**.
- Session gate: `classifySessionType(...) === "practice"` (covers Practice + Offline Testing), **in the diff**, not the scenario.
- Scheduling: default weight (omit), `interrupt: false`, `queueable: false`, `family: "corner-name"`, no radio open/close frame.
- Attribution (grant condition, release blocker for PR 2): Lovely Sim Racing (lovely-track-data) + Racing Circuits + CC BY-NC-SA 4.0 in the PI and website docs.
- All commits use conventional prefixes and end with the Claude-Session trailer (per harness rules). Nothing is pushed until Niklas has manually tested (standing rule). Never `git push` or `gh pr create` without being asked.
- After any `GlobalSettingsSchema` change, verify with `pnpm build --force` (turbo caches deck-core).
- Run all commands from `C:/Users/Niklas/Projects/iRaceDeck/ir-888` (shell cwd resets between calls — always `cd` first or use absolute paths).

---

## PR 1 — `@iracedeck/track-data`

### Task 1: Package scaffold + name normalization/slug module

**Files:**
- Create: `packages/track-data/package.json`
- Create: `packages/track-data/tsconfig.json`
- Create: `packages/track-data/src/normalize.ts`
- Test: `packages/track-data/src/normalize.test.ts`

**Interfaces:**
- Produces: `normalizeCornerName(raw: string): string`, `slugifyCornerName(name: string): string`, `normalizeTrackKey(raw: string): string` — consumed by Tasks 2, 3, and 9.

- [ ] **Step 1: Scaffold package files**

`packages/track-data/package.json` (version matches workspace; devDeps copied from `packages/event-bus/package.json`):

```json
{
  "name": "@iracedeck/track-data",
  "version": "2.3.0-dev.0",
  "description": "Bundled track datasets: corner markers from Lovely Sim Racing's lovely-track-data (CC BY-NC-SA 4.0, used with permission).",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@tsconfig/node22": "22.0.5",
    "@types/node": "26.1.1",
    "rimraf": "6.1.3",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`packages/track-data/tsconfig.json`: copy `packages/event-bus/tsconfig.json` verbatim, then add `"resolveJsonModule": true` to `compilerOptions` (the snapshot is imported as JSON). If event-bus already sets it, copy as-is.

- [ ] **Step 2: Write the failing tests**

`packages/track-data/src/normalize.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { normalizeCornerName, normalizeTrackKey, slugifyCornerName } from "./normalize.js";

describe("normalizeCornerName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeCornerName("  Hell   Corner ")).toBe("Hell Corner");
  });

  it("expands T<n> shorthand to Turn <n>", () => {
    expect(normalizeCornerName("T5")).toBe("Turn 5");
    expect(normalizeCornerName("t11")).toBe("Turn 11");
  });

  it("leaves full names untouched", () => {
    expect(normalizeCornerName("Turn 5")).toBe("Turn 5");
    expect(normalizeCornerName("Eau Rouge")).toBe("Eau Rouge");
    // Not a bare T<n> — embedded digits stay as-is.
    expect(normalizeCornerName("Expo 92")).toBe("Expo 92");
  });
});

describe("slugifyCornerName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyCornerName("Eau Rouge")).toBe("eau-rouge");
    expect(slugifyCornerName("Forest's Elbow")).toBe("forest-s-elbow");
  });

  it("normalizes T<n> and Turn <n> to the same slug", () => {
    expect(slugifyCornerName("T5")).toBe("turn-5");
    expect(slugifyCornerName("Turn 5")).toBe("turn-5");
  });

  it("strips diacritics and symbols", () => {
    expect(slugifyCornerName("Hasseröder")).toBe("hasseroder");
    expect(slugifyCornerName("180°")).toBe("180");
  });
});

describe("normalizeTrackKey", () => {
  it("treats hyphens, underscores, and spaces as equivalent", () => {
    expect(normalizeTrackKey("cota-gp")).toBe("cota gp");
    expect(normalizeTrackKey("Cota GP")).toBe("cota gp");
  });

  it("collapses runs of separators", () => {
    expect(normalizeTrackKey("watkinsglen  2021--fullcourse")).toBe("watkinsglen 2021 fullcourse");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data/src/normalize.test.ts`
Expected: FAIL — cannot resolve `./normalize.js`.

- [ ] **Step 4: Implement `src/normalize.ts`**

```typescript
/**
 * Name/key normalization for the bundled corner dataset (issue #888).
 *
 * Corner names in lovely-track-data mix "T5" and "Turn 5" spellings for the
 * same concept; normalizing at snapshot-refresh time merges them so one
 * spoken clip covers both. Slugs are the clip base names
 * (`voice/<voice>/corner-names/<slug>-01.mp3`), so the algorithm here is the
 * single source of truth shared by the resolver and the clip tooling.
 */

/** Collapse whitespace and expand bare `T<n>` shorthand to `Turn <n>`. */
export function normalizeCornerName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const tShorthand = /^[Tt](\d+)$/.exec(collapsed);

  return tShorthand ? `Turn ${tShorthand[1]}` : collapsed;
}

/**
 * Slug for a corner name — lowercase, diacritics stripped, non-alphanumeric
 * runs collapsed to single hyphens. Applied to the NORMALIZED name so "T5"
 * and "Turn 5" share the slug `turn-5`.
 */
export function slugifyCornerName(name: string): string {
  return normalizeCornerName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical form of a track key for matching iRacing's `WeekendInfo.TrackName`
 * against the dataset's `trackId`. Both sides are normalized, so the dataset's
 * one hyphenated outlier (`cota-gp`) still matches iRacing's space-separated
 * `cota gp`.
 */
export function normalizeTrackKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data/src/normalize.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Install + commit**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm install
git add packages/track-data pnpm-lock.yaml
git commit -m "feat(track-data): scaffold package with corner-name normalization (#888)"
```

(`pnpm install` registers the new workspace package and updates the lockfile — committing the lockfile in the same commit is mandatory.)

### Task 2: Snapshot pruning logic + refresh script + committed snapshot

**Files:**
- Create: `packages/track-data/src/refresh.ts`
- Create: `packages/track-data/scripts/refresh-corner-data.mjs`
- Create: `packages/track-data/src/corners.iracing.json` (generated by the script, then committed)
- Test: `packages/track-data/src/refresh.test.ts`

**Interfaces:**
- Consumes: `normalizeCornerName` from Task 1.
- Produces: `buildCornerSnapshot(files: RawTrackFile[]): CornerSnapshot` where `type RawTrackFile = { trackId?: unknown; turn?: unknown }` and `type CornerSnapshot = Record<string, { start: number; name: string }[]>`. The committed JSON file is consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

`packages/track-data/src/refresh.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { buildCornerSnapshot } from "./refresh.js";

describe("buildCornerSnapshot", () => {
  it("keeps named turns with a start position, sorted by start", () => {
    const snapshot = buildCornerSnapshot([
      {
        trackId: "bathurst",
        turn: [
          { start: 0.22, end: 0.267, name: "Quarry Bend" },
          { start: 0.046, end: 0.075, name: "Hell Corner" },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      bathurst: [
        { start: 0.046, name: "Hell Corner" },
        { start: 0.22, name: "Quarry Bend" },
      ],
    });
  });

  it("falls back to the apex marker when start is absent", () => {
    const snapshot = buildCornerSnapshot([{ trackId: "x", turn: [{ marker: 0.5, name: "Apex Only" }] }]);

    expect(snapshot).toEqual({ x: [{ start: 0.5, name: "Apex Only" }] });
  });

  it("drops unnamed turns, turns without a position, and tracks left empty", () => {
    const snapshot = buildCornerSnapshot([
      { trackId: "empty", turn: [{ start: 0.1, end: 0.2 }, { name: "No Position" }] },
    ]);

    expect(snapshot).toEqual({});
  });

  it("normalizes names (T-shorthand, naem typo, whitespace)", () => {
    const snapshot = buildCornerSnapshot([
      { trackId: "x", turn: [{ start: 0.1, naem: "T5" }, { start: 0.2, name: "  Eau   Rouge " }] },
    ]);

    expect(snapshot.x).toEqual([
      { start: 0.1, name: "Turn 5" },
      { start: 0.2, name: "Eau Rouge" },
    ]);
  });

  it("drops out-of-range positions", () => {
    const snapshot = buildCornerSnapshot([
      { trackId: "x", turn: [{ start: 1.2, name: "Bad" }, { start: -0.1, name: "Worse" }, { start: 0.3, name: "Ok" }] },
    ]);

    expect(snapshot.x).toEqual([{ start: 0.3, name: "Ok" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data/src/refresh.test.ts`
Expected: FAIL — cannot resolve `./refresh.js`.

- [ ] **Step 3: Implement `src/refresh.ts`**

```typescript
/**
 * Snapshot pruning for the refresh script (issue #888). Pure so the logic is
 * unit-testable; `scripts/refresh-corner-data.mjs` feeds it the raw
 * lovely-track-data iRacing JSON files and writes the result to
 * `src/corners.iracing.json`.
 */
import { normalizeCornerName } from "./normalize.js";

/** Raw lovely-track-data track file — only the fields the pruner reads. */
export type RawTrackFile = { trackId?: unknown; turn?: unknown };

export type CornerSnapshotEntry = { start: number; name: string };

/** Pruned snapshot: dataset trackId → named turns sorted by start pct. */
export type CornerSnapshot = Record<string, CornerSnapshotEntry[]>;

/**
 * Prune raw track files down to what the callout needs: named turns with a
 * usable position in [0, 1). Handles the dataset's schema variants — `start`
 * with `marker` (apex) fallback, the one `naem` typo — and normalizes names
 * so "T5"/"Turn 5" merge. Tracks with no surviving turns are omitted.
 */
export function buildCornerSnapshot(files: RawTrackFile[]): CornerSnapshot {
  const snapshot: CornerSnapshot = {};

  for (const file of files) {
    if (typeof file.trackId !== "string" || file.trackId === "" || !Array.isArray(file.turn)) continue;

    const entries: CornerSnapshotEntry[] = [];

    for (const raw of file.turn as Record<string, unknown>[]) {
      const name = typeof raw.name === "string" ? raw.name : typeof raw.naem === "string" ? raw.naem : "";
      const position = typeof raw.start === "number" ? raw.start : typeof raw.marker === "number" ? raw.marker : null;

      if (name.trim() === "" || position === null || position < 0 || position >= 1) continue;

      entries.push({ start: position, name: normalizeCornerName(name) });
    }

    if (entries.length === 0) continue;

    entries.sort((a, b) => a.start - b.start);
    snapshot[file.trackId] = entries;
  }

  return snapshot;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data/src/refresh.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the refresh script**

`packages/track-data/scripts/refresh-corner-data.mjs` — plain Node (global `fetch`), imports the compiled pruner, so build first. Fetches the dataset per-file via GitHub raw (no tar dependency):

```javascript
/**
 * Refresh the committed corner snapshot from lovely-track-data (issue #888).
 *
 * Usage:
 *   pnpm --filter @iracedeck/track-data build
 *   node packages/track-data/scripts/refresh-corner-data.mjs
 *
 * Data: https://github.com/Lovely-Sim-Racing/lovely-track-data
 * License: CC BY-NC-SA 4.0 — used in iRaceDeck with permission (issue #888).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCornerSnapshot } from "../dist/refresh.js";

const RAW_BASE = "https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "corners.iracing.json");

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

const manifest = await fetchJson(`${RAW_BASE}/manifest.json`);
const iracingTracks = manifest.tracks?.iracing ?? [];
if (iracingTracks.length === 0) throw new Error("manifest.json has no iracing tracks — dataset layout changed?");

const files = [];
for (const track of iracingTracks) {
  files.push(await fetchJson(`${RAW_BASE}/${track.path}`));
}

const snapshot = buildCornerSnapshot(files);
const sorted = Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, "\t")}\n`);
console.log(`Wrote ${Object.keys(sorted).length} tracks to ${OUT_PATH}`);
```

- [ ] **Step 6: Generate the snapshot for real**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm --filter @iracedeck/track-data build && node packages/track-data/scripts/refresh-corner-data.mjs
```

Expected: `Wrote ~66-68 tracks to .../src/corners.iracing.json` (count near the audit numbers; a mismatch beyond ±5 means the dataset or pruner regressed — investigate before committing). Spot-check: `bathurst` entry starts with `{ "start": 0.046, "name": "Hell Corner" }`.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888
git add packages/track-data
git commit -m "feat(track-data): snapshot pruner, refresh script, committed LSR corner snapshot (#888)"
```

### Task 3: Resolver + attribution + public exports

**Files:**
- Create: `packages/track-data/src/corner-data.ts`
- Create: `packages/track-data/src/attribution.ts`
- Create: `packages/track-data/src/index.ts`
- Test: `packages/track-data/src/corner-data.test.ts`

**Interfaces:**
- Consumes: `corners.iracing.json` (Task 2), `normalizeTrackKey`/`slugifyCornerName` (Task 1).
- Produces (package public API, consumed by PR 2):
  - `type CornerMarker = { startPct: number; name: string; slug: string }`
  - `resolveCornerMarkers(trackName: string): CornerMarker[] | null`
  - `listCornerNames(): { name: string; slug: string }[]`
  - `slugifyCornerName(name: string): string` (re-export)
  - `CORNER_DATA_ATTRIBUTION: { sourceName, sourceUrl, license, namesCredit }`

- [ ] **Step 1: Write the failing tests**

`packages/track-data/src/corner-data.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { CORNER_DATA_ATTRIBUTION, listCornerNames, resolveCornerMarkers } from "./index.js";

describe("resolveCornerMarkers", () => {
  it("resolves a known track by its exact iRacing TrackName", () => {
    const markers = resolveCornerMarkers("bathurst");

    expect(markers).not.toBeNull();
    expect(markers![0]).toEqual({ startPct: 0.046, name: "Hell Corner", slug: "hell-corner" });
    // Sorted ascending by startPct.
    const pcts = markers!.map((m) => m.startPct);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
  });

  it("matches case- and separator-insensitively", () => {
    // Dataset stores "cota-gp" (hyphen outlier); iRacing reports "cota gp".
    expect(resolveCornerMarkers("cota gp")).not.toBeNull();
    expect(resolveCornerMarkers("BATHURST")).not.toBeNull();
  });

  it("returns null for unknown or empty track names", () => {
    expect(resolveCornerMarkers("some future dlc track")).toBeNull();
    expect(resolveCornerMarkers("")).toBeNull();
  });
});

describe("listCornerNames", () => {
  it("returns the deduplicated name set with stable slugs", () => {
    const names = listCornerNames();

    expect(names.length).toBeGreaterThan(400);
    expect(names).toContainEqual({ name: "Hell Corner", slug: "hell-corner" });
    // No duplicate slugs — one clip per name.
    expect(new Set(names.map((n) => n.slug)).size).toBe(names.length);
  });
});

describe("CORNER_DATA_ATTRIBUTION", () => {
  it("carries the grant-mandated credits", () => {
    expect(CORNER_DATA_ATTRIBUTION.sourceName).toBe("Lovely Sim Racing");
    expect(CORNER_DATA_ATTRIBUTION.sourceUrl).toBe("https://github.com/Lovely-Sim-Racing/lovely-track-data");
    expect(CORNER_DATA_ATTRIBUTION.license).toBe("CC BY-NC-SA 4.0");
    expect(CORNER_DATA_ATTRIBUTION.namesCredit).toBe("Racing Circuits");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data/src/corner-data.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Implement**

`packages/track-data/src/attribution.ts`:

```typescript
/**
 * Attribution for the bundled corner dataset (issue #888).
 *
 * The data is lovely-track-data by Lovely Sim Racing, CC BY-NC-SA 4.0.
 * Constantinos Demetriadis (LSR) granted iRaceDeck use of the data
 * (2026-07-19) on condition that the feature stays free, Lovely Sim Racing
 * is credited in the plugin UI and docs, and LSR's own Racing Circuits
 * attribution is passed through. Surfacing these credits is a GRANT
 * CONDITION — never remove them from the PI or the website docs.
 */
export const CORNER_DATA_ATTRIBUTION = {
  sourceName: "Lovely Sim Racing",
  sourceUrl: "https://github.com/Lovely-Sim-Racing/lovely-track-data",
  license: "CC BY-NC-SA 4.0",
  namesCredit: "Racing Circuits",
} as const;
```

`packages/track-data/src/corner-data.ts`:

```typescript
/**
 * Corner-marker resolver over the committed lovely-track-data snapshot
 * (issue #888). Synchronous and dependency-free: the snapshot is imported
 * at build time, and the lookup table is built lazily on first use.
 */
import cornersJson from "./corners.iracing.json" with { type: "json" };
import { normalizeTrackKey, slugifyCornerName } from "./normalize.js";
import type { CornerSnapshot } from "./refresh.js";

/** One named corner: track-length fraction of the turn entry + spoken name. */
export type CornerMarker = {
  /** Turn-start position as a 0–1 fraction of the lap (maps onto `LapDistPct`). */
  startPct: number;
  /** Normalized display name ("Hell Corner", "Turn 5"). */
  name: string;
  /** Clip base slug (`voice/<voice>/corner-names/<slug>-01.mp3`). */
  slug: string;
};

const snapshot = cornersJson as CornerSnapshot;

let lookupCache: Map<string, CornerMarker[]> | null = null;

function lookup(): Map<string, CornerMarker[]> {
  if (lookupCache) return lookupCache;

  lookupCache = new Map();

  for (const [trackId, entries] of Object.entries(snapshot)) {
    lookupCache.set(
      normalizeTrackKey(trackId),
      entries.map((e) => ({ startPct: e.start, name: e.name, slug: slugifyCornerName(e.name) })),
    );
  }

  return lookupCache;
}

/**
 * Resolve the corner markers for an iRacing track, keyed by the sim's
 * internal `WeekendInfo.TrackName`. Matching is case- and separator-
 * insensitive (the dataset has one hyphenated trackId outlier). Returns
 * `null` when the track isn't in the dataset — the caller stays silent.
 */
export function resolveCornerMarkers(trackName: string): CornerMarker[] | null {
  if (trackName.trim() === "") return null;

  return lookup().get(normalizeTrackKey(trackName)) ?? null;
}

/**
 * Every unique corner name across the snapshot with its slug — the input to
 * the voice-config authoring step (one clip per entry).
 */
export function listCornerNames(): { name: string; slug: string }[] {
  const bySlug = new Map<string, string>();

  for (const entries of Object.values(snapshot)) {
    for (const e of entries) {
      const slug = slugifyCornerName(e.name);

      if (!bySlug.has(slug)) bySlug.set(slug, e.name);
    }
  }

  return [...bySlug.entries()].map(([slug, name]) => ({ name, slug })).sort((a, b) => a.slug.localeCompare(b.slug));
}
```

`packages/track-data/src/index.ts`:

```typescript
export { CORNER_DATA_ATTRIBUTION } from "./attribution.js";
export { type CornerMarker, listCornerNames, resolveCornerMarkers } from "./corner-data.js";
export { normalizeCornerName, normalizeTrackKey, slugifyCornerName } from "./normalize.js";
```

Note: if `import ... with { type: "json" }` fails under the package's tsconfig module setting, fall back to `import cornersJson from "./corners.iracing.json";` with `resolveJsonModule: true` — and ensure the build copies the JSON into `dist/` (tsc does this automatically only with `resolveJsonModule`; verify `dist/corners.iracing.json` exists after build, otherwise add a copy step to the build script: `"build": "tsc && node -e \"require('fs').copyFileSync('src/corners.iracing.json','dist/corners.iracing.json')\""` — check what the import compiles to first).

- [ ] **Step 4: Run tests + build**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/track-data && pnpm --filter @iracedeck/track-data build`
Expected: all track-data tests PASS; build succeeds; `packages/track-data/dist/index.js` imports resolve (run `node -e "import('./packages/track-data/dist/index.js').then(m => console.log(m.resolveCornerMarkers('bathurst')[0]))"` → prints Hell Corner marker).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888
git add packages/track-data
git commit -m "feat(track-data): corner-marker resolver, name list, attribution constants (#888)"
```

### Task 4: PR 1 wrap-up — docs touch + full verification

**Files:**
- Modify: `.claude/CLAUDE.md` (package list — add `@iracedeck/track-data` bullet)
- Modify: `packages/website/src/content/docs/docs/development/architecture.md` (package appears in the dependency graph/prose; the `sim-events-iracing → track-data` edge lands in PR 2 — here just add the package)
- Modify: `README.md` (only if it enumerates packages — check first)

- [ ] **Step 1: Add `@iracedeck/track-data` to `.claude/CLAUDE.md` Packages list**

Insert after the `@iracedeck/scenario-harness` bullet:

```markdown
- `@iracedeck/track-data` — Bundled track datasets. Ships a pruned snapshot of Lovely Sim Racing's lovely-track-data corner markers (CC BY-NC-SA 4.0, used with permission — attribution is a grant condition) keyed by iRacing `WeekendInfo.TrackName`, plus `resolveCornerMarkers`/`listCornerNames`/`slugifyCornerName` and the `CORNER_DATA_ATTRIBUTION` constants. Refresh via `scripts/refresh-corner-data.mjs`.
```

- [ ] **Step 2: Architecture page + README**

In `architecture.md`, add the package to the package inventory (same one-liner, shortened) and to the Mermaid dependency diagram as a standalone node (no edges yet — PR 2 adds `sim-events-iracing → track-data`). Check `README.md` for a package/structure list (`grep -n "sim-events-iracing" README.md`) and mirror the addition if present.

- [ ] **Step 3: Full verification**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm install && set -o pipefail && pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -4 && pnpm lint:fix 2>&1 | tail -3 && pnpm format:fix 2>&1 | tail -3
```

Expected: build all tasks successful, tests all pass, lint/format clean (re-add+amend nothing — commit any formatter diffs separately).

- [ ] **Step 4: Commit + website build check**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm --filter @iracedeck/website build 2>&1 | tail -3
git add -A
git commit -m "docs(track-data): document the new package in CLAUDE.md, architecture page (#888)"
```

**PR 1 code is now complete on branch `ir-888`. Do NOT push — PR creation happens after manual testing of the whole feature (standing rule).**

---

## PR 2 — Callout mechanism + audio (branch `ir-888-callouts` on top of `ir-888`)

- [ ] **Task 5 pre-step: create the stacked branch**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && git checkout -b ir-888-callouts
```

### Task 5: Bus event + harness template

**Files:**
- Modify: `packages/event-bus/src/event-catalog.ts` (SimEventMap — insert after the `"pitBox.countdown"` entry, ~line 304)
- Modify: `packages/scenario-harness/src/event-names.ts` (EVENT_TEMPLATES — the compile-time completeness check fails the build without it)

**Interfaces:**
- Produces: `"cornerName.approaching": SimEvent<"cornerName.approaching", { name: string; slug: string }>` — consumed by Tasks 6, 7, 10, 11.

- [ ] **Step 1: Add the catalog entry**

In `SimEventMap`, after the `"pitBox.countdown"` line:

```typescript
  /**
   * Approaching a named corner in a practice/test session (issue #888).
   * Emitted by the sim translator when the speed-scaled lead point (current
   * position + lead-seconds × speed) crosses a corner's start marker from the
   * bundled `@iracedeck/track-data` snapshot. Open-vocabulary payload: `name`
   * is the normalized display name ("Eau Rouge", "Turn 5") and `slug` the
   * clip base (`corner-names/<slug>-01.mp3`) — the slug rides in the payload
   * so audio consumers never import the dataset package. Once per corner per
   * lap; the audio scenario's `family: "corner-name"` lets consecutive
   * corners preempt an in-flight name cleanly.
   */
  "cornerName.approaching": SimEvent<"cornerName.approaching", { name: string; slug: string }>;
```

- [ ] **Step 2: Add the harness template**

In `packages/scenario-harness/src/event-names.ts`, after the `pitBox.countdown` template:

```typescript
  {
    name: "cornerName.approaching",
    description: "Approaching a named corner in practice/test (issue #888)",
    data: { name: "Eau Rouge", slug: "eau-rouge" },
  },
```

- [ ] **Step 3: Build to verify the completeness check**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build 2>&1 | tail -3`
Expected: all tasks successful. (Skipping the template makes this fail — that's the check working.)

- [ ] **Step 4: Commit**

```bash
git add packages/event-bus packages/scenario-harness
git commit -m "feat(event-bus): cornerName.approaching event + harness template (#888)"
```

### Task 6: Translator state + corner-name diff

**Files:**
- Modify: `packages/sim-events-iracing/package.json` (add `"@iracedeck/track-data": "workspace:*"` to dependencies)
- Modify: `packages/sim-events-iracing/src/state.ts` (3 fields, type + `createInitialState`)
- Create: `packages/sim-events-iracing/src/diff/corner-name.ts`
- Test: `packages/sim-events-iracing/src/diff/corner-name.test.ts`

**Interfaces:**
- Consumes: `CornerMarker` from `@iracedeck/track-data`; `TranslatorState`, `EmitFn`.
- Produces: `diffCornerName(state, telemetry, isPracticeSession, markers, trackLengthMeters, getLeadSeconds, emit): void`, constants `CORNER_TELEPORT_THRESHOLD = 0.05`, `CORNER_LEAD_MAX_PCT = 0.2`, and sanitize exports `CORNER_CALLOUT_DEFAULT_LEAD_SECONDS = 1`, `CORNER_CALLOUT_LEAD_MIN_SECONDS = 0`, `CORNER_CALLOUT_LEAD_MAX_SECONDS = 5`, `sanitizeCornerCalloutLeadSeconds(value: unknown): number` — consumed by Tasks 7 and 12.

- [ ] **Step 1: Add state fields**

In `state.ts` next to the pit-box cluster (type):

```typescript
  // ── Corner-name callouts (issue #888) ────────────────────────────────────
  /**
   * Previous tick's lead point (`LapDistPct` + speed-scaled lead offset,
   * folded into [0, 1)). `null` until the first valid practice tick seeds it
   * silently; reset to `null` whenever the diff's gates fail so a return to
   * the track starts a fresh pass.
   */
  cornerLeadPrevPct: number | null;
  /**
   * Marker indices (into the resolved marker array) already announced this
   * lap. Cleared when the lead point wraps past S/F, on teleport re-anchor,
   * and whenever the gates fail.
   */
  cornerSpoken: Set<number>;
  /**
   * Cache key (`${TrackID}|${SessionNum}`) for the resolved corner markers —
   * the same invalidation pattern as `trackLengthKey`.
   */
  cornerMarkersKey: string;
  /** Resolved corner markers for the current track, `null` when not in the dataset. */
  cornerMarkers: CornerMarker[] | null;
```

Add `import type { CornerMarker } from "@iracedeck/track-data";` at the top, and in `createInitialState()`:

```typescript
    cornerLeadPrevPct: null,
    cornerSpoken: new Set(),
    cornerMarkersKey: "",
    cornerMarkers: null,
```

Add the dependency: in `packages/sim-events-iracing/package.json` dependencies, `"@iracedeck/track-data": "workspace:*"`, then `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`packages/sim-events-iracing/src/diff/corner-name.test.ts` (the direct-diff pattern from `pit-lane.test.ts`):

```typescript
import type { CornerMarker } from "@iracedeck/track-data";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffCornerName } from "./corner-name.js";
import type { EmitFn } from "./types.js";

const MARKERS: CornerMarker[] = [
  { startPct: 0.1, name: "Turn 1", slug: "turn-1" },
  { startPct: 0.5, name: "Eau Rouge", slug: "eau-rouge" },
  { startPct: 0.9, name: "Turn 3", slug: "turn-3" },
];

const TRACK_LENGTH = 5000;
const LEAD = () => 1;

function telemetry(overrides: Partial<TelemetryData>): TelemetryData {
  return { IsOnTrack: true, OnPitRoad: false, Speed: 50, ...overrides } as TelemetryData;
}

describe("diffCornerName", () => {
  let state: TranslatorState;
  let emit: EmitFn;

  beforeEach(() => {
    state = createInitialState();
    emit = vi.fn();
  });

  function tick(lapDistPct: number, overrides: Partial<TelemetryData> = {}): void {
    diffCornerName(state, telemetry({ LapDistPct: lapDistPct, ...overrides }), true, MARKERS, TRACK_LENGTH, LEAD, emit);
  }

  it("seeds silently on the first valid tick", () => {
    tick(0.05);
    expect(emit).not.toHaveBeenCalled();
  });

  it("fires when the lead point crosses a marker", () => {
    // Speed 50 m/s × 1 s / 5000 m = 0.01 lead. Lead point: 0.095 → 0.1005.
    tick(0.085);
    tick(0.0905);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ event: "cornerName.approaching", data: { name: "Turn 1", slug: "turn-1" } });
  });

  it("does not refire the same marker in the same lap", () => {
    tick(0.085);
    tick(0.0905);
    tick(0.0906);
    tick(0.0907);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("speaks only the marker nearest the lead point when several cross in one tick", () => {
    // Jump prev-lead 0.05 → 0.52-ish in bounded steps is not possible in one
    // tick without tripping the teleport guard, so use markers 0.1 & 0.105
    // spacing instead: crossing both in one 0.02 move.
    const dense: CornerMarker[] = [
      { startPct: 0.1, name: "A", slug: "a" },
      { startPct: 0.105, name: "B", slug: "b" },
    ];
    diffCornerName(state, telemetry({ LapDistPct: 0.08 }), true, dense, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.1 }), true, dense, TRACK_LENGTH, LEAD, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ event: "cornerName.approaching", data: { name: "B", slug: "b" } });
    // A was marked spoken too — moving on doesn't back-fire it.
    diffCornerName(state, telemetry({ LapDistPct: 0.101 }), true, dense, TRACK_LENGTH, LEAD, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("re-announces on the next lap (spoken set clears at S/F wrap)", () => {
    // Every step stays under the 0.05 teleport threshold.
    tick(0.85);
    tick(0.895); // lead point 0.905 — crosses Turn 3 at 0.9
    expect(emit).toHaveBeenCalledTimes(1);
    tick(0.94);
    tick(0.985);
    tick(0.02); // lead point wraps past S/F → spoken set clears
    tick(0.06);
    tick(0.0905); // lead point 0.1005 — Turn 1, new lap
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({ event: "cornerName.approaching", data: { name: "Turn 1", slug: "turn-1" } });
  });

  it("re-anchors without firing on a teleport (reset to pits)", () => {
    tick(0.6);
    tick(0.05); // huge jump → teleport
    expect(emit).not.toHaveBeenCalled();
    // Fresh pass after the reset announces normally.
    tick(0.085);
    tick(0.0905);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("ignores backward motion", () => {
    tick(0.12);
    tick(0.095); // reversing across the marker
    tick(0.096);
    expect(emit).not.toHaveBeenCalled();
  });

  it("tracks but does not announce while on pit road", () => {
    tick(0.085, { OnPitRoad: true });
    tick(0.0905, { OnPitRoad: true });
    expect(emit).not.toHaveBeenCalled();
    // Marker was consumed — leaving pit road right after doesn't back-fire it.
    tick(0.0906);
    expect(emit).not.toHaveBeenCalled();
  });

  it("stays silent outside practice, off track, without markers or track length", () => {
    diffCornerName(state, telemetry({ LapDistPct: 0.085 }), false, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), false, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905, IsOnTrack: false }), true, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), true, null, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), true, MARKERS, null, LEAD, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("clamps an absurd lead so a fast car on a short track cannot lap-wrap the lead point", () => {
    // 100 m/s × 5 s on a 1000 m track = 0.5 of a lap raw → clamped to 0.2.
    diffCornerName(state, telemetry({ LapDistPct: 0.0, Speed: 100 }), true, MARKERS, 1000, () => 5, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.001, Speed: 100 }), true, MARKERS, 1000, () => 5, emit);
    // Lead point moved 0.2 → 0.201; Turn 1 (0.1) is BEHIND the lead point
    // from the silent first-tick seed onward, so nothing crosses — no burst.
    expect(emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/sim-events-iracing/src/diff/corner-name.test.ts`
Expected: FAIL — cannot resolve `./corner-name.js`.

- [ ] **Step 4: Implement `diff/corner-name.ts`**

```typescript
/**
 * Corner-name callouts in practice/test sessions (issue #888).
 *
 * As the player approaches a named corner, the engineer announces it —
 * "Eau Rouge", "Turn five" — with a speed-scaled lead so the call lands
 * before the corner regardless of approach speed. Markers come from the
 * bundled lovely-track-data snapshot (`@iracedeck/track-data`), resolved
 * per track by the translator and passed in here.
 *
 * Trigger model: a LEAD POINT (current `LapDistPct` plus `speed ×
 * leadSeconds` converted to a lap fraction) is tracked tick-to-tick, and a
 * marker fires when it falls inside the forward interval the lead point
 * swept this tick — true threshold-crossing semantics, so the first tick
 * seeds silently and markers behind the car never burst-fire. Once per
 * marker per lap (`cornerSpoken`, cleared when the lead point wraps past
 * S/F). Reversing never fires; a discontinuous jump (tow / reset-to-pits)
 * re-anchors silently and clears the set so the fresh run announces again.
 * Multiple markers swept in one tick speak only the one nearest the lead
 * point (no stale burst — the #480/#838 rule). On pit road crossings are
 * consumed but not announced.
 *
 * Session gating lives HERE (the #655 diff-side precedent) so the scenario
 * harness can fire `cornerName.approaching` freely without iRacing.
 */
import type { CornerMarker } from "@iracedeck/track-data";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * One-tick lead-point jump (lap fraction) treated as a discontinuity — tow,
 * reset-to-pits, replay scrub. Same scale as the #603 position-tracking
 * threshold: well above racing motion (~0.0003/tick at 60 Hz), well below
 * any plausible teleport.
 */
export const CORNER_TELEPORT_THRESHOLD = 0.05;

/**
 * Cap on the speed-scaled lead offset (lap fraction). Keeps an extreme
 * setting on a short track from pushing the lead point most of a lap ahead
 * (which would both announce absurdly early and confuse the wrap detection).
 */
export const CORNER_LEAD_MAX_PCT = 0.2;

/** Default announcement lead (seconds ahead of the corner at current speed). */
export const CORNER_CALLOUT_DEFAULT_LEAD_SECONDS = 1;

/** Lead-time slider bounds (seconds) — mirrors the Zod schema in deck-core. */
export const CORNER_CALLOUT_LEAD_MIN_SECONDS = 0;
export const CORNER_CALLOUT_LEAD_MAX_SECONDS = 5;

/**
 * Sanitize a raw `cornerCalloutLeadSeconds` global-settings value: non-numeric
 * falls back to the default, the rest clamps to the slider bounds. Plugins
 * wrap their live-read closure in this (the #838 fuel-margin pattern).
 */
export function sanitizeCornerCalloutLeadSeconds(value: unknown): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : value;

  if (typeof n !== "number" || !Number.isFinite(n)) return CORNER_CALLOUT_DEFAULT_LEAD_SECONDS;

  return Math.min(CORNER_CALLOUT_LEAD_MAX_SECONDS, Math.max(CORNER_CALLOUT_LEAD_MIN_SECONDS, n));
}

function resetPass(state: TranslatorState): void {
  state.cornerLeadPrevPct = null;

  if (state.cornerSpoken.size > 0) state.cornerSpoken.clear();
}

export function diffCornerName(
  state: TranslatorState,
  telemetry: TelemetryData,
  isPracticeSession: boolean,
  markers: readonly CornerMarker[] | null,
  trackLengthMeters: number | null,
  getLeadSeconds: () => number,
  emit: EmitFn,
): void {
  // Gates: practice-like session, live in the car, markers + track length
  // known, valid lap position. Anything missing → silent AND the pass state
  // resets, so returning to the track starts a fresh announced run.
  if (!isPracticeSession || markers === null || markers.length === 0) {
    resetPass(state);

    return;
  }

  if (trackLengthMeters === null || trackLengthMeters <= 0 || telemetry.IsOnTrack !== true) {
    resetPass(state);

    return;
  }

  const lapDistPct = telemetry.LapDistPct;

  if (typeof lapDistPct !== "number" || lapDistPct < 0) {
    resetPass(state);

    return;
  }

  const speed = typeof telemetry.Speed === "number" && telemetry.Speed > 0 ? telemetry.Speed : 0;
  const leadPct = Math.min(CORNER_LEAD_MAX_PCT, (speed * getLeadSeconds()) / trackLengthMeters);
  const leadPoint = (lapDistPct + leadPct) % 1;

  const prev = state.cornerLeadPrevPct;

  state.cornerLeadPrevPct = leadPoint;

  // First valid tick of a pass: seed silently. Markers "behind" the lead
  // point simply aren't in any future forward interval this lap, so there is
  // no burst and no explicit seeding pass needed.
  if (prev === null) return;

  // Signed forward delta folded into (-0.5, 0.5]: negative = reversing.
  const delta = ((leadPoint - prev + 1.5) % 1) - 0.5;

  if (delta <= 0) return;

  if (delta > CORNER_TELEPORT_THRESHOLD) {
    // Tow / reset / scrub — re-anchor, clear the lap's spoken set, stay
    // silent. The next genuine crossings announce as a fresh pass.
    state.cornerSpoken.clear();

    return;
  }

  // The lead point wrapped past S/F inside this tick's interval — new lap.
  if (leadPoint < prev) state.cornerSpoken.clear();

  // Collect markers inside the forward interval (prev, leadPoint]. All of
  // them are consumed (marked spoken); only the one nearest the lead point
  // is announced, so a wide tick never bursts stale names.
  let bestIdx = -1;
  let bestForward = -1;

  for (let i = 0; i < markers.length; i++) {
    const forward = (markers[i]!.startPct - prev + 1) % 1;

    if (forward <= 0 || forward > delta) continue;

    if (state.cornerSpoken.has(i)) continue;

    state.cornerSpoken.add(i);

    if (forward > bestForward) {
      bestForward = forward;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return;

  // Pit lane parallels the track — consume crossings there, announce nothing.
  if (telemetry.OnPitRoad === true) return;

  const marker = markers[bestIdx]!;

  emit({ event: "cornerName.approaching", data: { name: marker.name, slug: marker.slug } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm exec vitest run packages/sim-events-iracing/src/diff/corner-name.test.ts`
Expected: PASS (10 tests). Note the pit-road test expects the marker to be CONSUMED while on pit road — matches the `resetPass` NOT firing there (gates pass, only the emit is suppressed).

- [ ] **Step 6: Commit**

```bash
git add packages/sim-events-iracing pnpm-lock.yaml
git commit -m "feat(sim-events-iracing): corner-name diff with speed-scaled lead point (#888)"
```

### Task 7: Translator wiring (marker cache, options, handleTick, exports)

**Files:**
- Modify: `packages/sim-events-iracing/src/translator.ts`
- Modify: `packages/sim-events-iracing/src/index.ts`

**Interfaces:**
- Consumes: `diffCornerName` + constants (Task 6), `resolveCornerMarkers` (`@iracedeck/track-data`).
- Produces: `SimEventsIracingOptions.getCornerCalloutLeadSeconds?: () => number`; package exports `sanitizeCornerCalloutLeadSeconds`, `CORNER_CALLOUT_DEFAULT_LEAD_SECONDS`, `CORNER_CALLOUT_LEAD_MIN_SECONDS`, `CORNER_CALLOUT_LEAD_MAX_SECONDS` — consumed by Task 12 (plugins).

- [ ] **Step 1: Extend options + instance**

In `translator.ts`:
- `TranslatorInstance` (next to `getFuelLapsLeftMarginLaps: () => number;` ~L148): add `getCornerCalloutLeadSeconds: () => number;`
- `SimEventsIracingOptions` (~L156): add

```typescript
  /**
   * Live-read announcement lead (seconds) for the corner-name callouts
   * (issue #888). Plugins compose it from the `cornerCalloutLeadSeconds`
   * global setting via `sanitizeCornerCalloutLeadSeconds`. Default: the
   * constant {@link CORNER_CALLOUT_DEFAULT_LEAD_SECONDS}.
   */
  getCornerCalloutLeadSeconds?: () => number;
```

- In `initializeSimEventsIracing` instance construction (next to the fuel-margin line ~L198):

```typescript
    getCornerCalloutLeadSeconds: options.getCornerCalloutLeadSeconds ?? (() => CORNER_CALLOUT_DEFAULT_LEAD_SECONDS),
```

- Imports: `import { CORNER_CALLOUT_DEFAULT_LEAD_SECONDS, diffCornerName } from "./diff/corner-name.js";` and `import { resolveCornerMarkers } from "@iracedeck/track-data";` plus `import type { CornerMarker } from "@iracedeck/track-data";`.

- [ ] **Step 2: Marker-cache resolver**

Add next to `resolveTrackLengthMeters` (~L1653), same key + retry-on-null shape:

```typescript
/**
 * Resolve (and cache) the bundled corner markers for the current track
 * (issue #888). Keyed by `(TrackID, SessionNum)` like the track-length cache;
 * re-resolves when the key changes and retries while null in case the first
 * YAML tick lacked `TrackName`. Returns `null` for tracks not in the dataset.
 */
function resolveCornerMarkersCached(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  telemetry: TelemetryData,
): CornerMarker[] | null {
  if (!sessionInfo) return state.cornerMarkers;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const key = `${String(weekend?.TrackID ?? "")}|${String(telemetry.SessionNum ?? "")}`;

  if (key !== state.cornerMarkersKey) {
    state.cornerMarkersKey = key;
    state.cornerMarkers = null;
  } else if (state.cornerMarkers !== null) {
    return state.cornerMarkers;
  }

  const trackName = typeof weekend?.TrackName === "string" ? weekend.TrackName : "";

  if (trackName !== "") state.cornerMarkers = resolveCornerMarkers(trackName);

  return state.cornerMarkers;
}
```

- [ ] **Step 3: Wire into `handleTick`**

Immediately after the `diffPitBoxCountdown(...)` call (~L1390) — `trackLengthMeters` is already resolved above it, `sessionType` (raw) exists at ~L1253:

```typescript
  // Corner-name callouts (issue #888). Practice/test only — the diff gates on
  // the classified session type (diff-side per #655, so the harness can fire
  // the event directly). Reuses the cached trackLengthMeters for the
  // speed→lap-fraction conversion; markers resolve from the bundled
  // lovely-track-data snapshot keyed by WeekendInfo.TrackName.
  diffCornerName(
    self.state,
    telemetry,
    classifySessionType(sessionType) === "practice" && sessionType !== "",
    resolveCornerMarkersCached(self.state, sessionInfo, telemetry),
    trackLengthMeters,
    self.getCornerCalloutLeadSeconds,
    emit,
  );
```

(`classifySessionType("")` returns `"race"`, so the `sessionType !== ""` guard is belt-and-suspenders documentation more than behavior; keep it — an empty raw type means session info hasn't resolved and silence is correct.)

- [ ] **Step 4: Package exports**

In `packages/sim-events-iracing/src/index.ts`, next to the fuel-laps-left export block:

```typescript
export {
  CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
  CORNER_CALLOUT_LEAD_MAX_SECONDS,
  CORNER_CALLOUT_LEAD_MIN_SECONDS,
  sanitizeCornerCalloutLeadSeconds,
} from "./diff/corner-name.js";
```

- [ ] **Step 5: Check the replay wipe + session reset**

Open `translator.ts`, find `wipeStateForReplay` and `resetPerSessionState`. If either rebuilds state from `createInitialState()` with an explicit preserved/carried list, the new corner fields get default treatment automatically — which is CORRECT (a replay glance or session change starts a fresh pass; the markers cache re-resolves by key). If instead they reset an explicit field list, add `cornerLeadPrevPct = null`, `cornerSpoken.clear()` to that list (markers cache can stay — it's keyed). Verify by reading, adjust accordingly.

- [ ] **Step 6: Build + full sim-events tests**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build 2>&1 | tail -3 && pnpm exec vitest run packages/sim-events-iracing 2>&1 | tail -4`
Expected: build green (catches state-type mismatches vitest misses), tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/sim-events-iracing
git commit -m "feat(sim-events-iracing): wire corner-name diff with marker cache and lead-seconds option (#888)"
```

### Task 8: deck-core global settings + fixtures

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts` (two schema fields)
- Modify: `packages/deck-core/src/simhub-service.test.ts` (BOTH exhaustive literals)

- [ ] **Step 1: Add schema fields**

Next to `calloutEnabledLapTimeBestLap` (~L575), add:

```typescript
    /**
     * Opt-in for the corner-name callouts (issue #888). One boolean for the
     * family — the engineer announces the upcoming corner's name in practice
     * and test sessions. Defaults `true`. Canonical id↔key mapping in
     * `CORNER_NAME_CALLOUT_SETTING_KEYS` (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledCornerNames: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
```

Next to `fuelCalloutMarginLaps` (~L761), add:

```typescript
    /**
     * Corner-name announcement lead in seconds (issue #888) — how far ahead
     * of the corner the name is spoken, scaled by current speed in the
     * translator. Slider 0–5 s, default 1. Must match the
     * `CORNER_CALLOUT_*_SECONDS` constants in `@iracedeck/sim-events-iracing`.
     * Same preprocess/catch shape as `fuelCalloutMarginLaps` so empty-ish or
     * malformed persisted values fall back instead of aborting the parse.
     */
    cornerCalloutLeadSeconds: z.preprocess(
      (val) => (val == null || (typeof val === "string" && val.trim() === "") ? undefined : val),
      z.coerce.number().min(0).max(5).default(1).catch(1),
    ),
```

- [ ] **Step 2: Update both simhub-service.test.ts literals**

`grep -n "calloutEnabledLapTimeBestLap" packages/deck-core/src/simhub-service.test.ts` — for EACH hit's object literal, add adjacent lines:

```typescript
      calloutEnabledCornerNames: true,
      cornerCalloutLeadSeconds: 1,
```

- [ ] **Step 3: Force build + test**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build --force 2>&1 | tail -3 && pnpm exec vitest run packages/deck-core 2>&1 | tail -4`
Expected: green. (`--force` because turbo caches deck-core and a plain build can falsely pass.)

- [ ] **Step 4: Commit**

```bash
git add packages/deck-core
git commit -m "feat(deck-core): corner-name callout opt-in and lead-seconds settings (#888)"
```

### Task 9: Voice config — corner-names group + clip generation

**Files:**
- Create: `packages/audio-assets/scripts/generate-corner-names-group.mjs`
- Modify: `packages/audio-assets/configs/default.voice.json` (new `corner-names` group, script-inserted)
- Generated: `packages/audio-assets/voice/default/corner-names/*.mp3` (~439 clips), `generate.manifest.json`, `manifest.json`

- [ ] **Step 1: Write the authoring script**

`packages/audio-assets/scripts/generate-corner-names-group.mjs` (requires `@iracedeck/track-data` built — it is, from Task 7's build):

```javascript
/**
 * Author the `corner-names` voice-config group from the track-data name set
 * (issue #888). Deterministic + idempotent: reads default.voice.json, replaces
 * groups["corner-names"] wholesale, writes the file back. Entry text is the
 * SPOKEN form — numbers spelled out ("Turn five.", never "Turn 5") per the
 * ElevenLabs input convention. Names containing digits that no rule handles
 * make the script FAIL LOUDLY so a new dataset name can't ship with bad TTS
 * text — add an override below when that happens.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listCornerNames } from "../../track-data/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "configs", "default.voice.json");

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  throw new Error(`numberToWords: unhandled number ${n}`);
}

/** Full-name overrides for oddballs the generic rules can't speak. */
const TEXT_OVERRIDES = {
  "180°": "One eighty.",
};

function spokenText(name) {
  if (TEXT_OVERRIDES[name]) return TEXT_OVERRIDES[name];

  const turn = /^Turn (\d+)$/.exec(name);
  if (turn) return `Turn ${numberToWords(Number(turn[1]))}.`;

  if (/\d/.test(name)) {
    // Standalone number tokens inside a longer name read naturally as words.
    const spelled = name.replace(/\b(\d+)\b/g, (_, d) => numberToWords(Number(d)));
    if (/\d/.test(spelled)) throw new Error(`No TTS rule for "${name}" — add a TEXT_OVERRIDES entry.`);
    return `${spelled}.`;
  }

  return `${name}.`;
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
config.groups["corner-names"] = listCornerNames().map(({ name, slug }) => ({
  name: `${slug}-01`,
  text: spokenText(name),
}));
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`);
console.log(`corner-names group: ${config.groups["corner-names"].length} entries`);
```

- [ ] **Step 2: Run it + sanity-check**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && node packages/audio-assets/scripts/generate-corner-names-group.mjs
```

Expected: `corner-names group: ~439 entries`. If it throws `No TTS rule for "<name>"`, add a `TEXT_OVERRIDES` entry for that name (spell it the way it should be SPOKEN) and re-run. Then check formatting matches the file's existing style (`git diff --stat packages/audio-assets/configs/default.voice.json` — if prettier reformats the whole file, run `pnpm format:fix` and confirm only the new group is a content change). Spot-check entries: `turn-5-01` → `"Turn five."`, `eau-rouge-01` → `"Eau Rouge."`, `hasseroder-01` → `"Hasseröder."`.

- [ ] **Step 3: Dry-run the generator**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm --filter @iracedeck/audio-assets generate:dry-run --group corner-names
```

Expected: lists ONLY the ~439 new `corner-names` entries. Anything else listed → STOP, the group filter or hash cache is off; investigate before spending API credit.

- [ ] **Step 4: Generate (paid — approved by Niklas)**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm --filter @iracedeck/audio-assets generate --group corner-names && pnpm --filter @iracedeck/audio-assets generate:manifest
```

If `ELEVENLABS_API_KEY` is missing, ask Niklas to run the two commands via `!` in the prompt instead. Expected afterwards: `packages/audio-assets/voice/default/corner-names/` holds ~439 mp3s, `manifest.json` lists them. Listen-check at least `eau-rouge-01.mp3` and `turn-5-01.mp3` exist and are non-trivial size (`ls -la ... | head`).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888
git add packages/audio-assets
git commit -m "feat(audio-assets): corner-name clip set generated from the track-data name list (#888)"
```

### Task 10: Audio scenario + family wiring

**Files:**
- Create: `packages/audio-scenarios/src/catalog/pit-crew/corner-name.ts`
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (imports, re-exports, two `registerPitCrew` params before the masters, registration block)
- Test: `packages/audio-scenarios/src/catalog/pit-crew/corner-name.test.ts`
- Modify: every test calling `registerPitCrew(...)` positionally up to the master args (`grep -rl "registerPitCrew(" packages/audio-scenarios/src packages/scenario-harness/src` → at minimum `register-pit-crew.test.ts`, `rolling-start.test.ts`, `start-lights.test.ts`, `scenario-harness/src/main.ts` — check each call's arg count)

**Interfaces:**
- Consumes: `cornerName.approaching` (Task 5), clips group `corner-names` (Task 9).
- Produces: `buildCornerNameScenario(getSnapshot)`, `registerCornerNameVars(engine, getSnapshot)`, `type CornerNameSnapshot = { name: string; slug: string }`, `type CornerNameSnapshotResolver = () => CornerNameSnapshot | null`, `type CornerNameCalloutId = "corner-names"`, `CORNER_NAME_CALLOUT_SETTING_KEYS`, `SCENARIO_ID_TO_CORNER_NAME_ID`, `CORNER_NAME_SCENARIO_IDS`, `CORNER_NAME_POOL_NAMES` — consumed by Task 12.
- `registerPitCrew` gains, inserted AFTER `getFuelCalloutEnabled` and BEFORE `getRaceEngineerMasterEnabled`: `getCornerNameCalloutEnabled: (id: CornerNameCalloutId) => boolean = () => true` and `getCornerNameSnapshot: CornerNameSnapshotResolver = () => null`.

- [ ] **Step 1: Write `corner-name.ts`**

```typescript
/**
 * Corner-name callout (issue #888) — the engineer speaks the upcoming
 * corner's bare name ("Eau Rouge", "Turn five") in practice/test sessions.
 *
 * Terse delivery: a single clip, NO radio open/close frame (the pit-box
 * count-in precedent) — at a 1 s default lead a beep frame would eat the
 * whole margin. `family: "corner-name"` so back-to-back corners preempt the
 * in-flight name; `queueable: false` because a name that missed its moment
 * must drop, never replay late. Weight stays at the default `WEIGHT.NORMAL`.
 *
 * Snapshot-driven builder shape (issue #558, the lap-time precedent): the
 * clip resolver reads a plugin-owned cache of the latest event payload at
 * expansion time. The slug maps straight to the `corner-names` clip group —
 * a name with no clip for the active voice aborts the whole callout at
 * expansion (issue #835), which is exactly the graceful degradation we want
 * when the dataset grows between releases. Session gating (practice-only)
 * lives in the translator diff, NOT here, so the scenario stays firable from
 * the scenario harness.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** Snapshot the clip resolver reads — exactly the event payload. */
export type CornerNameSnapshot = SimEventOf<"cornerName.approaching">["data"];

/** Resolver for the most recent `cornerName.approaching` payload. */
export type CornerNameSnapshotResolver = () => CornerNameSnapshot | null;

const CORNER_NAME_GROUP = "corner-names";

/**
 * Register the corner-name clip resolver. Must run before the scenario is
 * defined — load-time validation rejects an unregistered `{ var }` name.
 */
export function registerCornerNameVars(engine: IScenarioEngine, getSnapshot: CornerNameSnapshotResolver): void {
  engine.defineVar("cornerName.clip", () => {
    const s = getSnapshot();

    if (!s || typeof s.slug !== "string" || s.slug === "") return null;

    return poolRef(CORNER_NAME_GROUP, s.slug);
  });
}

/** Build the corner-name scenario bound to a snapshot resolver. */
export function buildCornerNameScenario(getSnapshot: CornerNameSnapshotResolver): Scenario {
  return {
    id: "pit-crew.corner-name-approaching",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "corner-name",
    queueable: false,
    sequence: [{ var: "cornerName.clip" }],
    when: {
      event: "cornerName.approaching",
      where: (e) => {
        const data = (e as SimEventOf<"cornerName.approaching">).data;

        // The snapshot cache is what the resolver speaks from; require a
        // usable slug on the event itself so a malformed payload can't fire
        // an empty expansion.
        return typeof data.slug === "string" && data.slug !== "" && getSnapshot() !== null;
      },
    },
  };
}

/** Stable identifier for the corner-name callout family (issue #888). */
export type CornerNameCalloutId = "corner-names";

/** Canonical id↔setting-key map plugins read the live opt-in through. */
export const CORNER_NAME_CALLOUT_SETTING_KEYS: Record<CornerNameCalloutId, string> = {
  "corner-names": "calloutEnabledCornerNames",
};

export const SCENARIO_ID_TO_CORNER_NAME_ID: Record<string, CornerNameCalloutId> = {
  "pit-crew.corner-name-approaching": "corner-names",
};

export const CORNER_NAME_SCENARIO_IDS: readonly string[] = ["pit-crew.corner-name-approaching"];

/** Empty — the clip is var-resolved (#836), no POOL_REGISTRY entry. */
export const CORNER_NAME_POOL_NAMES: readonly string[] = [];
```

- [ ] **Step 2: Wire into `index.ts`**

- Import block (alphabetical with siblings):

```typescript
import {
  buildCornerNameScenario,
  type CornerNameCalloutId,
  type CornerNameSnapshotResolver,
  registerCornerNameVars,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";
```

- Re-export block (mirror the lap-time re-export):

```typescript
export {
  buildCornerNameScenario,
  CORNER_NAME_CALLOUT_SETTING_KEYS,
  type CornerNameCalloutId,
  type CornerNameSnapshot,
  type CornerNameSnapshotResolver,
} from "./corner-name.js";
```

- Signature: insert BETWEEN `getFuelCalloutEnabled` (~L891) and `getRaceEngineerMasterEnabled` (~L900):

```typescript
  // User opt-in for the corner-name callouts (issue #888). Single subject
  // gating the practice/test corner announcements. Same gate-at-event-arrival
  // shape as the other callout families. Placed before the master gate so the
  // master stays the last per-callout opt-in. Default `() => true` preserves
  // legacy behavior for tests that don't supply a closure.
  getCornerNameCalloutEnabled: (id: CornerNameCalloutId) => boolean = () => true,
  // Corner-name snapshot (issue #888). Plugins cache the latest
  // `cornerName.approaching` payload (the lap-time subscription pattern) and
  // pass the getter; the clip resolver reads it at expansion time. Default
  // `() => null` makes the scenario's `where:` short-circuit — a safe stub
  // for tests.
  getCornerNameSnapshot: CornerNameSnapshotResolver = () => null,
```

- Registration block after the lap-time block (~L1165):

```typescript
  // Corner-name callout (issue #888). Register-vars-before-scenario ordering,
  // same as session-start / lap-time.
  registerCornerNameVars(engine, getCornerNameSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildCornerNameScenario(getCornerNameSnapshot),
        SCENARIO_ID_TO_CORNER_NAME_ID,
        getCornerNameCalloutEnabled,
        "corner-name callout",
        logger,
      ),
    ),
  );
```

- [ ] **Step 3: Write the failing scenario tests**

`packages/audio-scenarios/src/catalog/pit-crew/corner-name.test.ts` (pure-shape tests — no engine harness needed; if the `SimEventOf` cast or `poolRef` comparison chafes against the real types, mirror how `pit-box`/`rolling-start` tests construct events):

```typescript
import type { SimEventOf } from "@iracedeck/event-bus";
import { describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  buildCornerNameScenario,
  CORNER_NAME_SCENARIO_IDS,
  type CornerNameSnapshot,
  registerCornerNameVars,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";

function cornerEvent(data: { name: string; slug: string }): SimEventOf<"cornerName.approaching"> {
  return { event: "cornerName.approaching", data } as SimEventOf<"cornerName.approaching">;
}

describe("buildCornerNameScenario", () => {
  it("has the terse non-queueable corner-name shape", () => {
    const s = buildCornerNameScenario(() => null);

    expect(s.id).toBe("pit-crew.corner-name-approaching");
    expect(s.family).toBe("corner-name");
    expect(s.queueable).toBe(false);
    // Single var step — bare name, no radio open/close frame.
    expect(s.sequence).toEqual([{ var: "cornerName.clip" }]);
  });

  it("where: requires a usable slug and a populated snapshot", () => {
    let snapshot: CornerNameSnapshot | null = null;
    const s = buildCornerNameScenario(() => snapshot);
    const good = cornerEvent({ name: "Eau Rouge", slug: "eau-rouge" });

    expect(s.when.where?.(good)).toBe(false); // snapshot not populated yet

    snapshot = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(s.when.where?.(good)).toBe(true);
    expect(s.when.where?.(cornerEvent({ name: "", slug: "" }))).toBe(false);
  });
});

describe("registerCornerNameVars", () => {
  it("resolves cornerName.clip to the group/slug pool, null without a snapshot", () => {
    const vars = new Map<string, () => unknown>();
    const engine = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;
    let snapshot: CornerNameSnapshot | null = null;

    registerCornerNameVars(engine, () => snapshot);

    const resolve = vars.get("cornerName.clip");

    expect(resolve).toBeDefined();
    expect(resolve!()).toBeNull();

    snapshot = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(resolve!()).toEqual(poolRef("corner-names", "eau-rouge"));
  });
});

describe("family wiring", () => {
  it("maps every scenario id to the corner-names opt-in", () => {
    expect(CORNER_NAME_SCENARIO_IDS.length).toBeGreaterThan(0);

    for (const id of CORNER_NAME_SCENARIO_IDS) {
      expect(SCENARIO_ID_TO_CORNER_NAME_ID[id]).toBe("corner-names");
    }
  });
});
```

- [ ] **Step 4: Fix positional callers**

`grep -rn "registerPitCrew(" packages/audio-scenarios/src packages/scenario-harness/src --include="*.ts" | grep -v "\.d\.ts"` — for every CALL whose arguments reach the master positions (they pass `getRaceEngineerMasterEnabled`/`getRadarMasterEnabled` positionally), insert two `undefined` values at the new positions (after the fuel-callout arg, before the master arg). Known: `register-pit-crew.test.ts`, `rolling-start.test.ts`, `start-lights.test.ts`; check `spotter-engine`-related tests and `scenario-harness/src/main.ts` arg counts individually.

- [ ] **Step 5: Test + build**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build 2>&1 | tail -3 && pnpm exec vitest run packages/audio-scenarios 2>&1 | tail -4`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/audio-scenarios packages/scenario-harness
git commit -m "feat(audio-scenarios): corner-name scenario with snapshot-driven clip resolver (#888)"
```

### Task 11: Scenario-harness shortcuts

**Files:**
- Modify: `packages/scenario-harness/src/scenario-shortcuts.ts` (after the Pit Box block, ~L1367)

- [ ] **Step 1: Add shortcuts**

```typescript
  // ── Corner names (issue #888) ──
  // Fire the event directly so you audition name clips without driving a
  // practice lap. Fire two in a row to confirm same-family preemption.
  {
    id: "corner-name-eau-rouge",
    category: "Corner Names",
    label: "Eau Rouge",
    description: "Corner-name callout for a named corner (practice/test).",
    event: "cornerName.approaching",
    data: { name: "Eau Rouge", slug: "eau-rouge" },
  },
  {
    id: "corner-name-turn-5",
    category: "Corner Names",
    label: "Turn 5",
    description: "Corner-name callout for a numbered corner — spoken as \"Turn five\".",
    event: "cornerName.approaching",
    data: { name: "Turn 5", slug: "turn-5" },
  },
```

- [ ] **Step 2: Check the harness wires the new registerPitCrew params**

Open `packages/scenario-harness/src/main.ts` — if its `registerPitCrew(...)` call stops before the new positions, nothing to do; if it reaches the masters, Task 10 Step 4 already fixed it. Additionally the harness needs the snapshot cache to actually PLAY the clip: mirror the plugin wiring (subscribe + closure) in `main.ts` if its call reaches that far; if it stops earlier, extend it with the two new args (`(id) => true` equivalent default is fine — pass the snapshot closure at minimum, or the shortcut buttons will fire a scenario whose `where:` short-circuits on `getSnapshot() === null`):

```typescript
let lastCornerName: { name: string; slug: string } | null = null;
eventBus.subscribe("cornerName.approaching", (ev) => {
  lastCornerName = ev.data;
});
// ...pass `() => lastCornerName` at the getCornerNameSnapshot position.
```

- [ ] **Step 3: Manual harness smoke test**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm --filter @iracedeck/scenario-harness dev` (background), open `http://127.0.0.1:5750`, click both Corner Names buttons — each speaks its bare name through the radio filter; two rapid clicks: the second preempts the first. Stop the dev server after.

- [ ] **Step 4: Commit**

```bash
git add packages/scenario-harness
git commit -m "feat(scenario-harness): corner-name shortcut buttons (#888)"
```

### Task 12: Plugin wiring — all three plugins

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts`

**Interfaces:**
- Consumes: `CORNER_NAME_CALLOUT_SETTING_KEYS`, `CornerNameCalloutId`, `CornerNameSnapshot` (audio-scenarios); `sanitizeCornerCalloutLeadSeconds` (sim-events-iracing).

For EACH of the three `plugin.ts` files (they mirror each other — locate each anchor by grep, the line numbers differ per plugin):

- [ ] **Step 1: Imports**

Add `CORNER_NAME_CALLOUT_SETTING_KEYS`, `type CornerNameCalloutId`, `type CornerNameSnapshot` to the existing `@iracedeck/audio-scenarios` import; add `sanitizeCornerCalloutLeadSeconds` to the `@iracedeck/sim-events-iracing` import.

- [ ] **Step 2: Lead-seconds option**

In the `initializeSimEventsIracing(..., { getFuelLapsLeftMarginLaps: ... })` options object, add:

```typescript
  getCornerCalloutLeadSeconds: () =>
    sanitizeCornerCalloutLeadSeconds((getGlobalSettings() as Record<string, unknown>).cornerCalloutLeadSeconds),
```

- [ ] **Step 3: Snapshot cache (next to the `lap.completed` cache)**

```typescript
// Cache the most recent `cornerName.approaching` payload so the corner-name
// scenario's clip resolver reads it at fire time (issue #888) — the lap-time
// subscription pattern. Subscribed BEFORE registerPitCrew so this listener
// runs first and the cache is fresh when the scenario evaluates.
let lastCornerName: CornerNameSnapshot | null = null;
eventBus.subscribe("cornerName.approaching", (ev) => {
  lastCornerName = ev.data;
});
```

- [ ] **Step 4: registerPitCrew args**

In the `registerPitCrew(...)` call, AFTER the fuel-callout closure and BEFORE the Race Engineer master closure, insert:

```typescript
  // Corner-name callout opt-in (issue #888). Live-read, single subject.
  (id: CornerNameCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[CORNER_NAME_CALLOUT_SETTING_KEYS[id]] !== false,
  // Corner-name snapshot resolver (issue #888) — the cache populated above.
  () => lastCornerName,
```

- [ ] **Step 5: Build + commit**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build 2>&1 | tail -3`
Expected: green (arg-position mistakes in any plugin fail typecheck here — positions matter, the params are typed differently enough to catch swaps).

```bash
git add packages/iracing-plugin-stream-deck packages/iracing-plugin-mirabox packages/iracing-plugin-ulanzi
git commit -m "feat(plugins): wire corner-name callout opt-in, snapshot cache, lead-seconds option (#888)"
```

### Task 13: Property Inspector row + attribution

**Files:**
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`

- [ ] **Step 1: Add the callout array (script section, next to `lapTimeCallouts` ~L248)**

```javascript
			// Corner-name callouts (issue #888). Single subject — engineer
			// announces the upcoming corner's name in practice/test sessions.
			var cornerNameCallouts = [
				{ setting: "calloutEnabledCornerNames", label: "Corner names (practice/test)" },
			];
			var cornerNameRowCount = Math.ceil(cornerNameCallouts.length / 2);
			var cornerNameCheckboxes = cornerNameCallouts.map(function (c) {
				return '<sdpi-checkbox setting="' + c.setting + '" label="' + c.label + '" global default="true"></sdpi-checkbox>';
			}).join('');
```

- [ ] **Step 2: Add the accordion items (content section, after the Fuel-margin supporting-text ~L484, before the Setup Warning item)**

```javascript
				'<sdpi-item label="Corner Names">' +
					'<div style="display:grid;grid-template-rows:repeat(' + cornerNameRowCount + ',auto);grid-auto-flow:column;gap:4px 12px;width:100%;">' +
						cornerNameCheckboxes +
					'</div>' +
				'</sdpi-item>' +
				'<div class="ird-supporting-text">Announces the upcoming corner\'s name in practice and test sessions. Corner data by <a href="https://github.com/Lovely-Sim-Racing/lovely-track-data" target="_blank" rel="noopener noreferrer">Lovely Sim Racing</a>, corner names by Racing Circuits &mdash; CC BY-NC-SA 4.0, used with permission.</div>' +
				'<sdpi-item label="Corner call lead (seconds)">' +
					'<ird-range-input setting="cornerCalloutLeadSeconds" min="0" max="5" step="0.5" default="1" global showlabels></ird-range-input>' +
				'</sdpi-item>' +
				'<div class="ird-supporting-text">How far before the corner the name is spoken, scaled by your speed. Keep it short &mdash; long leads blur together through consecutive corners.</div>' +
```

(The attribution line is a GRANT CONDITION — the link uses a plain anchor; the shared external-link handler opens it in the default browser.)

- [ ] **Step 3: Build + visual check**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && set -o pipefail && pnpm build 2>&1 | tail -3` — then open the generated `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/pit-crew.html` and confirm the Corner Names item, the slider, and the attribution text render in the Race Engineer Callouts accordion markup.

- [ ] **Step 4: Commit**

```bash
git add packages/iracing-actions
git commit -m "feat(pi): corner-name opt-in, lead slider, LSR attribution in Pit Crew PI (#888)"
```

### Task 14: Docs, changelog, website, skills, rules + final verification

**Files:**
- Modify: `packages/website/src/content/docs/changelog.mdx` (in-development `## 2.3.0` section — create at top with `_Unreleased_` if absent)
- Modify: website Pit Crew / Race Engineer action page (find with `grep -rln "Race Engineer" packages/website/src/content/docs/docs --include="*.md*" | head`)
- Modify: `.claude/skills/iracedeck-actions/` listing (find the callout/feature list inside; add corner names)
- Modify: `.claude/rules/race-engineer-callout-examples.md` (new reference entry)
- Modify: `packages/website/src/content/docs/docs/development/architecture.md` (add the `sim-events-iracing → track-data` dependency edge)
- Check: `docs/plugins/core/actions/` — only update a pit-crew page if one exists (`ls docs/plugins/core/actions/`)

- [ ] **Step 1: Changelog entry (under `## 2.3.0`, `**Features**`)**

```markdown
- The Race Engineer announces upcoming corner names in practice and test sessions ("Eau Rouge", "Turn five"), with a speed-scaled lead time you can tune in the Pit Crew settings. Corner data by Lovely Sim Racing's lovely-track-data (corner names by Racing Circuits, CC BY-NC-SA 4.0, used with permission) — covers ~68 iRacing tracks.
```

- [ ] **Step 2: Website action page**

In the Pit Crew / Race Engineer callout listing add a "Corner names" row/section: practice+test only, default on, lead-time setting, the attribution sentence (same wording as the changelog credit), and the note that tracks outside the dataset stay silent.

- [ ] **Step 3: Skills + rules**

- `iracedeck-actions` skill: add corner names to the Race Engineer callout list (grep for "best lap" inside the skill directory to find the right spot).
- `race-engineer-callout-examples.md`: append the entry:

```markdown
- **Corner-name callouts** — issue #888. Establishes the **open-vocabulary clip set + bundled dataset** pattern: a per-name clip group (`corner-names/<slug>-01`) generated from a committed dataset snapshot (`@iracedeck/track-data`, lovely-track-data — attribution is a grant condition), with the slug riding in the event payload so audio never imports the dataset package. Trigger is a **speed-scaled lead point** (seconds × Speed → lap fraction, clamped) swept tick-to-tick against marker positions — interval-crossing semantics with a silent first-tick seed, once-per-marker-per-lap dedup cleared at the S/F wrap, teleport re-anchor (reset-to-pits starts a fresh announced pass), reverse-motion no-fire, and consume-but-don't-announce on pit road. Practice/test-only gating sits in the DIFF (#655 shape) so the harness fires freely; scheduling is default-weight + `queueable: false` (a missed name drops) + `family: "corner-name"` (consecutive corners preempt). Reach for this pattern when a callout's vocabulary comes from DATA rather than an enum: pre-generate one clip per unique normalized name, let #835 missing-clip abort handle dataset growth, and put the name→clip key (slug) in the event payload.
```

- [ ] **Step 4: Architecture page dependency edge**

Add `sim-events-iracing --> track-data` to the Mermaid dependency graph.

- [ ] **Step 5: Final full verification**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-888 && pnpm install && set -o pipefail && pnpm build --force 2>&1 | tail -3 && pnpm test 2>&1 | tail -4 && pnpm lint:fix 2>&1 | tail -3 && pnpm format:fix 2>&1 | tail -3 && pnpm --filter @iracedeck/website build 2>&1 | tail -3
```

Expected: everything green (website build validates the MDX). Commit any formatter fallout with the docs commit.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(race-engineer): corner-name callouts — changelog, website, skills, rules (#888)"
```

### Task 15: Manual test handoff (STOP point)

- [ ] Report to Niklas: implementation complete on `ir-888` (PR 1) + `ir-888-callouts` (PR 2), all checks green. Hand over the manual test plan from the spec (harness buttons; iRacing practice at Bathurst/Spa: ~1 s lead, consecutive-corner preemption, reset-to-pits re-announce, live opt-in toggle, lead slider; race/quali silence). **Do not push, do not create PRs** — wait for Niklas's manual test results and explicit go-ahead, then: push `ir-888` → PR 1 → CodeRabbit babysit loop → squash-merge → rebase `ir-888-callouts` onto master → push → PR 2 (`Closes #888`) → CodeRabbit → squash-merge → worktree cleanup (`git clean -fdx` then `git worktree remove ../ir-888`).
