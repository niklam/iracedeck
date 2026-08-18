# Plugin-Owned Settings Store — Phase 1 Implementation Plan (#993)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin the single owner of plugin-global settings — a JSON file under `%LOCALAPPDATA%\iRaceDeck\Settings\<ecosystem>\` — with the deck host read once for migration and otherwise unused, and every #896/#868 dual-writer guard deleted.

**Architecture:** A new `SettingsStore` (file-backed, atomic, debounced) replaces the deck host as the source of truth in `deck-core/src/global-settings.ts`; the public API (`initGlobalSettings`/`getGlobalSettings`/`updateGlobalSettings`/`deleteGlobalSettings`/`onGlobalSettingsChange`) is preserved so actions, the settings window, and the plugins keep working unchanged from their point of view. The settings server starts at plugin startup and publishes `_settingsChannel` to the host as the one remaining host write (consumed by the phase-2 PI bridge). The window gains a Storage card. **Phase 2 (PI bridge on all hosts) is a separate plan**, written after this phase is on hardware.

**Tech Stack:** TypeScript (ESM), Node 20–24 (`node:fs/promises`, `node:path`), Zod (existing schema), Vitest, EJS partials, the existing settings-window server (`node:http` + `ws`).

**Spec:** `docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md`

## Global Constraints

- Branch `release/3.0`, worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-release-3.0`. Commit locally; **do not push, do not open a PR** (Niklas asks for that explicitly).
- File location: `%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck | Mirabox | Ulanzi>\global-settings.json`; env override `IRACEDECK_SETTINGS_PATH` (full file path). No configurable location.
- Migration: copy once from the host, **leave the host copy untouched**; 10 s timeout when the host never answers.
- ~~After migration the adapter's `setGlobalSettings` is called **exactly once per start**, with `{ _settingsChannel: { port, token } }`.~~ **Superseded by the phase-1 final review (2026-08-16):** every deck host's `setGlobalSettings` REPLACES the whole stored object, so that write wiped the migrated host copy. Phase 1 writes NOTHING to the host; phase 2 adds the bootstrap write as a guarded mirror `{ ...cache, _settingsChannel }`, skipped when the store became ready via the migration timeout — see the spec's Amendment. Later `onDidReceiveGlobalSettings` payloads are ignored for the cache (logged at debug).
- Delete: pending-write overlay, pending-delete reconciliation, first-arrival write queue, shrink guard, `lastHostSettings`, and the Ulanzi adapter's write gate. Keep per-key salvage.
- Rename `hasReceivedHostSettings()` → `isSettingsStoreReady()` and retarget every in-repo caller; the old name is removed.
- Every plain-value schema field keeps `.catch(...)` (unchanged rule). Exact dependency versions (`save-exact`). Run `pnpm build` (not only tests) after type edits — vitest is more permissive than tsc. `pnpm build --force` after a `GlobalSettingsSchema` change (turbo caches deck-core).
- **Phase 1 must not ship alone.** After Task 4 the plugin no longer reads the host store, but Property Inspectors still WRITE to it (their sdpi is unchanged until the phase-2 PI bridge). A PI edit therefore reaches neither the plugin nor the file until phase 2 lands. Fine on the release branch; not releasable.
- Every code step is TDD: write the failing test, watch it fail, minimal code, watch it pass, commit. Tests live beside sources (`foo.ts` → `foo.test.ts`).
- Logging: `info` = event without parameters, `debug` = details.
- Docs in the same change: `.claude/rules/global-settings.md`, `.claude/rules/settings-window.md`, `packages/deck-adapter-ulanzi/CLAUDE.md`, the architecture page's settings-path section, `changelog.mdx` (one line under the in-development section — fold into the existing settings-window line, do not add a second), README if wording changes.

---

## File Structure

| File                                                                                   | Responsibility                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/deck-core/src/settings-store.ts` (new)                                       | `SettingsStore` interface; `createFileSettingsStore` (atomic write, 250 ms debounce, `flush`, corrupt-file move-aside); `resolveSettingsStorePath` + `settingsStoreFolderName` (pure path logic). |
| `packages/deck-core/src/settings-store.test.ts` (new)                                  | Store tests against a real temp dir.                                                                                                                                                              |
| `packages/deck-core/src/global-settings.ts` (rewrite core, L1041–1330 + 1379–1533)     | Cache = store; migration; single host write; listeners; API unchanged.                                                                                                                            |
| `packages/deck-core/src/global-settings.test.ts` (rewrite the #896 blocks)             | Delete first-arrival/pending/shrink tests; add store-backed load/migration/save tests; keep everything else.                                                                                      |
| `packages/deck-core/src/global-settings-migrations.ts` (1 line)                        | `hasReceivedHostSettings` → `isSettingsStoreReady`.                                                                                                                                               |
| `packages/deck-core/src/window-focus-service.ts` (+ test)                              | same rename.                                                                                                                                                                                      |
| `packages/deck-core/src/binding-dispatcher.ts`                                         | same rename (check usage).                                                                                                                                                                        |
| `packages/deck-core/src/index.ts`                                                      | export store + rename.                                                                                                                                                                            |
| `packages/deck-adapter-ulanzi/src/adapter.ts` (+ test)                                 | delete the write gate.                                                                                                                                                                            |
| `packages/scenario-harness/src/main.ts`, `mock-platform-adapter.ts`                    | pass an in-memory store to `initGlobalSettings`.                                                                                                                                                  |
| `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/src/plugin.ts`                   | create the store, pass it in; start the settings server at startup; publish `_settingsChannel`; `startupDefaultsApplied` keys on store-ready.                                                     |
| `packages/deck-core/src/settings-window.ts` (+ server)                                 | `ensureStarted()` returning `{ port, token }`; server exposes `token`.                                                                                                                            |
| `packages/deck-core/src/settings-window-commands.ts` (+ test)                          | `openSettingsFolder` command.                                                                                                                                                                     |
| `packages/pi-components/partials/global-common-diagnostics.ejs`, `settings-window.ejs` | Storage card (path text + Open folder).                                                                                                                                                           |
| Docs listed under Global Constraints.                                                  | Kept in sync per the Global Constraints section.                                                             |

---

### Task 1: `resolveSettingsStorePath` — pure path logic

**Files:**

- Create: `packages/deck-core/src/settings-store.ts`
- Test: `packages/deck-core/src/settings-store.test.ts`

**Interfaces:**

- Produces: `settingsStoreFolderName(platform: string): string` (`"stream-deck"→"Stream Deck"`, `"mirabox"→"Mirabox"`, `"ulanzi"→"Ulanzi"`, unknown → the platform id verbatim); `resolveSettingsStorePath({ platform, env }: { platform: string; env: Record<string, string | undefined> }): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/deck-core/src/settings-store.test.ts
import { describe, expect, it } from "vitest";

import { resolveSettingsStorePath, settingsStoreFolderName } from "./settings-store.js";

describe("settingsStoreFolderName", () => {
  it("maps the plugin platform id to a human-readable per-ecosystem folder", () => {
    expect(settingsStoreFolderName("stream-deck")).toBe("Stream Deck");
    expect(settingsStoreFolderName("mirabox")).toBe("Mirabox");
    expect(settingsStoreFolderName("ulanzi")).toBe("Ulanzi");
  });

  it("passes an unknown platform id through so two unknown ecosystems still get separate files", () => {
    expect(settingsStoreFolderName("something-new")).toBe("something-new");
  });
});

describe("resolveSettingsStorePath", () => {
  it("defaults to %LOCALAPPDATA%\\iRaceDeck\\Settings\\<ecosystem>\\global-settings.json", () => {
    const p = resolveSettingsStorePath({
      platform: "stream-deck",
      env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" },
    });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Stream Deck/global-settings.json");
  });

  it("falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA is unset", () => {
    const p = resolveSettingsStorePath({ platform: "mirabox", env: { USERPROFILE: "C:\\Users\\n" } });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json");
  });

  it("honours IRACEDECK_SETTINGS_PATH as a full file path override (dev / fresh-install testing)", () => {
    const p = resolveSettingsStorePath({
      platform: "ulanzi",
      env: { LOCALAPPDATA: "C:\\x", IRACEDECK_SETTINGS_PATH: "D:\\test\\fresh.json" },
    });

    expect(p).toBe("D:\\test\\fresh.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-release-3.0 && pnpm exec vitest run packages/deck-core/src/settings-store.test.ts`
Expected: FAIL — `Cannot find module './settings-store.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/deck-core/src/settings-store.ts
/**
 * Plugin-owned global-settings store (issue #993).
 *
 * The plugin — not the deck host — owns plugin-global settings, in one JSON
 * file per ecosystem under the user's local app data. The host store is
 * read once (migration) and otherwise unused; see the design doc
 * docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md.
 */
import { join } from "node:path";

const FOLDER_NAMES: Record<string, string> = {
  "stream-deck": "Stream Deck",
  mirabox: "Mirabox",
  ulanzi: "Ulanzi",
};

/** Human-readable per-ecosystem folder; unknown ids pass through so ecosystems never share a file. */
export function settingsStoreFolderName(platform: string): string {
  return FOLDER_NAMES[platform] ?? platform;
}

export interface ResolveSettingsStorePathOptions {
  /** `getPluginPlatform()` — "stream-deck" | "mirabox" | "ulanzi". */
  platform: string;
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Settings\<ecosystem>\global-settings.json`, or the
 * full path in `IRACEDECK_SETTINGS_PATH` (development / fresh-install testing).
 */
export function resolveSettingsStorePath({ platform, env }: ResolveSettingsStorePathOptions): string {
  const override = env.IRACEDECK_SETTINGS_PATH;

  if (override && override.trim().length > 0) return override;

  const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");

  return join(base, "iRaceDeck", "Settings", settingsStoreFolderName(platform), "global-settings.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/deck-core/src/settings-store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/settings-store.ts packages/deck-core/src/settings-store.test.ts
git commit -m "feat(deck-core): settings-store path resolution — per-ecosystem file under LOCALAPPDATA, env override (#993)"
```

---

### Task 2: `createFileSettingsStore` — load / save / flush against a real temp dir

**Files:**

- Modify: `packages/deck-core/src/settings-store.ts`
- Test: `packages/deck-core/src/settings-store.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface SettingsStore {
    readonly path: string;
    /** undefined = no file yet (→ migration). Corrupt file → moved aside, returns undefined. */
    load(): Promise<Record<string, unknown> | undefined>;
    /** Debounced (250 ms trailing). Last write wins. */
    save(settings: Record<string, unknown>): void;
    /** Await any pending debounced write. Safe when nothing is pending. */
    flush(): Promise<void>;
  }
  export function createFileSettingsStore(opts: { path: string; logger: ILogger; debounceMs?: number }): SettingsStore;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/deck-core/src/settings-store.test.ts
import { silentLogger } from "@iracedeck/logger";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSettingsStore, type SettingsStore } from "./settings-store.js";

describe("createFileSettingsStore", () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-settings-store-"));
    store = createFileSettingsStore({
      path: join(dir, "sub", "global-settings.json"),
      logger: silentLogger,
      debounceMs: 10,
    });
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it("load() is undefined when the file does not exist yet — that is the migration signal", async () => {
    expect(await store.load()).toBeUndefined();
  });

  it("save() then flush() writes pretty-printed JSON, creating the folder", async () => {
    store.save({ driverName: "nick", debugLogging: true });
    await store.flush();

    const text = readFileSync(store.path, "utf-8");

    expect(JSON.parse(text)).toEqual({ driverName: "nick", debugLogging: true });
    expect(text).toContain("\n"); // pretty-printed
  });

  it("load() returns what was saved", async () => {
    store.save({ a: 1 });
    await store.flush();

    expect(await store.load()).toEqual({ a: 1 });
  });

  it("debounces: rapid saves produce one file write with the LAST value", async () => {
    store.save({ n: 1 });
    store.save({ n: 2 });
    store.save({ n: 3 });
    await store.flush();

    expect(await store.load()).toEqual({ n: 3 });
    // No stray temp files left behind by the atomic write.
    expect(readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes atomically — a reader never sees a partial file (temp + rename)", async () => {
    store.save({ big: "x".repeat(200_000) });
    await store.flush();

    expect(readdirSync(join(dir, "sub"))).toEqual(["global-settings.json"]);
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ big: "x".repeat(200_000) });
  });

  it("moves a corrupt file aside and returns undefined — never silently discards a user's file", async () => {
    const dirty = join(dir, "sub");
    writeFileSync(join(dir, "sub-placeholder"), ""); // ensure dir exists via a save first
    store.save({ ok: true });
    await store.flush();
    writeFileSync(store.path, "{ not json", "utf-8");

    expect(await store.load()).toBeUndefined();
    const aside = readdirSync(dirty).filter((f) => /^global-settings\.corrupt-.*\.json$/.test(f));
    expect(aside).toHaveLength(1);
    expect(existsSync(store.path)).toBe(false);
  });

  it("flush() with nothing pending resolves immediately", async () => {
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
```

Add `import { afterEach, beforeEach } from "vitest";` to the existing vitest import.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/deck-core/src/settings-store.test.ts`
Expected: FAIL — `createFileSettingsStore` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/deck-core/src/settings-store.ts
import type { ILogger } from "@iracedeck/logger";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SettingsStore {
  readonly path: string;
  load(): Promise<Record<string, unknown> | undefined>;
  save(settings: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface FileSettingsStoreOptions {
  path: string;
  logger: ILogger;
  /** Trailing debounce for save(); default 250 ms. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * File-backed store: JSON, pretty-printed, ATOMIC (temp + rename) so a reader
 * never sees a partial file, DEBOUNCED so slider drags and key-binding
 * recording don't hammer the disk. A malformed file is moved aside as
 * `global-settings.corrupt-<iso>.json` and reported as "no file" — a user's
 * file is never silently discarded.
 */
export function createFileSettingsStore(opts: FileSettingsStoreOptions): SettingsStore {
  const { path, logger } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pending: Record<string, unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  async function writeNow(settings: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;

    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmp, path);
    logger.debug(`Settings saved: ${path}`);
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);

    timer = setTimeout(() => {
      timer = undefined;
      const toWrite = pending;

      pending = undefined;

      if (toWrite === undefined) return;

      inFlight = inFlight
        .then(() => writeNow(toWrite))
        .catch((error: unknown) => {
          logger.error(`Settings save failed: ${String(error)}`);
        });
    }, debounceMs);
  }

  return {
    path,

    async load() {
      let text: string;

      try {
        text = await readFile(path, "utf-8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

        throw error;
      }

      try {
        const parsed: unknown = JSON.parse(text);

        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");

        return parsed as Record<string, unknown>;
      } catch (error: unknown) {
        const aside = path.replace(/\.json$/, "") + `.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

        logger.error("Settings file is not valid JSON; moving it aside and starting fresh");
        logger.debug(`Corrupt settings file ${path} → ${aside}: ${String(error)}`);
        await rename(path, aside);

        return undefined;
      }
    },

    save(settings) {
      pending = settings;
      schedule();
    },

    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      const toWrite = pending;

      pending = undefined;

      if (toWrite !== undefined) {
        inFlight = inFlight
          .then(() => writeNow(toWrite))
          .catch((error: unknown) => {
            logger.error(`Settings save failed: ${String(error)}`);
          });
      }

      await inFlight;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/deck-core/src/settings-store.test.ts`
Expected: PASS (12 tests). If the corrupt-file test fails on the placeholder line, delete that `writeFileSync(join(dir, "sub-placeholder"), "")` line — the preceding `save`+`flush` already creates the folder.

- [ ] **Step 5: Export from the barrel and commit**

Add to `packages/deck-core/src/index.ts` next to the global-settings export block:

```ts
// Plugin-owned settings store (issue #993)
export {
  createFileSettingsStore,
  resolveSettingsStorePath,
  settingsStoreFolderName,
  type FileSettingsStoreOptions,
  type ResolveSettingsStorePathOptions,
  type SettingsStore,
} from "./settings-store.js";
```

```bash
git add packages/deck-core/src/settings-store.ts packages/deck-core/src/settings-store.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): file-backed SettingsStore — atomic, debounced, corrupt-file move-aside (#993)"
```

---

### Task 3: In-memory store for tests + `initGlobalSettings(adapter, logger, store)` signature

The core rewrite (Task 4) is large; this task only introduces the third parameter and an in-memory store so every existing test and consumer can be adapted **before** behaviour changes. Behaviour stays identical in this task.

**Files:**

- Modify: `packages/deck-core/src/settings-store.ts` (add `createMemorySettingsStore`)
- Modify: `packages/deck-core/src/global-settings.ts:1224` (signature only; store stored in a module `let storeRef: SettingsStore | null`)
- Modify: `packages/deck-core/src/global-settings.test.ts` (every `initGlobalSettings(adapter, logger)` call → add a memory store)
- Modify: `packages/deck-core/src/window-focus-service.test.ts`, `packages/deck-core/src/dual-press.test.ts` (same)
- Modify: `packages/scenario-harness/src/main.ts` (pass a memory store)
- Modify: `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/src/plugin.ts` (create the file store, pass it — **not used yet**)
- Test: `packages/deck-core/src/settings-store.test.ts`

**Interfaces:**

- Produces: `createMemorySettingsStore(initial?: Record<string, unknown>): SettingsStore & { readonly saved: Array<Record<string, unknown>> }` (synchronous-enough: `save` records; `flush` resolves; `load` returns `initial`).
- `initGlobalSettings(adapter: IDeckPlatformAdapter, log: ILogger, store: SettingsStore): GlobalSettings`

- [ ] **Step 1: Write the failing test for the memory store**

```ts
// append to settings-store.test.ts
describe("createMemorySettingsStore", () => {
  it("returns the seed from load(), records every save(), and flush() resolves", async () => {
    const store = createMemorySettingsStore({ a: 1 });

    expect(await store.load()).toEqual({ a: 1 });
    store.save({ a: 2 });
    await store.flush();
    expect(store.saved).toEqual([{ a: 2 }]);
  });

  it("load() is undefined with no seed", async () => {
    expect(await createMemorySettingsStore().load()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/deck-core/src/settings-store.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
// append to settings-store.ts
/** Test / harness store: no disk. `saved` records every save() payload in order. */
export function createMemorySettingsStore(
  initial?: Record<string, unknown>,
): SettingsStore & { readonly saved: Array<Record<string, unknown>> } {
  const saved: Array<Record<string, unknown>> = [];

  return {
    path: "<memory>",
    saved,
    load: async () => (initial === undefined ? undefined : { ...initial }),
    save: (settings) => {
      saved.push({ ...settings });
    },
    flush: async () => {},
  };
}
```

Export it from `index.ts` in the same block as Task 2.

- [ ] **Step 4: Add the parameter (unused for now) and adapt every caller**

In `global-settings.ts`:

```ts
// near the other module-level refs (~L1062)
let storeRef: SettingsStore | null = null;
```

```ts
export function initGlobalSettings(adapter: IDeckPlatformAdapter, log: ILogger, store: SettingsStore): GlobalSettings {
  storeRef = store;
  // ...existing body unchanged...
```

`_resetGlobalSettings()` sets `storeRef = null`. Add `import type { SettingsStore } from "./settings-store.js";`.

Callers — every `initGlobalSettings(<adapter>, <logger>)` in the files listed above becomes `initGlobalSettings(<adapter>, <logger>, createMemorySettingsStore())` in tests/harness, and in each `plugin.ts`:

```ts
// plugin.ts — right before initGlobalSettings(...)
const settingsStore = createFileSettingsStore({
  path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
  logger: adapter.createLogger("SettingsStore"),
});
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore);
```

(`getPluginPlatform` is already imported in all three plugin.ts files; add `createFileSettingsStore, resolveSettingsStorePath` to the deck-core import.)

- [ ] **Step 5: Build + full test, then commit**

Run: `pnpm build && pnpm test`
Expected: build 22/22, all tests green (behaviour unchanged).

```bash
git add -A packages/deck-core/src packages/scenario-harness/src packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "refactor(deck-core): initGlobalSettings takes a SettingsStore (unused yet); memory store for tests; plugins create the file store (#993)"
```

---

### Task 4: The single-writer core — load from the store, migrate once from the host, save on write, delete the dual-writer machinery

This is the heart of the change. Work strictly test-first inside `global-settings.test.ts`: **first delete** the four #896 describe blocks (`first-arrival write gate`, `pending-write overlay on host echoes`, `pending-delete reconciliation on host echoes`, `shrink guard on outgoing writes`) — they test behaviour that is being removed — then add the new block below, watch it fail, then rewrite the core.

**Files:**

- Modify: `packages/deck-core/src/global-settings.ts` — replace L1041–1330 (state + `initGlobalSettings`) and L1379–1533 (`updateGlobalSettings`, `deleteGlobalSettings`, `applyParsedSettings`) as shown; keep `GlobalSettingsSchema`, `parseWithSalvage`, `sameValue` (exported — the window's diff uses it), `getGlobalSettings`, `onGlobalSettingsChange`, `getGlobalColors`, `resolveActive*`, `isGlobalSettingsInitialized`, `_resetGlobalSettings`.
- Modify: `packages/deck-core/src/global-settings.test.ts`
- Rename everywhere: `hasReceivedHostSettings` → `isSettingsStoreReady` (`global-settings.ts`, `index.ts`, `global-settings-migrations.ts:48`, `window-focus-service.ts` + test, `binding-dispatcher.ts` if it uses it, `packages/iracing-plugin-stream-deck/src/shared/index.ts` re-export).

**Interfaces:**

- Consumes: `SettingsStore` (Task 2), `createMemorySettingsStore` (Task 3).
- Produces: `isSettingsStoreReady(): boolean`; `initGlobalSettings` now **async-safe**: it returns the current (default) cache immediately and completes loading in the background; listeners fire once when the store (or migration) is ready. New exported constant `MIGRATION_TIMEOUT_MS = 10_000`. New optional 4th param `initGlobalSettings(adapter, log, store, opts?: { migrationTimeoutMs?: number })` for tests.

- [ ] **Step 1: Delete the four obsolete describe blocks, then write the failing tests**

```ts
// append to packages/deck-core/src/global-settings.test.ts
import { isSettingsStoreReady, MIGRATION_TIMEOUT_MS } from "./global-settings.js";
import { createMemorySettingsStore } from "./settings-store.js";

/** Let the async load/migration inside initGlobalSettings settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("single-writer store (issue #993)", () => {
  beforeEach(() => _resetGlobalSettings());

  it("loads the cache from the store and marks the store ready; the host is NOT asked", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick", debugLogging: "true" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(true);
    expect(getGlobalSettings().driverName).toBe("nick");
    expect(getGlobalSettings().debugLogging).toBe(true); // parsed
    expect(mock.getGlobalSettings).not.toHaveBeenCalled();
  });

  it("fires onGlobalSettingsChange listeners exactly once when the store is ready", async () => {
    const mock = createMockAdapter();
    const listener = vi.fn();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
    onGlobalSettingsChange(listener);
    await tick();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick" });
  });

  it("with no file, migrates ONCE from the host: asks, writes the host payload to the store, then is ready", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore(); // no file
    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(false);
    expect(mock.getGlobalSettings).toHaveBeenCalledTimes(1);

    mock.echo?.({ driverName: "host-nick", blackBoxLapTiming: '{"type":"keyboard","key":"f1","modifiers":[]}' });
    await store.flush();

    expect(isSettingsStoreReady()).toBe(true);
    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved.at(-1)).toMatchObject({ driverName: "host-nick", blackBoxLapTiming: expect.any(String) });
  });

  it("migration leaves the host copy alone — no host write happens during or after migration", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore());
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    await tick();
    updateGlobalSettings({ driverName: "later" });

    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("with no file and a silent host, becomes ready with schema defaults after the migration timeout", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockAdapter();
      const store = createMemorySettingsStore();
      initGlobalSettings(mock.adapter, createMockLogger(), store, { migrationTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(10);
      expect(isSettingsStoreReady()).toBe(false);
      await vi.advanceTimersByTimeAsync(60);

      expect(isSettingsStoreReady()).toBe(true);
      expect(store.saved).toHaveLength(1); // the fresh file was written
    } finally {
      vi.useRealTimers();
    }
  });

  it("MIGRATION_TIMEOUT_MS is ten seconds", () => {
    expect(MIGRATION_TIMEOUT_MS).toBe(10_000);
  });

  it("updateGlobalSettings merges, parses, notifies, and saves the WHOLE cache to the store", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });
    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    updateGlobalSettings({ debugLogging: "true" });

    expect(getGlobalSettings().debugLogging).toBe(true);
    expect(getGlobalSettings().driverName).toBe("nick");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nick", debugLogging: true });
  });

  it("deleteGlobalSettings removes passthrough keys from the cache and saves", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ _legacyKey: 1, driverName: "nick" });
    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    deleteGlobalSettings(["_legacyKey"]);

    expect((getGlobalSettings() as Record<string, unknown>)._legacyKey).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty("_legacyKey");
  });

  it("writes made BEFORE the store is ready are applied over the loaded/migrated settings, not lost", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore(); // migration path
    initGlobalSettings(mock.adapter, createMockLogger(), store);
    updateGlobalSettings({ _audioDeviceList: "[]" }); // the plugin does this at startup (#610 probe etc.)
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    await store.flush();

    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect((getGlobalSettings() as Record<string, unknown>)._audioDeviceList).toBe("[]");
    expect(store.saved.at(-1)).toMatchObject({ driverName: "host-nick", _audioDeviceList: "[]" });
  });

  it("host payloads arriving after the store is ready are ignored for the cache (the host is not truth)", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
    await tick();

    mock.echo?.({ driverName: "stale-host" });

    expect(getGlobalSettings().driverName).toBe("nick");
  });

  it("per-key salvage still applies to a partially-bad file: one bad value drops to its default, the rest load", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(
      mock.adapter,
      createMockLogger(),
      createMemorySettingsStore({ driverName: "nick", changelogNotification: { bogus: true } }),
    );
    await tick();

    expect(getGlobalSettings().driverName).toBe("nick");
    expect(getGlobalSettings().changelogNotification).toBe("features");
  });
});
```

Also update every remaining test in the file that relied on the host echo to _load_ settings (search for `echo?.(` outside the deleted blocks): those tests should now seed `createMemorySettingsStore({...})` and `await tick()` instead. The `host payload salvage` block becomes a store-load salvage test (seed the bad value in the memory store).

- [ ] **Step 2: Run to verify the new block fails and the rest still passes**

Run: `pnpm exec vitest run packages/deck-core/src/global-settings.test.ts`
Expected: the new `single-writer store` tests FAIL (`isSettingsStoreReady`/`MIGRATION_TIMEOUT_MS` not exported; behaviour missing); previously green non-#896 tests still PASS.

- [ ] **Step 3: Rewrite the core**

Replace the module state block (old L1041–1111) with:

```ts
let currentSettings: GlobalSettings = GlobalSettingsSchema.parse({});
const listeners: Set<GlobalSettingsListener> = new Set();
let initialized = false;
let logger: ILogger | null = null;
let adapterRef: IDeckPlatformAdapter | null = null;
let storeRef: SettingsStore | null = null;

/**
 * True once the cache reflects the store — loaded from the file, or migrated
 * once from the deck host (issue #993). Until then the cache is pure schema
 * defaults; anything that must not act on defaults (window focus, one-shot
 * migrations, the plugins' startup-defaults block) gates on this.
 */
let storeReady = false;

/** Writes made before the store is ready; applied over the loaded settings when it is. */
let earlyWrites: Record<string, unknown> | null = null;
let earlyDeletes: Set<string> | null = null;

/** How long to wait for the deck host to answer the one-time migration read. */
export const MIGRATION_TIMEOUT_MS = 10_000;
```

Delete `PendingLocalWrite`, `pendingLocalWrites`, `pendingLocalDeletes`, `lastHostSettings`, `hostSettingsReceived`, `hasQueuedWrites`, and `persistCurrentSettings`. Keep `sameValue` and `parseWithSalvage` unchanged.

Replace `initGlobalSettings` (old L1224–1330):

```ts
export interface InitGlobalSettingsOptions {
  /** Test hook; production uses MIGRATION_TIMEOUT_MS. */
  migrationTimeoutMs?: number;
}

export function initGlobalSettings(
  adapter: IDeckPlatformAdapter,
  log: ILogger,
  store: SettingsStore,
  opts: InitGlobalSettingsOptions = {},
): GlobalSettings {
  if (initialized) {
    logger?.warn("Global settings already initialized");

    return currentSettings;
  }

  logger = log;
  adapterRef = adapter;
  storeRef = store;
  initialized = true;

  const migrationTimeoutMs = opts.migrationTimeoutMs ?? MIGRATION_TIMEOUT_MS;
  let migrationTimer: ReturnType<typeof setTimeout> | undefined;
  let migrationDone = false;

  const becomeReady = (raw: Record<string, unknown>, source: "file" | "host" | "fresh"): void => {
    if (storeReady) return;

    const merged = { ...raw };

    // Early writes/deletes (made before ready) win over the loaded settings —
    // anything written this session is newer than storage.
    if (earlyDeletes) for (const key of earlyDeletes) delete merged[key];
    if (earlyWrites) Object.assign(merged, earlyWrites);

    const salvage = parseWithSalvage(merged);

    if (salvage === null) {
      logger?.error("Stored settings unparseable; starting from schema defaults");
    } else {
      if (salvage.droppedKeys.length > 0) {
        logger?.warn("Some stored settings were invalid and reset to defaults");
        logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
      }

      currentSettings = salvage.settings;
    }

    storeReady = true;
    earlyWrites = null;
    earlyDeletes = null;
    logger?.info(
      source === "file"
        ? "Global settings loaded from the settings file"
        : source === "host"
          ? "Migrated global settings from the deck host"
          : "No stored settings found; starting fresh",
    );
    logger?.debug(`Settings store: ${store.path}`);

    // Migration and fresh start both write the file so the next start loads
    // it directly. A file load re-saves too — harmless, and it heals a file
    // whose salvage dropped keys.
    store.save({ ...currentSettings } as Record<string, unknown>);
    notifyListeners();
  };

  // The host is consulted ONLY as a migration source. Any later payload is
  // ignored for the cache — the store is truth (#993).
  adapter.onDidReceiveGlobalSettings((settings: unknown) => {
    logger?.info("Settings received from host");
    logger?.debug(`Raw host settings: ${JSON.stringify(settings)}`);

    if (storeReady || migrationDone) {
      logger?.debug("Ignoring host settings payload: the settings store is authoritative");

      return;
    }

    migrationDone = true;
    if (migrationTimer !== undefined) clearTimeout(migrationTimer);

    const raw = (settings !== null && typeof settings === "object" ? settings : {}) as Record<string, unknown>;

    becomeReady(raw, "host");
  });

  void store
    .load()
    .then((loaded) => {
      if (loaded !== undefined) {
        becomeReady(loaded, "file");

        return;
      }

      // No file yet: migrate once from the host, or start fresh on timeout.
      logger?.info("No settings file yet; requesting the deck host's settings for a one-time migration");
      adapter.getGlobalSettings();
      migrationTimer = setTimeout(() => {
        if (storeReady || migrationDone) return;

        migrationDone = true;
        logger?.warn("Deck host did not answer the migration read; starting fresh");
        becomeReady({}, "fresh");
      }, migrationTimeoutMs);
    })
    .catch((error: unknown) => {
      logger?.error(`Settings store load failed: ${String(error)}`);
      becomeReady({}, "fresh");
    });

  return currentSettings;
}

/** True once the cache reflects the store (loaded or migrated). */
export function isSettingsStoreReady(): boolean {
  return storeReady;
}
```

Replace `updateGlobalSettings` (old L1379–1476):

```ts
export function updateGlobalSettings(partial: Record<string, unknown>): void {
  logger?.info("Updating global settings");
  logger?.debug(`Partial update: ${JSON.stringify(partial)}`);

  if (!storeReady) {
    // Applied over the loaded settings when the store is ready — read-your-writes now.
    earlyWrites = { ...(earlyWrites ?? {}), ...partial };
    for (const key of Object.keys(partial)) earlyDeletes?.delete(key);
  }

  const base = { ...(currentSettings as Record<string, unknown>) };
  const merged = { ...base, ...partial };
  const salvage = parseWithSalvage(merged);

  if (salvage === null) {
    logger?.error("Global settings update rejected: result unparseable");

    return;
  }

  if (salvage.droppedKeys.length > 0) {
    logger?.warn("Some updated settings were invalid and kept their previous values");
    logger?.debug(`Dropped keys: ${salvage.droppedKeys.join(", ")}`);
  }

  applyParsedSettings(salvage.settings);

  if (storeReady) storeRef?.save({ ...currentSettings } as Record<string, unknown>);
}
```

Replace `deleteGlobalSettings` (old L1477–1533):

```ts
export function deleteGlobalSettings(keys: readonly string[]): void {
  logger?.info("Deleting global settings keys");
  logger?.debug(`Keys: ${keys.join(", ")}`);

  if (!storeReady) {
    earlyDeletes = new Set([...(earlyDeletes ?? []), ...keys]);
    if (earlyWrites) for (const key of keys) delete earlyWrites[key];
  }

  const next = { ...(currentSettings as Record<string, unknown>) };

  for (const key of keys) delete next[key];

  const salvage = parseWithSalvage(next);

  if (salvage === null) return;

  applyParsedSettings(salvage.settings);

  if (storeReady) storeRef?.save({ ...currentSettings } as Record<string, unknown>);
}
```

`applyParsedSettings` stays as-is (assigns `currentSettings` and calls `notifyListeners`). In `_resetGlobalSettings()` add: `storeRef = null; storeReady = false; earlyWrites = null; earlyDeletes = null;` and remove the deleted state resets. Rename `hasReceivedHostSettings` → `isSettingsStoreReady` in: `index.ts` (export), `global-settings-migrations.ts:48`, `window-focus-service.ts` (+ its test), `binding-dispatcher.ts` (if present), `packages/iracing-plugin-stream-deck/src/shared/index.ts` (re-export). Also `notifyListeners` must exist (it does today inside `applyParsedSettings`; hoist it into a small function if it isn't one).

- [ ] **Step 4: Run the deck-core suite, then the whole suite**

Run: `pnpm exec vitest run packages/deck-core` then `pnpm test`
Expected: PASS. If a plugin-level or harness test asserted on `adapter.setGlobalSettings` being called for a plugin write, that assertion is now wrong — remove it (the plugin no longer writes the host).

- [ ] **Step 5: `pnpm build --force`, then commit**

Run: `pnpm build --force`
Expected: 22/22.

```bash
git add -A packages/deck-core/src packages/iracing-plugin-stream-deck/src/shared/index.ts
git commit -m "feat(deck-core): single-writer global settings — the store is truth, the host is a one-time migration source; #896 machinery deleted (#993)"
```

---

### Task 5: Delete the Ulanzi adapter's write gate

**Files:**

- Modify: `packages/deck-adapter-ulanzi/src/adapter.ts` (the `setGlobalSettings` gate ~L342–365, `globalSettingsWriteGateOpen`, `pendingGlobalSettingsWrite`, `globalSettingsWriteGateTimer`, `GLOBAL_SETTINGS_WRITE_GATE_TIMEOUT_MS`, and the place the gate is opened on the first reply)
- Modify: `packages/deck-adapter-ulanzi/src/adapter.test.ts` (delete the gate tests; add the one below)
- Modify: `packages/deck-adapter-ulanzi/CLAUDE.md` (remove the write-gate paragraph; add "since #993 the plugin writes the host exactly once per start (`_settingsChannel`)")

- [ ] **Step 1: Write the failing test**

```ts
describe("setGlobalSettings (#993: no write gate)", () => {
  it("forwards immediately — the plugin owns the settings store, so an early write can no longer wipe anything", () => {
    adapter.setGlobalSettings({ _settingsChannel: { port: 1, token: "t" } });

    expect(client.setGlobalSettings).toHaveBeenCalledWith({ _settingsChannel: { port: 1, token: "t" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run packages/deck-adapter-ulanzi/src/adapter.test.ts` — Expected: FAIL (the gate buffers the write).

- [ ] **Step 3: Implement** — `setGlobalSettings(settings) { this.client.setGlobalSettings(settings); }`; delete the gate fields, timer, constant, and the "open the gate on first reply" code; delete the gate tests.

- [ ] **Step 4: Run** — PASS. Then `pnpm exec vitest run packages/deck-adapter-ulanzi`.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-adapter-ulanzi
git commit -m "refactor(deck-adapter-ulanzi): remove the global-settings write gate — the plugin owns the store now (#993)"
```

---

### Task 6: Settings server at startup + `_settingsChannel`

**Files:**

- Modify: `packages/deck-core/src/settings-window-server.ts` (expose `token`)
- Modify: `packages/deck-core/src/settings-window.ts` (`ensureStarted(): Promise<{ port: number; token: string }>`)
- Modify: `packages/deck-core/src/settings-window.test.ts`
- Modify: `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/src/plugin.ts`

**Interfaces:**

- Produces: `SettingsWindowServer.token: string`; `SettingsWindowController.ensureStarted(): Promise<{ port: number; token: string }>`; the plugins publish `updateGlobalSettings({ _settingsChannel: { port, token } })` once the store is ready (~~**and** `adapter.setGlobalSettings({ _settingsChannel: { port, token } })`~~ — removed in the phase-1 final review, see the note under Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
// settings-window.test.ts
describe("createSettingsWindowController.ensureStarted (#993)", () => {
  it("starts the server without opening a window and returns the channel", async () => {
    const spawnApp = vi.fn();
    const controller = createSettingsWindowController({
      renderPage: () => PAGE,
      findBrowser: () => "C:/edge/msedge.exe",
      spawnApp,
      openUrl: vi.fn(async (_url: string) => {}),
      logger: silentLogger,
    });
    teardown = () => controller.close();

    const channel = await controller.ensureStarted();

    expect(channel.port).toBeGreaterThan(0);
    expect(channel.token).toMatch(/^[0-9a-f]{32,}$/);
    expect(spawnApp).not.toHaveBeenCalled();
    // A later open() reuses the same server.
    await controller.open();
    expect(new URL(spawnApp.mock.calls[0]?.[1] as string).port).toBe(String(channel.port));
  });
});
```

- [ ] **Step 2: Run** — FAIL (`ensureStarted` not a function).

- [ ] **Step 3: Implement**

In `settings-window-server.ts`: add `readonly token: string` to `SettingsWindowServer` and return `token` from `startSettingsWindowServer`. In `settings-window.ts`:

```ts
export interface SettingsWindowController {
  /** Start the server (idempotent) without opening a window; the PI bridge needs the channel (#993). */
  ensureStarted(): Promise<{ port: number; token: string }>;
  open(): Promise<SettingsWindowLaunch>;
  close(): Promise<void>;
}
```

Extract the server-start block inside `open()` into a private `async function ensureServer(): Promise<SettingsWindowServer>` and have `ensureStarted` return `{ port: Number(new URL(server.url).port), token: server.token }`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Wire the plugins**

In each `plugin.ts`, inside the `if (!startupDefaultsApplied) { … }` first-arrival block (which now fires when the store is ready — it is driven by `onGlobalSettingsChange`, unchanged), add at its end:

```ts
// #993: the settings server is the channel every UI uses; publish where it
// is. `_settingsChannel` in the store is for the window's own use.
// SUPERSEDED (phase-1 final review): the `adapter.setGlobalSettings(...)`
// line below was REMOVED — host setGlobalSettings replaces the whole object
// and wiped the migrated copy. Phase 2 adds a guarded-mirror bootstrap
// write instead (see the spec Amendment). Shipped shape: store write only.
void settingsWindow.ensureStarted().then(({ port, token }) => {
  updateGlobalSettings({ _settingsChannel: { port, token } });
  // adapter.setGlobalSettings({ _settingsChannel: { port, token } }); // removed, see above
});
```

(`settingsWindow` is declared later in the file than this block in the current layout — move the controller creation above the `onGlobalSettingsChange` registration, or reference it lazily via a `let`. Keep the file compiling.)

- [ ] **Step 6: Build + test + commit**

Run: `pnpm build && pnpm test`

```bash
git add packages/deck-core/src packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(settings-window): server starts at plugin startup; _settingsChannel published (store + one host write) for the PI bridge (#993)"
```

---

### Task 7: Storage card — where the file is, and Open folder

**Files:**

- Modify: `packages/deck-core/src/settings-window-commands.ts` (+ test): `openSettingsFolder` → injected `openFolder: (path: string) => void`
- Create: `packages/deck-core/src/open-folder.ts` (+ test for the arg list): `explorerSelectArgs(path)`, `openFolderInExplorer(path)` (spawn `explorer.exe /select,<path>`, detached, Windows-only — a second `child_process` use, stated in the file header)
- Modify: `packages/pi-components/partials/global-common-diagnostics.ejs`: append a "Settings file" `sdpi-item` showing a read-only path via a new `_settingsStorePath` passthrough global (the plugin publishes it at startup, like `_deckDevices`) — rendered with `<sdpi-textfield setting="_settingsStorePath" global disabled>` — plus, **only under `locals.settingsWindow`**, an `ird-open-settings`-style button `ird-open-folder` (new component, mirrors `ird-open-settings`, sends `sendToPlugin {event:"openSettingsFolder"}`)
- Modify: `packages/pi-components/src/components/index.ts`; new `open-folder.ts` (+ test, mirror `open-settings.test.ts`)
- Modify: each `plugin.ts`: publish `_settingsStorePath: settingsStore.path` in the first-arrival block; wire `openFolder: openFolderInExplorer` into the command handler deps.

- [ ] **Step 1: Write the failing tests**

```ts
// settings-window-commands.test.ts (append inside the createSettingsWindowCommandHandler describe)
it("routes openSettingsFolder to the injected opener with the PLUGIN's store path — never a path from the page", () => {
  const openFolder = vi.fn();
  const handle = createSettingsWindowCommandHandler({
    writeSettings: vi.fn(),
    openFolder,
    storePath: "C:\\s\\global-settings.json",
  });

  handle({ event: "openSettingsFolder", path: "C:\\Windows\\evil" });

  expect(openFolder).toHaveBeenCalledWith("C:\\s\\global-settings.json");
});
```

```ts
// packages/deck-core/src/open-folder.test.ts (new)
import { describe, expect, it } from "vitest";

import { explorerSelectArgs } from "./open-folder.js";

describe("explorerSelectArgs", () => {
  it("selects the file in Explorer — one argument, no shell quoting", () => {
    expect(
      explorerSelectArgs("C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json"),
    ).toEqual([
      "/select,C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json",
    ]);
  });
});
```

`packages/pi-components/src/components/open-folder.test.ts` (new): copy `open-settings.test.ts` and change the element name to `ird-open-folder`, the default label to `Open folder`, and the expected send to `{ event: "openSettingsFolder" }`.

```ts
// accordion-partial.test.ts (append)
describe("global-common-diagnostics.ejs storage row (#993)", () => {
  it("shows the settings file path on both surfaces, and the Open folder button only in the window", () => {
    const pi = render("<%- include('global-common-diagnostics') %>");
    const win = render("<%- include('global-common-diagnostics', { settingsWindow: true }) %>");

    expect(pi).toContain('setting="_settingsStorePath"');
    expect(pi).not.toContain("<ird-open-folder");
    expect(win).toContain('setting="_settingsStorePath"');
    expect(win).toContain("<ird-open-folder");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/deck-core/src/settings-window-commands.test.ts packages/deck-core/src/open-folder.test.ts packages/pi-components/src/components/open-folder.test.ts packages/pi-components/src/build/accordion-partial.test.ts`
Expected: FAIL (missing exports / element / markup).

- [ ] **Step 3: Implement**

```ts
// packages/deck-core/src/open-folder.ts
/**
 * Reveal a file in Windows Explorer (issue #993 — the settings window's
 * "Open folder"). The SECOND child_process use in the plugin beside the
 * settings-window spawn; the path always comes from the plugin's own store,
 * never from a page. `openUrl` is deliberately http(s)-only, so this does not
 * go through it.
 */
import { spawn } from "node:child_process";

export function explorerSelectArgs(filePath: string): string[] {
  return [`/select,${filePath}`];
}

export function openFolderInExplorer(filePath: string): void {
  spawn("explorer.exe", explorerSelectArgs(filePath), { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
```

Command handler (`settings-window-commands.ts`): add `openFolder?: (path: string) => void; storePath?: string` to `SettingsWindowCommandDeps` and

```ts
      case "openSettingsFolder":
        if (deps.openFolder && deps.storePath) deps.openFolder(deps.storePath);

        break;
```

Component: copy `open-settings.ts` → `open-folder.ts` (`ird-open-folder`, default label `Open folder`, payload `{ event: "openSettingsFolder" }`), export `OpenFolder` from `components/index.ts`.

Partial `global-common-diagnostics.ejs`, append:

```ejs
<sdpi-item label="Settings file">
  <sdpi-textfield setting="_settingsStorePath" global disabled></sdpi-textfield>
</sdpi-item>
<div class="ird-supporting-text">Where iRaceDeck stores every setting on this page. Back this file up to keep your configuration.</div>
<% if (locals.settingsWindow) { %>
<div class="ird-open-settings"><ird-open-folder></ird-open-folder></div>
<% } %>
```

Plugins (all three `plugin.ts`): in the first-arrival block `updateGlobalSettings({ _settingsStorePath: settingsStore.path })`; the command-handler deps gain `openFolder: openFolderInExplorer, storePath: settingsStore.path`. Export `openFolderInExplorer`, `explorerSelectArgs` from deck-core's `index.ts`.

- [ ] **Step 4: Run to verify they pass, then build and check the artefacts**

Run: the same vitest command — Expected: PASS. Then `pnpm build`; then `grep -c "<ird-open-folder" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/settings-window.html` → `1`, and the same grep on `ui/car-control.html` → `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src packages/pi-components/src packages/pi-components/partials/global-common-diagnostics.ejs packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(settings-window): Storage card — settings file path + Open folder (#993)"
```

---

### Task 8: Docs, changelog, memory

**Files:**

- `.claude/rules/global-settings.md`: replace "Write semantics — stale-cache safety (#896)" with a "Single writer (#993)" section (store is truth; host read once; `_settingsChannel` is the one host write; `isSettingsStoreReady()` gate; the "changing a schema default reaches new installs only" rule still holds and why: the migrated file carries what the host had).
- `.claude/rules/settings-window.md`: rule 4 becomes an optimisation note; add "server starts at plugin startup; `_settingsChannel`".
- `packages/deck-adapter-ulanzi/CLAUDE.md`: done in Task 5; re-check.
- `packages/website/src/content/docs/docs/development/architecture.md`: the settings-path diagram — the host store becomes "read once (migration)"; the file store appears.
- `packages/website/src/content/docs/changelog.mdx`: **edit the existing settings-window line** to add: settings are now stored in a file the plugin owns (`%LOCALAPPDATA%\iRaceDeck\Settings\…`), migrated automatically from the deck software on first start, which also fixes settings not persisting on Ulanzi.
- `packages/website/src/content/docs/docs/features/settings-window.md`: a "Where your settings are stored" section.
- Memory (`~/.claude/projects/.../memory/`): update `project_ulanzi_settings_persist_nothing.md` (fixed for the plugin/window path by #993 phase 1 — pending Ulanzi tester), update the settings-window state note.

- [ ] Steps: edit, `pnpm --filter @iracedeck/website build`, `pnpm exec prettier --check` on the changed markdown, commit `docs(settings): plugin-owned store — rules, changelog, architecture, feature page (#993)`.

---

### Task 9: Hardware verification (Niklas) — the gate before phase 2

Not code. Restart Stream Deck on the build; confirm in order:

1. Plugin log: `No settings file yet; requesting …` → `Migrated global settings from the deck host` → the file exists at `%LOCALAPPDATA%\iRaceDeck\Settings\Stream Deck\global-settings.json` with the expected keys.
2. Window and PIs both show the migrated values (PIs still read the host copy in phase 1 — expected to match right after migration).
3. PIs are still **populated** after that first start — open two or three different actions' PIs and confirm their global sections are not blank or reset. Phase 1 writes nothing to the host, so nothing may have truncated its copy.
4. Change a setting in the **window** → the file changes → survives a restart. **This is the Ulanzi-fixing path.** Verify by **CONTENT, not mtime**: the file is re-saved on every start (the load-time re-save), so its mtime always looks fresh. Diff the JSON, or read back the specific key.
5. A change made in the window survives a plugin **restart initiated by the deck host** (not just a settings-window close) — that exercises the `process.on("exit")` → `flushSync()` path that lands a save still inside the 250 ms debounce.
6. Downgrade sanity: the host copy still holds the migrated values after a restart or two. In phase 1 this is expected to hold by construction, since the plugin never writes there.
7. Diagnostics → **Storage**: the settings-file path text is selectable/copyable. (It renders in a disabled `sdpi-textfield`, which may not be selectable — if it isn't, note it as a phase-2 polish item rather than a blocker.)
8. Diagnostics → **Open folder** opens Explorer with the settings file **selected**, not just the folder listed. The default path contains a space (`…\Settings\Stream Deck\…`), which is exactly the case the quoted `/select,"<path>"` argument form exists for.
9. Known phase-1 limitation to confirm, not fix: a change made in a **PI** goes to the host copy only and is **not** picked up by the plugin (the host is no longer read) — this is exactly what phase 2 (PI bridge) addresses; the PIs must be rerouted before release.

Then write the phase-2 plan (PI bridge, all hosts).
