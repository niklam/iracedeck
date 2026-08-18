# Plugin-Owned Settings Store — Phase 2: the PI Bridge (#993)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Property Inspector on every host (Elgato, Mirabox, Ulanzi) reads and writes plugin-global settings through the plugin's loopback settings server — the same fake host the settings window uses — so PI edits reach the plugin-owned settings file again, PIs show the file's values, and window ↔ PI ↔ PI stay in sync live. This closes the phase-1 caveat ("PI edits are inert; PIs never see plugin-published keys") and finishes what makes Ulanzi persist.

**Architecture:** A pure, shared **settings-channel router** (state machine, no DOM) decides, per PI page, where global-settings frames go: it bootstraps by reading `_settingsChannel` from the deck host once, opens `ws://127.0.0.1:<port>/ws?t=<token>` to the plugin, then routes `getGlobalSettings`/`setGlobalSettings` there and delivers the loopback's `didReceiveGlobalSettings` pushes to sdpi (dropping the host's), with a fallback to the host path when the channel is absent, the connect fails, or the host never answers. Two thin transports use it: a new **`pi-settings-bridge.js`** for Elgato/Mirabox (pre-defines `connectElgatoStreamDeckSocket` so it runs first inside sdpi's wrapper and arms a one-shot `WebSocket` interceptor for the host socket) and the existing **Ulanzi PI bridge**, which grows the same router inside `UlanziBridgeSocket`. The plugin makes the bootstrap possible with **one guarded mirror write** to the deck host per start (`{ ...cache, _settingsChannel }`, skipped when the store started fresh), and the loopback server's guard is relaxed so a **valid token authenticates regardless of `Origin`** (PIs are `file://`/host-served pages; the cookie path stays origin-strict). Everything else a PI sends (`sendToPlugin`, `openUrl`, `getSettings`/`setSettings`, `logMessage`) keeps going to the real host untouched.

**Tech Stack:** TypeScript (ESM), Node 20–24, Vitest, Rollup (IIFE browser bundles in `@iracedeck/pi-components`), the existing `node:http` + `ws` settings server, EJS/MDX docs.

**Spec:** `docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md` — §4.4 (the PI bridge), §4.5 (Ulanzi), §3 "Port + token delivery to PIs", §6, §7, §9, plus the **Amendment (phase-1 final review)** it already carries (host `setGlobalSettings` replaces the whole object → the bootstrap write is a guarded mirror). Phase 1 is on `release/3.0` (`912d61ff..b0cfd23f`); its plan is `docs/superpowers/plans/2026-08-16-issue-993-settings-store-phase-1.md`.

## Global Constraints

- Branch `release/3.0`, worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-release-3.0`. Commit locally; **do not push, do not open a PR** (Niklas asks for that explicitly). Rebuild + Stream Deck restart is Niklas's manual test; the plugin junction points at this worktree.
- **The plugin owns the settings file** (`%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck|Mirabox|Ulanzi>\global-settings.json`); the deck host store is read once for migration and — new in phase 2 — written **exactly once per start** with a FULL mirror `{ ...getGlobalSettings(), _settingsChannel: { port, token } }`, **skipped when the store became ready via the migration timeout ("fresh")** — a partial write or a defaults write would wipe the host copy (spec Amendment). Never write a partial to any host.
- The bootstrap channel is `_settingsChannel = { port: number, token: string }` (token = 48 hex chars from `randomBytes(24)`); PIs learn it from ONE host `getGlobalSettings` read and then use `ws://127.0.0.1:<port>/ws?t=<token>` — token on the upgrade query, no cookie.
- Guard: a request carrying the valid launch token is authorized **regardless of `Origin`**; without a valid token the existing rules stand (Origin must equal the loopback origin exactly, then the `SameSite=Strict` cookie must match). No CORS headers, ever. Loopback bind (`127.0.0.1`) unchanged.
- **Only global-settings frames are rerouted** (`getGlobalSettings`, `setGlobalSettings`, inbound `didReceiveGlobalSettings`). `sendToPlugin`, `openUrl`, `logMessage`, `getSettings`/`setSettings`/`didReceiveSettings`, `sendToPropertyInspector`, `registerPropertyInspector` pass through to/from the real host unchanged (spec §4.4).
- **Fallback, never a blank PI:** channel absent, loopback connect fails, or the host never answers the bootstrap read within `BOOTSTRAP_TIMEOUT_MS = 3000` → the PI keeps working against the host path (today's behaviour) with a `console.warn`.
- **Two bridge scripts must never share a page** (#992): Elgato/Mirabox action PIs get `pi-settings-bridge.js`; Ulanzi action PIs get the grown `ulanzi-pi-bridge.js`; `settings-window.html` keeps `settings-window-bridge.js` only. Every bridge tag sits immediately before `<script src="sdpi-components.js"></script>`; the build asserts it.
- TDD for every code step (failing test → run → minimal code → run → commit). Tests beside sources. `pnpm build` (not only `pnpm test`) after type edits — vitest is more permissive than tsc; deck-core type-checks its tests. Exact dependency versions. Logging: `info` = event without parameters, `debug` = details; the bridges log with `console.warn` only on fallback.
- Docs in the same change (Task 7): `.claude/rules/global-settings.md` (remove the phase-1 caveat, describe the phase-2 model), `.claude/rules/settings-window.md`, `packages/deck-adapter-ulanzi/CLAUDE.md`, `packages/iracing-plugin-ulanzi/CLAUDE.md`, root `.claude/CLAUDE.md` (pi-components row), the architecture page, `changelog.mdx` (edit the existing 2.5.0 settings-window bullet — no second bullet), the feature page, and a spec amendment for the guard/router decisions.

**Decisions beyond the spec text (recorded here so the executor does not re-derive them):** (1) token authenticates regardless of Origin (spec §9 assumed the window's origin-first guard would serve PIs; PIs are `file://` → `Origin: null`, or host-served origins — the strict check would reject them; the token is the secret, and cookie-only requests stay origin-strict, so DNS rebinding is still blocked); (2) the router bootstraps proactively on host open (it does not wait for sdpi's first `getGlobalSettings`), and it also switches late if a host push carrying `_settingsChannel` arrives while in fallback (covers PIs opened in the first seconds after plugin start); (3) one shared router for both bridges instead of two implementations; (4) the mirror write replaces the spec's original bare `{ _settingsChannel }` (Amendment).

---

## File Structure

| File                                                                                                                                                                    | Responsibility                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-components/src/settings-channel/router.ts` (new)                                                                                                           | `parseSettingsChannel`, `createSettingsChannelRouter` — the pure state machine both bridges use. `BOOTSTRAP_TIMEOUT_MS`.                                                                       |
| `packages/pi-components/src/settings-channel/router.test.ts` (new)                                                                                                      | Exhaustive router tests (no DOM).                                                                                                                                                              |
| `packages/pi-components/src/settings-channel/loopback.ts` (new) + `loopback.test.ts`                                                                                    | `loopbackUrl`, `openLoopbackSocket` — the one place that builds `ws://127.0.0.1:<port>/ws?t=<token>` and adapts a native `WebSocket` to the router's `LoopbackSocket`; shared by both bridges. |
| `packages/pi-components/src/pi-settings-bridge/index.ts` (new) + `index.test.ts`                                                                                        | Elgato/Mirabox transport: `installPiSettingsBridge(win)`, `PiSettingsBridgeSocket`.                                                                                                            |
| `packages/pi-components/tsconfig.pi-settings-bridge.json` (new), `tsconfig.ulanzi.json` (modify), `rollup.config.mjs` (modify), `package.json` `clean` script (modify)  | Build the new bundle `browser/pi-settings-bridge.js`; both bridge tsconfigs include `src/settings-channel/`.                                                                                   |
| `packages/pi-components/src/ulanzi-bridge/index.ts` (+ test)                                                                                                            | `UlanziBridgeSocket` routes global-settings frames through the router.                                                                                                                         |
| `packages/deck-core/src/settings-window-guard.ts` (+ test)                                                                                                              | Token-first authorization.                                                                                                                                                                     |
| `packages/deck-core/src/settings-window-server.ts` (+ test), `settings-window.ts`                                                                                       | `onUpgradeDecision` hook (debug log of accepted/rejected origins).                                                                                                                             |
| `packages/deck-core/src/global-settings.ts` (+ test), `index.ts`                                                                                                        | `getSettingsStoreSource()`, `hostMirrorPayload(channel)`.                                                                                                                                      |
| `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/src/plugin.ts`                                                                                                    | The guarded mirror write in the store-ready block.                                                                                                                                             |
| `packages/pi-components/src/build/index.mjs`, `inject-bridge-plugin.mjs` (+ test)                                                                                       | `PI_SETTINGS_BRIDGE` constant; `assertBridgeInjectionPlugin`.                                                                                                                                  |
| `packages/iracing-plugin-{stream-deck,mirabox}/rollup.config.mjs`, `packages/iracing-plugin-ulanzi/rollup.config.mjs`, `packages/iracing-plugin-stream-deck/.gitignore` | Copy + inject `pi-settings-bridge.js` into every Elgato/Mirabox action PI; assert on all three plugins.                                                                                        |
| Docs listed under Global Constraints.                                                                                                                                   |

**Interfaces shared across tasks (exact):**

```ts
// packages/pi-components/src/settings-channel/router.ts
export interface SettingsChannel { port: number; token: string }
export type PiFrame = Record<string, unknown> & { event?: unknown; payload?: unknown };
export interface LoopbackSocket { send(frame: PiFrame): void; close(): void }
export interface LoopbackHandlers { onOpen(): void; onMessage(frame: PiFrame): void; onClose(): void }
export interface SettingsChannelRouterDeps {
  identity: { context: string; action: string };
  toHost(frame: PiFrame): void;
  toPi(frame: PiFrame): void;
  openLoopback(channel: SettingsChannel, handlers: LoopbackHandlers): LoopbackSocket;
  warn(message: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  bootstrapTimeoutMs?: number;
}
export type RouterState = "idle" | "bootstrapping" | "connecting" | "loopback" | "fallback";
export interface SettingsChannelRouter {
  readonly state: RouterState;
  onHostOpen(): void;
  onPiSend(frame: PiFrame): void;
  onHostMessage(frame: PiFrame): void;
  onHostClose(): void;
}
export const BOOTSTRAP_TIMEOUT_MS = 3000;
export function parseSettingsChannel(settings: unknown): SettingsChannel | undefined;
export function createSettingsChannelRouter(deps: SettingsChannelRouterDeps): SettingsChannelRouter;

// packages/pi-components/src/settings-channel/loopback.ts
export function loopbackUrl(channel: SettingsChannel): string; // "ws://127.0.0.1:<port>/ws?t=<encoded token>"
export function openLoopbackSocket(channel: SettingsChannel, handlers: LoopbackHandlers, Native: typeof WebSocket): LoopbackSocket;

// packages/deck-core/src/global-settings.ts
export type SettingsStoreSource = "file" | "host" | "fresh";
export function getSettingsStoreSource(): SettingsStoreSource | null;
export function hostMirrorPayload(channel: { port: number; token: string }): Record<string, unknown> | undefined;

// packages/deck-core/src/settings-window-server.ts (new option)
onUpgradeDecision?: (decision: { allowed: boolean; reason?: "bad-origin" | "bad-token"; origin: string | undefined }) => void;

// packages/pi-components/src/build/index.mjs
export const PI_SETTINGS_BRIDGE = "pi-settings-bridge.js";
export function assertBridgeInjectionPlugin({ outputDir, expectedBridge }): RollupPlugin; // expectedBridge(fileName) → bridge filename that must appear exactly once
```

---

### Task 1: The settings-channel router (pure state machine)

**Files:**

- Create: `packages/pi-components/src/settings-channel/router.ts`
- Test: `packages/pi-components/src/settings-channel/router.test.ts`

**Interfaces:** Produces everything under `router.ts` in the shared-interfaces block above. Consumed by Tasks 4 and 5.

**Behaviour (the contract the tests pin):**

- `idle` → `onHostOpen()`: send `{ event: "getGlobalSettings", context, action }` to the host (the bootstrap read), state `bootstrapping`, arm the bootstrap timer.
- `onPiSend(frame)`: `getGlobalSettings`/`setGlobalSettings` → in `bootstrapping`/`connecting`: queue (in order); `loopback`: loopback socket; `idle`/`fallback`: host. Any other event → host, always.
- `onHostMessage(frame)`: any event other than `didReceiveGlobalSettings` → `toPi` (untouched). `didReceiveGlobalSettings`: `bootstrapping` → clear the timer; `parseSettingsChannel(payload.settings)`; channel → remember the frame as `lastHostPayload`, state `connecting`, `openLoopback` (a throw counts as an immediate close); no channel → `fallbackWith(frame, …no _settingsChannel…)`. `connecting` → remember as `lastHostPayload`, drop. `loopback` → drop (the store is truth). `fallback` → `toPi(frame)`; and if it carries a channel that differs from the last one tried (port or token) → late bootstrap: state `connecting`, `openLoopback`.
- Loopback handlers: `onOpen` → state `loopback`; send `{ event: "getGlobalSettings", context, action }` to the loopback (so sdpi gets the file's values promptly and any pending sdpi `getGlobalSettings` promise resolves); then flush the queue to the loopback in order. `onMessage(frame)` → `toPi(frame)`. `onClose` → if `connecting`: `fallbackWith(lastHostPayload, …refused…)`; if `loopback`: warn, state `fallback` (later frames go to the host).
- Bootstrap timer → warn, state `fallback`, flush the queue to the host.
- `fallbackWith(frame, why)`: warn, state `fallback`, `toPi(frame)` if a frame is known, flush the queue to the host.
- `onHostClose()` → close the loopback if open; clear the timer; state unchanged (the page is dead anyway).
- `parseSettingsChannel(settings)`: `settings` is an object with `_settingsChannel: { port, token }`, `port` an integer 1–65535, `token` matching `/^[0-9a-f]{32,}$/i` → `{ port, token }`; anything else → `undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pi-components/src/settings-channel/router.test.ts
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_TIMEOUT_MS,
  createSettingsChannelRouter,
  type LoopbackHandlers,
  type LoopbackSocket,
  parseSettingsChannel,
  type PiFrame,
  type SettingsChannel,
} from "./router.js";

const CHANNEL: SettingsChannel = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const IDENTITY = { context: "ctx-1", action: "com.iracedeck.sd.core.car-control" };
const BOOTSTRAP = { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action };

function hostReply(settings: Record<string, unknown>): PiFrame {
  return { event: "didReceiveGlobalSettings", payload: { settings } };
}

/** A router harness with fake host, fake sdpi, fake loopback and manual timers. */
function harness(opts: { openThrows?: boolean; bootstrapTimeoutMs?: number } = {}) {
  const host: PiFrame[] = [];
  const pi: PiFrame[] = [];
  const loop: PiFrame[] = [];
  const warnings: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const opened: SettingsChannel[] = [];
  let handlers: LoopbackHandlers | undefined;
  let closedLoop = 0;

  const router = createSettingsChannelRouter({
    identity: IDENTITY,
    toHost: (f) => host.push(f),
    toPi: (f) => pi.push(f),
    openLoopback: (channel, h): LoopbackSocket => {
      opened.push(channel);
      if (opts.openThrows) throw new Error("refused");
      handlers = h;

      return { send: (f) => loop.push(f), close: () => closedLoop++ };
    },
    warn: (m) => warnings.push(m),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);

      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    bootstrapTimeoutMs: opts.bootstrapTimeoutMs,
  });

  return {
    router,
    host,
    pi,
    loop,
    warnings,
    timers,
    opened,
    closedLoop: () => closedLoop,
    loopOpen: () => handlers!.onOpen(),
    loopMessage: (f: PiFrame) => handlers!.onMessage(f),
    loopClose: () => handlers!.onClose(),
    fireTimer: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
  };
}

describe("parseSettingsChannel", () => {
  it("accepts a well-formed channel", () => {
    expect(parseSettingsChannel({ _settingsChannel: CHANNEL, other: 1 })).toEqual(CHANNEL);
  });

  it("rejects a missing key, a bad port, a short token, and non-objects", () => {
    expect(parseSettingsChannel({})).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 0, token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 70000, token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: 8080, token: "abc" } })).toBeUndefined();
    expect(parseSettingsChannel({ _settingsChannel: { port: "8080", token: CHANNEL.token } })).toBeUndefined();
    expect(parseSettingsChannel(null)).toBeUndefined();
    expect(parseSettingsChannel("x")).toBeUndefined();
  });
});

describe("createSettingsChannelRouter", () => {
  it("bootstraps on host open with sdpi's own envelope shape and arms the timer", () => {
    const h = harness();

    expect(h.router.state).toBe("idle");
    h.router.onHostOpen();

    expect(h.router.state).toBe("bootstrapping");
    expect(h.host).toEqual([BOOTSTRAP]);
    expect(h.timers[0]?.ms).toBe(BOOTSTRAP_TIMEOUT_MS);
  });

  it("passes every non-global frame straight through in both directions", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "registerPropertyInspector", uuid: "ctx-1" });
    h.router.onPiSend({ event: "sendToPlugin", context: "ctx-1", payload: { event: "openSettings" } });
    h.router.onHostMessage({ event: "didReceiveSettings", payload: { settings: { a: 1 } } });

    expect(h.host.slice(1)).toEqual([
      { event: "registerPropertyInspector", uuid: "ctx-1" },
      { event: "sendToPlugin", context: "ctx-1", payload: { event: "openSettings" } },
    ]);
    expect(h.pi).toEqual([{ event: "didReceiveSettings", payload: { settings: { a: 1 } } }]);
  });

  it("queues global frames while bootstrapping, switches to the loopback on a channel, and replays the queue there", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings", context: "ctx-1" });
    h.router.onPiSend({ event: "setGlobalSettings", context: "ctx-1", payload: { driverName: "n" } });

    expect(h.host).toHaveLength(1); // only the bootstrap read went to the host
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL, driverName: "host" }));

    expect(h.router.state).toBe("connecting");
    expect(h.opened).toEqual([CHANNEL]);
    expect(h.timers[0]?.cleared).toBe(true);
    expect(h.pi).toEqual([]); // the host's payload is NOT delivered — the store is truth

    h.loopOpen();

    expect(h.router.state).toBe("loopback");
    expect(h.loop).toEqual([
      BOOTSTRAP, // the router's own read of the file's values
      { event: "getGlobalSettings", context: "ctx-1" },
      { event: "setGlobalSettings", context: "ctx-1", payload: { driverName: "n" } },
    ]);
  });

  it("in loopback state: sdpi's global frames go to the loopback, loopback pushes reach sdpi, host pushes are dropped", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.loop.length = 0;

    h.router.onPiSend({ event: "setGlobalSettings", payload: { a: 1 } });
    h.loopMessage(hostReply({ a: 1, fromLoop: true }));
    h.router.onHostMessage(hostReply({ a: "stale-host" }));

    expect(h.loop).toEqual([{ event: "setGlobalSettings", payload: { a: 1 } }]);
    expect(h.pi).toEqual([hostReply({ a: 1, fromLoop: true })]);
    expect(h.host).toHaveLength(1);
  });

  it("falls back to the host path when the reply carries no channel: delivers the host payload and flushes the queue to the host", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings", context: "ctx-1" });
    h.router.onHostMessage(hostReply({ driverName: "host-only" }));

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ driverName: "host-only" })]);
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings", context: "ctx-1" }]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/_settingsChannel/);
    // and stays on the host path afterwards
    h.router.onPiSend({ event: "setGlobalSettings", payload: { x: 1 } });
    h.router.onHostMessage(hostReply({ x: 1 }));
    expect(h.host.at(-1)).toEqual({ event: "setGlobalSettings", payload: { x: 1 } });
    expect(h.pi.at(-1)).toEqual(hostReply({ x: 1 }));
  });

  it("falls back when the loopback connect fails, using the last host payload", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings" });
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL, driverName: "host" }));
    h.loopClose(); // closed before it ever opened

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ _settingsChannel: CHANNEL, driverName: "host" })]);
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings" }]);
    expect(h.warnings[0]).toMatch(/refused/);
  });

  it("treats a throwing openLoopback like an immediate close", () => {
    const h = harness({ openThrows: true });
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("fallback");
    expect(h.pi).toEqual([hostReply({ _settingsChannel: CHANNEL })]);
  });

  it("falls back on the bootstrap timeout and flushes the queue to the host", () => {
    const h = harness({ bootstrapTimeoutMs: 10 });
    h.router.onHostOpen();
    h.router.onPiSend({ event: "getGlobalSettings" });
    h.fireTimer();

    expect(h.router.state).toBe("fallback");
    expect(h.host).toEqual([BOOTSTRAP, { event: "getGlobalSettings" }]);
    expect(h.warnings[0]).toMatch(/did not answer/);
    // a late reply is now delivered like any host push
    h.router.onHostMessage(hostReply({ late: true }));
    expect(h.pi).toEqual([hostReply({ late: true })]);
  });

  it("switches late: a host push carrying a channel while in fallback triggers the connect", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ noChannel: true }));
    expect(h.router.state).toBe("fallback");

    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("connecting");
    expect(h.opened).toEqual([CHANNEL]);
    expect(h.pi).toHaveLength(2); // the fallback delivery continues until the loopback is up
  });

  it("does not retry the same channel that already failed, but tries a new one", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopClose();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));

    expect(h.router.state).toBe("fallback");
    expect(h.opened).toHaveLength(1);
    h.router.onHostMessage(hostReply({ _settingsChannel: { ...CHANNEL, port: 60000 } }));
    expect(h.opened).toHaveLength(2);
  });

  it("a loopback close after switch-over falls back to the host for later frames and warns once", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.loopClose();
    h.router.onPiSend({ event: "getGlobalSettings" });

    expect(h.router.state).toBe("fallback");
    expect(h.host.at(-1)).toEqual({ event: "getGlobalSettings" });
    expect(h.warnings).toEqual([expect.stringMatching(/closed/)]);
  });

  it("onHostClose closes the loopback and clears a pending timer", () => {
    const h = harness();
    h.router.onHostOpen();
    h.router.onHostMessage(hostReply({ _settingsChannel: CHANNEL }));
    h.loopOpen();
    h.router.onHostClose();

    expect(h.closedLoop()).toBe(1);
    const h2 = harness();
    h2.router.onHostOpen();
    h2.router.onHostClose();
    expect(h2.timers[0]?.cleared).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-release-3.0 && pnpm exec vitest run packages/pi-components/src/settings-channel/router.test.ts`
Expected: FAIL — `Cannot find module './router.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/pi-components/src/settings-channel/router.ts
/**
 * Settings-channel router (issue #993, phase 2).
 *
 * Decides, per Property Inspector page, where the global-settings frames go.
 * A PI is a host-hosted page whose only universal input is the deck host's own
 * global-settings store; the plugin mirrors its settings there once per start
 * together with `_settingsChannel = { port, token }` of its loopback settings
 * server. The router reads that ONCE (the "bootstrap" read), opens the
 * loopback socket, and from then on sends `getGlobalSettings`/
 * `setGlobalSettings` to the plugin and delivers the plugin's
 * `didReceiveGlobalSettings` pushes to sdpi — the plugin-owned settings file is
 * the truth, so host pushes are dropped after the switch. Everything else a PI
 * sends or receives passes through untouched.
 *
 * Fallback rule: no channel, a refused/failed loopback, or a silent host → the
 * PI keeps working against the host path exactly as before, with a warning.
 * Never a blank PI.
 *
 * Pure: no DOM, no sockets — both bridges (Elgato/Mirabox `pi-settings-bridge`
 * and the Ulanzi PI bridge) supply the transports.
 */

export interface SettingsChannel {
  port: number;
  token: string;
}

export type PiFrame = Record<string, unknown> & { event?: unknown; payload?: unknown };

export interface LoopbackSocket {
  send(frame: PiFrame): void;
  close(): void;
}

export interface LoopbackHandlers {
  onOpen(): void;
  onMessage(frame: PiFrame): void;
  onClose(): void;
}

export interface SettingsChannelRouterDeps {
  /** sdpi's envelope identity for the router's own reads (`context` = PI uuid, `action` = action UUID). */
  identity: { context: string; action: string };
  /** Send an Elgato-shape frame to the deck host (the Ulanzi bridge translates inside). */
  toHost(frame: PiFrame): void;
  /** Deliver an Elgato-shape frame to sdpi. */
  toPi(frame: PiFrame): void;
  /** Open the loopback socket. Must call the handlers; a throw counts as an immediate close. */
  openLoopback(channel: SettingsChannel, handlers: LoopbackHandlers): LoopbackSocket;
  warn(message: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Test hook; production uses BOOTSTRAP_TIMEOUT_MS. */
  bootstrapTimeoutMs?: number;
}

export type RouterState = "idle" | "bootstrapping" | "connecting" | "loopback" | "fallback";

export interface SettingsChannelRouter {
  readonly state: RouterState;
  /** The host socket opened (call AFTER sdpi's onopen ran, i.e. after the register frame went out). */
  onHostOpen(): void;
  /** Every frame sdpi sends. */
  onPiSend(frame: PiFrame): void;
  /** Every Elgato-shape frame the host delivered. */
  onHostMessage(frame: PiFrame): void;
  /** The host socket closed. */
  onHostClose(): void;
}

/** How long a PI waits for the deck host to answer the bootstrap read before using the host path. */
export const BOOTSTRAP_TIMEOUT_MS = 3000;

const GLOBAL_EVENTS = new Set(["getGlobalSettings", "setGlobalSettings"]);
const TOKEN_RE = /^[0-9a-f]{32,}$/i;

export function parseSettingsChannel(settings: unknown): SettingsChannel | undefined {
  if (settings === null || typeof settings !== "object") return undefined;

  const raw = (settings as Record<string, unknown>)._settingsChannel;

  if (raw === null || typeof raw !== "object") return undefined;

  const { port, token } = raw as Record<string, unknown>;

  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;

  return { port, token };
}

function sameChannel(a: SettingsChannel | undefined, b: SettingsChannel): boolean {
  return a !== undefined && a.port === b.port && a.token === b.token;
}

export function createSettingsChannelRouter(deps: SettingsChannelRouterDeps): SettingsChannelRouter {
  const timeoutMs = deps.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  const bootstrapFrame = (): PiFrame => ({
    event: "getGlobalSettings",
    context: deps.identity.context,
    action: deps.identity.action,
  });

  let state: RouterState = "idle";
  let queue: PiFrame[] = [];
  let timer: unknown;
  let loop: LoopbackSocket | undefined;
  let lastHostPayload: PiFrame | undefined;
  let lastTried: SettingsChannel | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      deps.clearTimeout(timer);
      timer = undefined;
    }
  };

  const flushTo = (send: (frame: PiFrame) => void): void => {
    const pending = queue;

    queue = [];
    for (const frame of pending) send(frame);
  };

  const fallbackWith = (frame: PiFrame | undefined, why: string): void => {
    clearTimer();
    state = "fallback";
    deps.warn(why);
    if (frame !== undefined) deps.toPi(frame);
    flushTo(deps.toHost);
  };

  const connect = (channel: SettingsChannel): void => {
    state = "connecting";
    lastTried = channel;

    const handlers: LoopbackHandlers = {
      onOpen: () => {
        if (state !== "connecting") return;

        state = "loopback";
        loop?.send(bootstrapFrame());
        flushTo((frame) => loop?.send(frame));
      },
      onMessage: (frame) => {
        if (state === "loopback") deps.toPi(frame);
      },
      onClose: () => {
        const was = state;

        loop = undefined;
        if (was === "connecting") {
          fallbackWith(lastHostPayload, "iRaceDeck: settings channel refused — using the deck host's copy");
        } else if (was === "loopback") {
          state = "fallback";
          deps.warn("iRaceDeck: settings channel closed — falling back to the deck host's copy");
        }
      },
    };

    try {
      loop = deps.openLoopback(channel, handlers);
    } catch {
      loop = undefined;
      handlers.onClose();
    }
  };

  return {
    get state() {
      return state;
    },

    onHostOpen() {
      if (state !== "idle") return;

      state = "bootstrapping";
      deps.toHost(bootstrapFrame());
      timer = deps.setTimeout(() => {
        timer = undefined;
        if (state !== "bootstrapping") return;

        fallbackWith(undefined, "iRaceDeck: deck host did not answer the settings bootstrap — using the host copy");
      }, timeoutMs);
    },

    onPiSend(frame) {
      if (!GLOBAL_EVENTS.has(String(frame.event))) {
        deps.toHost(frame);

        return;
      }

      switch (state) {
        case "bootstrapping":
        case "connecting":
          queue.push(frame);
          break;
        case "loopback":
          loop?.send(frame);
          break;
        default:
          deps.toHost(frame);
      }
    },

    onHostMessage(frame) {
      if (frame.event !== "didReceiveGlobalSettings") {
        deps.toPi(frame);

        return;
      }

      const settings = (frame.payload as { settings?: unknown } | undefined)?.settings;
      const channel = parseSettingsChannel(settings);

      switch (state) {
        case "bootstrapping":
          clearTimer();
          lastHostPayload = frame;
          if (channel) connect(channel);
          else fallbackWith(frame, "iRaceDeck: no _settingsChannel in the deck host's settings — using the host copy");
          break;
        case "connecting":
          lastHostPayload = frame;
          break;
        case "loopback":
          break; // the store is truth; the host copy is not
        default: {
          deps.toPi(frame);
          if (channel && !sameChannel(lastTried, channel)) connect(channel);
        }
      }
    },

    onHostClose() {
      clearTimer();
      loop?.close();
      loop = undefined;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/pi-components/src/settings-channel/router.test.ts`
Expected: PASS (14 tests). If "does not retry the same channel" fails on the second `hostReply` — check that `onClose` in `connecting` runs `fallbackWith` (which delivers the frame) and that `lastTried` was set before `openLoopback`.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/src/settings-channel/router.ts packages/pi-components/src/settings-channel/router.test.ts
git commit -m "feat(pi-components): settings-channel router — bootstrap read, loopback switch-over, host fallback (#993)"
```

---

### Task 2: Loopback socket adapter + token-first guard + upgrade-decision hook

**Files:**

- Create: `packages/pi-components/src/settings-channel/loopback.ts` + `loopback.test.ts`
- Modify: `packages/deck-core/src/settings-window-guard.ts` (`authorizeSettingsRequest`, L37-54) + `settings-window-guard.test.ts`
- Modify: `packages/deck-core/src/settings-window-server.ts` (options ~L49-81; upgrade handler ~L294-300) + `settings-window-server.test.ts`
- Modify: `packages/deck-core/src/settings-window.ts` (`ensureServer()` — pass `onUpgradeDecision` → `logger.debug`)

**Interfaces:**

- Consumes: `LoopbackHandlers`, `LoopbackSocket`, `PiFrame`, `SettingsChannel` (Task 1).
- Produces: `loopbackUrl(channel)`, `openLoopbackSocket(channel, handlers, Native)`; the guard's token-first precedence; `SettingsWindowServerOptions.onUpgradeDecision`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pi-components/src/settings-channel/loopback.test.ts
import { describe, expect, it } from "vitest";

import { loopbackUrl, openLoopbackSocket } from "./loopback.js";
import type { LoopbackHandlers, PiFrame } from "./router.js";

class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = 0;
  constructor(public readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
  }
}

const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const Native = FakeNativeWebSocket as unknown as typeof WebSocket;

describe("loopbackUrl", () => {
  it("targets 127.0.0.1, the /ws path, and carries the token as ?t=", () => {
    expect(loopbackUrl(CHANNEL)).toBe(`ws://127.0.0.1:55762/ws?t=${CHANNEL.token}`);
  });

  it("URL-encodes the token", () => {
    expect(loopbackUrl({ port: 1, token: "a b" })).toBe("ws://127.0.0.1:1/ws?t=a%20b");
  });
});

describe("openLoopbackSocket", () => {
  it("opens the native socket, forwards open/message/close, JSON-encodes sends, ignores non-JSON", () => {
    FakeNativeWebSocket.instances = [];
    const seen: string[] = [];
    const messages: PiFrame[] = [];
    const handlers: LoopbackHandlers = {
      onOpen: () => seen.push("open"),
      onMessage: (f) => messages.push(f),
      onClose: () => seen.push("close"),
    };
    const socket = openLoopbackSocket(CHANNEL, handlers, Native);
    const native = FakeNativeWebSocket.instances[0]!;

    expect(native.url).toBe(loopbackUrl(CHANNEL));
    native.onopen?.({});
    native.onmessage?.({
      data: JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { a: 1 } } }),
    });
    native.onmessage?.({ data: "not json" });
    socket.send({ event: "getGlobalSettings" });
    socket.close();
    native.onclose?.({});

    expect(seen).toEqual(["open", "close"]);
    expect(messages).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { a: 1 } } }]);
    expect(native.sent).toEqual([JSON.stringify({ event: "getGlobalSettings" })]);
    expect(native.closed).toBe(1);
  });

  it("reports onClose exactly once even when error and close both fire", () => {
    FakeNativeWebSocket.instances = [];
    let closes = 0;
    openLoopbackSocket(CHANNEL, { onOpen: () => {}, onMessage: () => {}, onClose: () => closes++ }, Native);
    const native = FakeNativeWebSocket.instances[0]!;
    native.onerror?.({});
    native.onclose?.({});

    expect(closes).toBe(1);
  });
});
```

Guard tests — in `packages/deck-core/src/settings-window-guard.test.ts` REPLACE the case `"rejects a cross-site request even when it carries a valid token"` (L9-19) with these two; keep every other case (the origin-before-cookie cases stay valid because a missing/bad token falls through to the origin check):

```ts
it("allows a request that carries the valid token regardless of Origin — PIs are file:// or host-served pages (#993 phase 2)", () => {
  expect(
    authorizeSettingsRequest({
      origin: "null",
      expectedOrigin: "http://127.0.0.1:1",
      token: "tok",
      expectedToken: "tok",
    }),
  ).toEqual({ allowed: true });
  expect(
    authorizeSettingsRequest({
      origin: "http://evil.example",
      expectedOrigin: "http://127.0.0.1:1",
      token: "tok",
      expectedToken: "tok",
    }),
  ).toEqual({ allowed: true });
});

it("without a valid token, a foreign Origin is rejected before the cookie is even looked at", () => {
  expect(
    authorizeSettingsRequest({
      origin: "http://evil.example",
      expectedOrigin: "http://127.0.0.1:1",
      token: undefined,
      expectedToken: "tok",
      cookie: "tok",
    }),
  ).toEqual({ allowed: false, reason: "bad-origin" });
});
```

Server tests — append two cases to `packages/deck-core/src/settings-window-server.test.ts` next to `"accepts a WebSocket upgrade that carries the launch token"` (~L136), written in that file's own style (its `startSettingsWindowServer({...})` helper, `new WebSocket(url, { headers })` from `ws`, awaiting `open`/`error`/`unexpected-response`):

```ts
it("accepts a token-only upgrade from a foreign Origin (a PI page) and reports the decision", async () => {
  const decisions: Array<{ allowed: boolean; origin: string | undefined }> = [];
  const server = await startSettingsWindowServer({
    page: PAGE,
    settingsHost: makeHost(),
    onUpgradeDecision: (d) => decisions.push({ allowed: d.allowed, origin: d.origin }),
  });
  teardown = () => server.close();
  const port = new URL(server.url).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${server.token}`, { headers: { Origin: "null" } });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.close();

  expect(decisions.at(-1)).toEqual({ allowed: true, origin: "null" });
});

it("still rejects a cookie-only upgrade from a foreign Origin", async () => {
  const decisions: Array<{ allowed: boolean; reason?: string; origin: string | undefined }> = [];
  const server = await startSettingsWindowServer({
    page: PAGE,
    settingsHost: makeHost(),
    onUpgradeDecision: (d) => decisions.push({ allowed: d.allowed, reason: d.reason, origin: d.origin }),
  });
  teardown = () => server.close();
  const port = new URL(server.url).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: "http://evil.example", Cookie: `ird_sw=${server.token}` },
  });
  const status = await new Promise<number>((resolve) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(403));
  });

  expect(status).toBe(403);
  expect(decisions.at(-1)).toEqual({ allowed: false, reason: "bad-origin", origin: "http://evil.example" });
});
```

(`PAGE`, `makeHost`, `teardown` are the names that file already uses — adapt to the exact helper names present.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/pi-components/src/settings-channel/loopback.test.ts packages/deck-core/src/settings-window-guard.test.ts packages/deck-core/src/settings-window-server.test.ts`
Expected: FAIL — module missing; the guard returns `bad-origin` for the token case; the server has no `onUpgradeDecision`.

- [ ] **Step 3: Implement**

```ts
// packages/pi-components/src/settings-channel/loopback.ts
/**
 * Loopback transport for the settings-channel router: the ONE place that
 * builds the plugin's `ws://127.0.0.1:<port>/ws?t=<token>` URL and adapts a
 * native WebSocket to the router's `LoopbackSocket` (issue #993, phase 2).
 * Shared by the Elgato/Mirabox PI bridge and the Ulanzi PI bridge.
 */
import type { LoopbackHandlers, LoopbackSocket, PiFrame, SettingsChannel } from "./router.js";

export function loopbackUrl(channel: SettingsChannel): string {
  return `ws://127.0.0.1:${channel.port}/ws?t=${encodeURIComponent(channel.token)}`;
}

export function openLoopbackSocket(
  channel: SettingsChannel,
  handlers: LoopbackHandlers,
  Native: typeof WebSocket,
): LoopbackSocket {
  const socket = new Native(loopbackUrl(channel));
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;

    closed = true;
    handlers.onClose();
  };

  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (ev: MessageEvent) => {
    let frame: PiFrame;

    try {
      frame = JSON.parse(String(ev.data)) as PiFrame;
    } catch {
      return;
    }

    handlers.onMessage(frame);
  };
  socket.onclose = closeOnce;
  socket.onerror = closeOnce;

  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}
```

Guard — replace the body of `authorizeSettingsRequest` (keep the module doc; refresh the `cookie` field's doc so it no longer says "the Origin check still runs first" for the token path):

```ts
export function authorizeSettingsRequest(input: SettingsRequestInput): SettingsRequestDecision {
  // A valid launch token authenticates on its own, whatever the Origin: the
  // token is the secret (per-launch, 48 hex chars, reachable only through the
  // window's URL and the plugin's own settings store), and the Property
  // Inspectors that carry it are file:// (Origin "null") or host-served pages
  // (#993 phase 2). No CORS header is ever emitted, so a page cannot read a
  // response it was not meant to see.
  if (input.token !== undefined && input.token === input.expectedToken) return { allowed: true };

  // Without the token, Origin FIRST. A browser navigating top-level sends no
  // Origin header; a cross-site fetch or WebSocket upgrade always does. This
  // check is the DNS-rebinding mitigation for the cookie path, so it must never
  // be skipped for it.
  if (input.origin !== undefined && input.origin !== input.expectedOrigin) {
    return { allowed: false, reason: "bad-origin" };
  }

  if (input.cookie !== undefined && input.cookie === input.expectedToken) return { allowed: true };

  return { allowed: false, reason: "bad-token" };
}
```

Server — add to `SettingsWindowServerOptions`:

```ts
  /**
   * Called for every WebSocket upgrade with the guard's decision and the
   * request's Origin (a PI page shows up as "null" or a host-served origin,
   * the window as the loopback origin). Diagnostics only — the controller logs
   * it at debug (#993 phase 2).
   */
  onUpgradeDecision?: (decision: {
    allowed: boolean;
    reason?: SettingsRequestDenial;
    origin: string | undefined;
  }) => void;
```

(import `SettingsRequestDenial` from `./settings-window-guard.js`) and rewrite the upgrade handler's head:

```ts
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const onPath = new URL(req.url ?? "/", "http://x").pathname === WS_PATH;
    const decision = authorize(req);

    options.onUpgradeDecision?.({
      allowed: onPath && decision.allowed,
      reason: decision.allowed ? undefined : decision.reason,
      origin: req.headers.origin,
    });

    if (!onPath || !decision.allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();

      return;
    }
    // … unchanged from here
```

Controller — in `packages/deck-core/src/settings-window.ts` where `ensureServer()` calls `startServer({...})`, add:

```ts
      onUpgradeDecision: (d) =>
        logger.debug(
          d.allowed
            ? `Settings socket accepted (origin: ${d.origin ?? "none"})`
            : `Settings socket rejected: ${d.reason} (origin: ${d.origin ?? "none"})`,
        ),
```

- [ ] **Step 4: Run to verify they pass**

Run: the same vitest command; then `pnpm exec vitest run packages/deck-core` and `pnpm exec tsc --noEmit -p packages/deck-core`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/src/settings-channel packages/deck-core/src/settings-window-guard.ts packages/deck-core/src/settings-window-guard.test.ts packages/deck-core/src/settings-window-server.ts packages/deck-core/src/settings-window-server.test.ts packages/deck-core/src/settings-window.ts
git commit -m "feat(settings-window): token-first guard for PI sockets, upgrade-decision log, shared loopback adapter (#993)"
```

---

### Task 3: The guarded mirror write — `getSettingsStoreSource`, `hostMirrorPayload`, plugins

**Files:**

- Modify: `packages/deck-core/src/global-settings.ts` (the state block ~L1090-1110; `becomeReady` ~L1226; the exports around `isSettingsStoreReady`) + `global-settings.test.ts`
- Modify: `packages/deck-core/src/index.ts` (export the two new symbols next to `isSettingsStoreReady`)
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts` (~L985 store-ready `.then`), `packages/iracing-plugin-mirabox/src/plugin.ts` (~L938), `packages/iracing-plugin-ulanzi/src/plugin.ts` (~L941)

**Interfaces:**

- Produces: `getSettingsStoreSource(): SettingsStoreSource | null` (null until ready); `hostMirrorPayload(channel): Record<string, unknown> | undefined` (undefined unless the store is ready via `"file"` or `"host"`); the plugins' one host write per start.

- [ ] **Step 1: Write the failing tests** (append inside `describe("single-writer store (issue #993)")` in `global-settings.test.ts`, reusing its `createMockAdapter`, `createMockLogger`, `tick`, `createMemorySettingsStore`):

```ts
it("getSettingsStoreSource is null before ready, then names how the cache was filled", async () => {
  const mock = createMockAdapter();
  initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));

  expect(getSettingsStoreSource()).toBeNull();
  await tick();
  expect(getSettingsStoreSource()).toBe("file");
});

it("hostMirrorPayload is the WHOLE cache plus _settingsChannel once ready from the file or the host", async () => {
  const mock = createMockAdapter();
  initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
  await tick();

  const mirror = hostMirrorPayload({ port: 4242, token: "t".repeat(48) });

  expect(mirror).toMatchObject({ driverName: "nick", _settingsChannel: { port: 4242, token: "t".repeat(48) } });
  expect(Object.keys(mirror ?? {}).length).toBeGreaterThan(50); // schema defaults are part of the mirror
});

it("hostMirrorPayload is undefined before the store is ready", () => {
  const mock = createMockAdapter();
  initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));

  expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toBeUndefined();
});

it("hostMirrorPayload is undefined when the store started FRESH (migration timeout) — never write defaults over a host copy we could not read", async () => {
  vi.useFakeTimers();
  try {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore(), { migrationTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(30);

    expect(getSettingsStoreSource()).toBe("fresh");
    expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("hostMirrorPayload after a host migration carries the migrated keys", async () => {
  const mock = createMockAdapter();
  initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore());
  await tick();
  mock.echo?.({ driverName: "host-nick" });
  await tick();

  expect(getSettingsStoreSource()).toBe("host");
  expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toMatchObject({ driverName: "host-nick" });
});
```

Add `getSettingsStoreSource, hostMirrorPayload` to the file's import from `./global-settings.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/deck-core/src/global-settings.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `global-settings.ts`:

State (next to `storeReady`):

```ts
export type SettingsStoreSource = "file" | "host" | "fresh";

/** How the cache was filled — set by becomeReady(); null until then. */
let storeSource: SettingsStoreSource | null = null;
```

In `becomeReady(raw, source)`, right where `storeReady = true` is set, add `storeSource = source;`. In `_resetGlobalSettings()` add `storeSource = null;`.

Exports (next to `isSettingsStoreReady`):

```ts
/** How the cache was filled once ready ("file" | "host" | "fresh"); null before. */
export function getSettingsStoreSource(): SettingsStoreSource | null {
  return storeSource;
}

/**
 * The ONE write the plugin makes to the deck host per start (#993 phase 2):
 * a full mirror of the cache plus `_settingsChannel`, so Property Inspectors
 * can bootstrap the loopback channel from a plain host read and a downgraded
 * plugin still finds its settings. Every host's setGlobalSettings REPLACES the
 * whole stored object, so this must never be a partial — and it must be
 * skipped when the store started fresh (the host never answered the migration
 * read): writing defaults over a host copy we could not read would destroy it.
 * Returns undefined when the write must be skipped.
 */
export function hostMirrorPayload(channel: { port: number; token: string }): Record<string, unknown> | undefined {
  if (!storeReady || storeSource === "fresh") return undefined;

  return { ...(currentSettings as Record<string, unknown>), _settingsChannel: { ...channel } };
}
```

`index.ts`: add `getSettingsStoreSource, hostMirrorPayload, type SettingsStoreSource` to the global-settings export block.

Plugins — in each `plugin.ts` store-ready `.then(({ port, token }) => { … })` block, after `updateGlobalSettings({ _settingsChannel: { port, token } })`:

```ts
// #993 phase 2 — the ONE host write per start: a full mirror of the
// store plus the channel, so PIs can bootstrap the loopback socket from a
// plain host read (see hostMirrorPayload for why never a partial, and why
// it is skipped when the store started fresh).
const mirror = hostMirrorPayload({ port, token });

if (mirror) {
  adapter.setGlobalSettings(mirror);
  adapter.createLogger("SettingsWindow").debug("Mirrored settings + channel to the deck host");
} else {
  adapter.createLogger("SettingsWindow").debug("Host mirror skipped: the store started fresh");
}
```

Import `hostMirrorPayload` from `@iracedeck/deck-core` in each plugin (keep the import list sorted; `pnpm lint:fix`).

- [ ] **Step 4: Run** `pnpm exec vitest run packages/deck-core`, `pnpm exec tsc --noEmit -p packages/deck-core`, then `pnpm build` (the plugins changed; 22/22; if the deck host holds `iracing_native.node` (EPERM), build the three plugins individually with `pnpm --filter …/iracing-plugin-<x> build` and note it).

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/global-settings.ts packages/deck-core/src/global-settings.test.ts packages/deck-core/src/index.ts packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(settings): guarded host mirror — one full-object write per start carrying _settingsChannel, skipped on a fresh start (#993)"
```

---

### Task 4: `pi-settings-bridge.js` — the Elgato/Mirabox transport

**Files:**

- Create: `packages/pi-components/src/pi-settings-bridge/index.ts` + `index.test.ts`
- Create: `packages/pi-components/tsconfig.pi-settings-bridge.json`
- Modify: `packages/pi-components/tsconfig.ulanzi.json` (rootDir/include so it can import `src/settings-channel/`), `packages/pi-components/rollup.config.mjs` (new bundle), `packages/pi-components/package.json` (`clean` script)

**Interfaces:**

- Consumes: `createSettingsChannelRouter`, `PiFrame` (Task 1); `openLoopbackSocket` (Task 2).
- Produces: `installPiSettingsBridge(win = window): void`; `PiSettingsBridgeSocket` (exported for tests); bundle `browser/pi-settings-bridge.js` (IIFE, global `IRaceDeckPiSettingsBridge`).

**How it hooks in (the fact this design rests on):** the vendored `sdpi-components.js` ends with

```js
const fe = window.connectElgatoStreamDeckSocket;
window.connectElgatoStreamDeckSocket = (t, e, i, s, n) => {
  fe && fe(t, e, i, s, n);
  xt.connect(t, e, i, JSON.parse(s), JSON.parse(n));
};
```

and `xt.connect` synchronously runs `new WebSocket(\`ws://localhost:${t}\`)`exactly once per page. So a bridge script that executes BEFORE`sdpi-components.js`can pre-define`window.connectElgatoStreamDeckSocket`; when the deck host later calls it, ours runs first: it records the identity (`uuid`→ sdpi's`context`, `actionInfo.action`), replaces `window.WebSocket`with a one-shot interceptor for`ws://localhost:<port>`(also`ws://127.0.0.1:<port>`), and the interceptor restores the native constructor as soon as it has built the bridged socket. No DOMContentLoaded dependency, no timers.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pi-components/src/pi-settings-bridge/index.test.ts
import { describe, expect, it, vi } from "vitest";

import { installPiSettingsBridge, PiSettingsBridgeSocket } from "./index.js";

class FakeNativeWebSocket {
  static instances: FakeNativeWebSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = 0;
  constructor(public readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
  }
  triggerOpen(): void {
    this.onopen?.({});
  }
  triggerMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const Native = FakeNativeWebSocket as unknown as typeof WebSocket;
const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const IDENTITY = { context: "pi-uuid-1", action: "com.iracedeck.sd.core.car-control" };

function json(frames: string[]): unknown[] {
  return frames.map((f) => JSON.parse(f) as unknown);
}

describe("PiSettingsBridgeSocket", () => {
  function make() {
    FakeNativeWebSocket.instances = [];
    const warn = vi.fn();
    const socket = new PiSettingsBridgeSocket("ws://localhost:28196", IDENTITY, Native, {
      warn,
      bootstrapTimeoutMs: 1000,
    });
    const host = FakeNativeWebSocket.instances[0]!;
    const received: unknown[] = [];
    socket.onmessage = (ev) => received.push(JSON.parse(ev.data) as unknown);
    const opened = vi.fn();
    socket.onopen = opened;

    return { socket, host, received, warn, opened };
  }

  it("opens the host socket, runs sdpi's onopen first (register frame goes out), then bootstraps", () => {
    const { socket, host, opened } = make();

    expect(host.url).toBe("ws://localhost:28196");
    // sdpi's onopen sends the register frame through the bridged socket
    opened.mockImplementation(() =>
      socket.send(JSON.stringify({ event: "registerPropertyInspector", uuid: IDENTITY.context })),
    );
    host.triggerOpen();

    expect(json(host.sent)).toEqual([
      { event: "registerPropertyInspector", uuid: IDENTITY.context },
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
    ]);
  });

  it("switches to the loopback on a channel and routes global frames there; host pushes are dropped; loopback pushes reach sdpi", () => {
    const { socket, host, received } = make();
    host.triggerOpen();
    socket.send(JSON.stringify({ event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action }));
    host.triggerMessage({
      event: "didReceiveGlobalSettings",
      payload: { settings: { _settingsChannel: CHANNEL, driverName: "host" } },
    });

    const loop = FakeNativeWebSocket.instances[1]!;
    expect(loop.url).toBe(`ws://127.0.0.1:${CHANNEL.port}/ws?t=${CHANNEL.token}`);
    loop.triggerOpen();

    expect(json(loop.sent)).toEqual([
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
      { event: "getGlobalSettings", context: IDENTITY.context, action: IDENTITY.action },
    ]);
    socket.send(
      JSON.stringify({ event: "setGlobalSettings", context: IDENTITY.context, payload: { driverName: "n" } }),
    );
    expect(json(loop.sent).at(-1)).toEqual({
      event: "setGlobalSettings",
      context: IDENTITY.context,
      payload: { driverName: "n" },
    });

    loop.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } });
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "stale" } } });
    expect(received).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }]);
  });

  it("passes non-global frames through in both directions untouched", () => {
    const { socket, host, received } = make();
    host.triggerOpen();
    socket.send(
      JSON.stringify({ event: "sendToPlugin", context: IDENTITY.context, payload: { event: "openSettings" } }),
    );
    host.triggerMessage({ event: "didReceiveSettings", payload: { settings: { mode: "x" } } });

    expect(json(host.sent).at(-1)).toEqual({
      event: "sendToPlugin",
      context: IDENTITY.context,
      payload: { event: "openSettings" },
    });
    expect(received).toEqual([{ event: "didReceiveSettings", payload: { settings: { mode: "x" } } }]);
  });

  it("falls back to the host path (warning) when the host copy carries no channel", () => {
    const { socket, host, received, warn } = make();
    host.triggerOpen();
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } });
    socket.send(JSON.stringify({ event: "setGlobalSettings", payload: { a: 1 } }));

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(received).toEqual([
      { event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } },
    ]);
    expect(json(host.sent).at(-1)).toEqual({ event: "setGlobalSettings", payload: { a: 1 } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("forwards non-JSON host data to sdpi untouched and forwards close/error", () => {
    const { socket, host } = make();
    const raw: string[] = [];
    socket.onmessage = (ev) => raw.push(ev.data);
    const closed = vi.fn();
    socket.onclose = closed;
    host.onmessage?.({ data: "not json" });
    host.onclose?.({});

    expect(raw).toEqual(["not json"]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("close() closes the host socket and any loopback", () => {
    const { socket, host } = make();
    host.triggerOpen();
    host.triggerMessage({ event: "didReceiveGlobalSettings", payload: { settings: { _settingsChannel: CHANNEL } } });
    const loop = FakeNativeWebSocket.instances[1]!;
    socket.close();

    expect(host.closed).toBe(1);
    expect(loop.closed).toBe(1);
  });
});

describe("installPiSettingsBridge", () => {
  function fakeWin() {
    FakeNativeWebSocket.instances = [];
    const win = { WebSocket: Native, setTimeout, clearTimeout, console: { warn: vi.fn() } } as unknown as Window &
      typeof globalThis & { connectElgatoStreamDeckSocket?: (...a: unknown[]) => void };

    return win;
  }

  /** What sdpi-components.js does at load: wrap the prior definition, then connect synchronously. */
  function loadSdpi(win: ReturnType<typeof fakeWin>) {
    const prior = win.connectElgatoStreamDeckSocket;
    win.connectElgatoStreamDeckSocket = (port, uuid, event, info, actionInfo) => {
      prior?.(port, uuid, event, info, actionInfo);
      new win.WebSocket(`ws://localhost:${String(port)}`);
    };
  }

  const ACTION_INFO = JSON.stringify({
    action: "com.iracedeck.sd.core.car-control",
    context: "pi-uuid-1",
    device: "d",
    payload: { settings: {} },
  });

  it("runs before sdpi's connect and turns sdpi's host socket into a bridged socket, then restores WebSocket", () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    loadSdpi(win);

    win.connectElgatoStreamDeckSocket!("28196", "pi-uuid-1", "registerPropertyInspector", "{}", ACTION_INFO);

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(FakeNativeWebSocket.instances[0]!.url).toBe("ws://localhost:28196");
    expect(win.WebSocket).toBe(Native);
    // the socket sdpi got is the bridge: opening the host triggers the bootstrap read
    FakeNativeWebSocket.instances[0]!.triggerOpen();
    expect(json(FakeNativeWebSocket.instances[0]!.sent)).toEqual([
      { event: "getGlobalSettings", context: "pi-uuid-1", action: "com.iracedeck.sd.core.car-control" },
    ]);
  });

  it("does not intercept sockets to other URLs and restores WebSocket even if sdpi never connects", async () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    // no sdpi: the pre-hook is the only definition
    win.connectElgatoStreamDeckSocket!("28196", "pi-uuid-1", "registerPropertyInspector", "{}", ACTION_INFO);
    new win.WebSocket("ws://127.0.0.1:9999/other");

    expect(FakeNativeWebSocket.instances[0]!.url).toBe("ws://127.0.0.1:9999/other");
    await new Promise((r) => setTimeout(r, 0));
    expect(win.WebSocket).toBe(Native);
  });

  it("tolerates a missing/invalid actionInfo (uses an empty action) — never throws in the host's call", () => {
    const win = fakeWin();
    installPiSettingsBridge(win);
    loadSdpi(win);

    expect(() =>
      win.connectElgatoStreamDeckSocket!("1", "u", "registerPropertyInspector", "{}", "not json"),
    ).not.toThrow();
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/pi-components/src/pi-settings-bridge/index.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/pi-components/src/pi-settings-bridge/index.ts
/// <reference lib="dom" />
/**
 * Property-Inspector settings bridge for the Elgato and Mirabox hosts
 * (issue #993, phase 2).
 *
 * Both hosts speak the Elgato PI protocol: after the page loads they call
 * `connectElgatoStreamDeckSocket(port, uuid, registerEvent, info, actionInfo)`
 * and sdpi-components opens ONE `ws://localhost:<port>` socket synchronously
 * inside that call. sdpi wraps any PRIOR definition of that global and calls it
 * first — so this script, injected before `sdpi-components.js`, pre-defines it:
 * when the host calls, our hook records the PI identity and arms a one-shot
 * `WebSocket` interceptor for the host URL; the interceptor hands sdpi a
 * `PiSettingsBridgeSocket` and restores the native constructor immediately.
 *
 * The bridged socket passes everything through to the deck host EXCEPT the
 * global-settings frames, which the shared settings-channel router redirects
 * to the plugin's loopback settings server once it has read `_settingsChannel`
 * from the host copy (see ../settings-channel/router.ts for the state machine
 * and its fallback rule). Never injected into settings-window.html — that page
 * has its own bridge; two bridges must never share a page.
 */
import { openLoopbackSocket } from "../settings-channel/loopback.js";
import { createSettingsChannelRouter, type PiFrame, type SettingsChannelRouter } from "../settings-channel/router.js";

const WS_OPEN = 1;
const WS_CLOSED = 3;

export interface PiSettingsBridgeOptions {
  warn?: (message: string) => void;
  /** Test hook; production uses the router's BOOTSTRAP_TIMEOUT_MS. */
  bootstrapTimeoutMs?: number;
}

/** The WebSocket sdpi-components gets on Elgato/Mirabox: the real host socket plus the settings-channel router. */
export class PiSettingsBridgeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;

  private readonly host: WebSocket;
  private readonly router: SettingsChannelRouter;

  constructor(
    hostUrl: string,
    identity: { context: string; action: string },
    Native: typeof WebSocket,
    options: PiSettingsBridgeOptions = {},
  ) {
    const warn = options.warn ?? ((m: string) => console.warn(m));

    this.host = new Native(hostUrl);
    this.router = createSettingsChannelRouter({
      identity,
      toHost: (frame) => this.host.send(JSON.stringify(frame)),
      toPi: (frame) => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent),
      openLoopback: (channel, handlers) => openLoopbackSocket(channel, handlers, Native),
      warn,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    });

    this.host.onopen = (ev): void => {
      this.readyState = WS_OPEN;
      // sdpi's onopen sends the register frame (through our send); bootstrap after it.
      this.onopen?.(ev);
      this.router.onHostOpen();
    };

    this.host.onmessage = (ev: MessageEvent): void => {
      let frame: PiFrame;

      try {
        frame = JSON.parse(String(ev.data)) as PiFrame;
      } catch {
        this.onmessage?.(ev);

        return;
      }

      this.router.onHostMessage(frame);
    };

    this.host.onclose = (ev): void => {
      this.readyState = WS_CLOSED;
      this.router.onHostClose();
      this.onclose?.(ev as CloseEvent);
    };

    this.host.onerror = (ev): void => this.onerror?.(ev);
  }

  send(data: string): void {
    let frame: PiFrame;

    try {
      frame = JSON.parse(data) as PiFrame;
    } catch {
      this.host.send(data);

      return;
    }

    this.router.onPiSend(frame);
  }

  close(): void {
    this.router.onHostClose();
    this.host.close();
  }
}

function readAction(actionInfo: unknown): string {
  try {
    const parsed = JSON.parse(String(actionInfo)) as { action?: unknown };

    return typeof parsed.action === "string" ? parsed.action : "";
  } catch {
    return "";
  }
}

/**
 * Pre-define `connectElgatoStreamDeckSocket` so it runs first inside sdpi's
 * wrapper when the host connects the PI; exposed with an injectable `win` for
 * tests.
 */
export function installPiSettingsBridge(win: Window & typeof globalThis = window): void {
  const w = win as unknown as {
    WebSocket: typeof WebSocket;
    connectElgatoStreamDeckSocket?: (...args: unknown[]) => void;
    setTimeout: typeof setTimeout;
  };
  const prior = w.connectElgatoStreamDeckSocket;

  w.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
    prior?.(port, uuid, registerEvent, info, actionInfo);

    const identity = { context: String(uuid), action: readAction(actionInfo) };
    const Native = w.WebSocket;
    const hostUrls = new Set([`ws://localhost:${String(port)}`, `ws://127.0.0.1:${String(port)}`]);
    let armed = true;

    const restore = (): void => {
      if (armed) {
        armed = false;
        w.WebSocket = Native;
      }
    };

    w.WebSocket = function interceptingWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
      if (armed && hostUrls.has(String(url))) {
        restore();

        return new PiSettingsBridgeSocket(String(url), identity, Native) as unknown as WebSocket;
      }

      return new Native(url, protocols);
    } as unknown as typeof WebSocket;

    // sdpi connects synchronously right after this hook returns; if it never
    // does (unexpected), do not leave the interceptor installed.
    w.setTimeout(restore, 0);
  };
}

if (typeof window !== "undefined") {
  installPiSettingsBridge(window);
}
```

`packages/pi-components/tsconfig.pi-settings-bridge.json` (mirror `tsconfig.ulanzi.json`, but the bridge imports the shared `settings-channel/`, so `rootDir` is `src`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "lib": ["ES2022", "DOM"],
    "declaration": false,
    "declarationMap": false,
    "noEmit": false
  },
  "include": ["src/pi-settings-bridge/**/*", "src/settings-channel/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/pi-components/tsconfig.ulanzi.json`: change `"rootDir": "src/ulanzi-bridge"` → `"src"`, and `"include"` → `["src/ulanzi-bridge/**/*", "src/settings-channel/**/*"]`, `"exclude"` → `["src/**/*.test.ts"]` (Task 5 imports the router from there; do it now so the ulanzi bundle keeps building after Task 5).

`packages/pi-components/rollup.config.mjs` — add a fourth config after the settings-window bridge:

```js
  {
    input: "src/pi-settings-bridge/index.ts",
    output: {
      file: "browser/pi-settings-bridge.js",
      format: "iife",
      name: "IRaceDeckPiSettingsBridge",
      sourcemap: false,
    },
    plugins: [typescript({ tsconfig: "./tsconfig.pi-settings-bridge.json" }), terserPlugin],
  },
```

`packages/pi-components/package.json` `clean`: `rimraf browser/pi-components.js browser/ulanzi-pi-bridge.js browser/settings-window-bridge.js browser/pi-settings-bridge.js`.

- [ ] **Step 4: Run** `pnpm exec vitest run packages/pi-components/src/pi-settings-bridge packages/pi-components/src/settings-channel`, then `pnpm --filter @iracedeck/pi-components build` and confirm `packages/pi-components/browser/pi-settings-bridge.js` exists and `grep -c "connectElgatoStreamDeckSocket" packages/pi-components/browser/pi-settings-bridge.js` ≥ 1.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/src/pi-settings-bridge packages/pi-components/tsconfig.pi-settings-bridge.json packages/pi-components/tsconfig.ulanzi.json packages/pi-components/rollup.config.mjs packages/pi-components/package.json
git commit -m "feat(pi-components): pi-settings-bridge — Elgato/Mirabox PIs route global settings through the plugin's loopback server (#993)"
```

---

### Task 5: Grow the Ulanzi PI bridge with the same router

**Files:**

- Modify: `packages/pi-components/src/ulanzi-bridge/index.ts` (`UlanziBridgeSocket`, L46-116) + `index.test.ts`
- (`translate.ts` unchanged — the router works on Elgato-shape frames; the bridge translates on the way in/out of the host exactly as today.)

**Interfaces:**

- Consumes: `createSettingsChannelRouter` (Task 1), `openLoopbackSocket` (Task 2), the existing `elgatoToUlanzi`/`ulanziToElgato`/`encodeContext`.
- Produces: `UlanziBridgeSocket` now routes `getGlobalSettings`/`setGlobalSettings`/`didReceiveGlobalSettings` through the router; constructor gains an optional third `options?: { warn?; bootstrapTimeoutMs? }` (tests only). Everything else identical (handshake, appear marker, translation, `openUrl` relay).

**Wiring inside `UlanziBridgeSocket`:**

- `router` deps: `identity: { context: encodeContext(identity.uuid, identity.key, identity.actionid), action: identity.uuid }`; `toHost(frame)` = `elgatoToUlanzi(frame, identity)` → if non-null `real.send(JSON.stringify(u))` (so the bootstrap `getGlobalSettings` becomes the plugin-scoped Ulanzi read, and fallback writes become Ulanzi `setGlobalSettings`); `toPi(frame)` = `this.onmessage?.({ data: JSON.stringify(frame) })`; `openLoopback` = `openLoopbackSocket(channel, handlers, Native)`; `warn` = `console.warn`; timers = globals.
- `real.onopen`: unchanged handshake + appear marker, then `this.onopen?.(ev)`, then `router.onHostOpen()`.
- `real.onmessage`: parse Ulanzi frame → `ulanziToElgato` → if null return; else `router.onHostMessage(elgato)` (the router passes non-global events straight to `toPi`).
- `send(data)`: parse → `router.onPiSend(frame)` (the router sends non-global frames to `toHost` = translate + send, exactly today's behaviour). Unparsable → return (as today).
- `real.onclose`: `router.onHostClose()` then the existing readyState/onclose. `close()`: `router.onHostClose()` + `real.close()`.

- [ ] **Step 1: Write the failing tests** (append to `packages/pi-components/src/ulanzi-bridge/index.test.ts`, reusing its `FakeNativeWebSocket` (`sent`, `triggerOpen()`, `triggerMessage(data)`, `static instances`) and `makeBridge()` helper — extend `FakeNativeWebSocket` with `closed` counting and an `onerror` field if it lacks them):

```ts
describe("UlanziBridgeSocket — settings channel (#993 phase 2)", () => {
  const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
  const parsed = (s: string[]) => s.map((x) => JSON.parse(x) as Record<string, unknown>);

  it("bootstraps with a plugin-scoped Ulanzi getGlobalSettings right after the handshake", () => {
    const { bridge, real } = makeBridge();
    bridge.onopen = () => {};
    real.triggerOpen();

    expect(parsed(real.sent).at(-1)).toEqual({
      cmd: "getGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
    });
  });

  it("switches to the loopback when the host reply carries _settingsChannel and routes global frames there", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    bridge.send(JSON.stringify({ event: "getGlobalSettings", context: "c", action: "a" })); // queued
    real.triggerMessage(
      JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { _settingsChannel: CHANNEL, driverName: "host" } }),
    );

    const loop = FakeNativeWebSocket.instances[1]!;
    expect(loop.url).toBe(`ws://127.0.0.1:${CHANNEL.port}/ws?t=${CHANNEL.token}`);
    expect(received).toEqual([]); // the host copy is not delivered
    loop.triggerOpen();
    expect(parsed(loop.sent)[0]).toMatchObject({ event: "getGlobalSettings" });

    bridge.send(JSON.stringify({ event: "setGlobalSettings", payload: { driverName: "n" } }));
    expect(parsed(loop.sent).at(-1)).toEqual({ event: "setGlobalSettings", payload: { driverName: "n" } });
    // and NOT translated to the Ulanzi host
    expect(parsed(real.sent).some((f) => f.cmd === "setGlobalSettings")).toBe(false);

    loop.triggerMessage(
      JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }),
    );
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { driverName: "stale" } }));
    expect(received).toEqual([{ event: "didReceiveGlobalSettings", payload: { settings: { driverName: "file" } } }]);
  });

  it("falls back to today's host path when the host copy has no channel", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { driverName: "host-only" } }));
    bridge.send(JSON.stringify({ event: "setGlobalSettings", payload: { a: 1 } }));

    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(received).toEqual([
      { event: "didReceiveGlobalSettings", payload: { settings: { driverName: "host-only" } } },
    ]);
    expect(parsed(real.sent).at(-1)).toEqual({
      cmd: "setGlobalSettings",
      uuid: "com.iracedeck.sd.core",
      key: "",
      actionid: "",
      settings: { a: 1 },
    });
  });

  it("keeps per-action settings, sendToPlugin markers, and openUrl relay on the host path", () => {
    const { bridge, real } = makeBridge();
    const received: Record<string, unknown>[] = [];
    bridge.onmessage = (ev) => received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    real.triggerOpen();
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveGlobalSettings", settings: { _settingsChannel: CHANNEL } }));
    FakeNativeWebSocket.instances[1]!.triggerOpen();

    bridge.send(JSON.stringify({ event: "openUrl", payload: { url: "https://iracedeck.com/" } }));
    bridge.send(JSON.stringify({ event: "setSettings", payload: { mode: "x" } }));
    real.triggerMessage(JSON.stringify({ cmd: "didReceiveSettings", settings: { mode: "x" } }));

    expect(parsed(real.sent).at(-2)).toMatchObject({
      cmd: "sendToPlugin",
      payload: { event: "openUrl", url: "https://iracedeck.com/" },
    });
    expect(parsed(real.sent).at(-1)).toMatchObject({ cmd: "setSettings", settings: { mode: "x" } });
    expect(received.at(-1)).toMatchObject({ event: "didReceiveSettings", payload: { settings: { mode: "x" } } });
  });
});
```

Also update any existing test in that file that asserted a translated `getGlobalSettings`/`setGlobalSettings` went to the host immediately after open (it is now queued until the bootstrap resolves): drive `real.triggerMessage(...didReceiveGlobalSettings without a channel...)` first, or assert against the queued-then-flushed order.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/pi-components/src/ulanzi-bridge` — Expected: the new cases FAIL (no bootstrap frame; loopback never opened).

- [ ] **Step 3: Implement** — rewrite `UlanziBridgeSocket` per the wiring above:

```ts
import { openLoopbackSocket } from "../settings-channel/loopback.js";
import { createSettingsChannelRouter, type PiFrame, type SettingsChannelRouter } from "../settings-channel/router.js";
import { type BridgeIdentity, elgatoToUlanzi, encodeContext, ulanziToElgato } from "./translate.js";

export interface UlanziBridgeOptions {
  warn?: (message: string) => void;
  bootstrapTimeoutMs?: number;
}

export class UlanziBridgeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;

  private readonly real: WebSocket;
  private readonly router: SettingsChannelRouter;

  constructor(
    private readonly identity: BridgeIdentity,
    Native: typeof WebSocket,
    options: UlanziBridgeOptions = {},
  ) {
    this.real = new Native(`ws://${identity.address}:${identity.port}`);
    this.router = createSettingsChannelRouter({
      identity: { context: encodeContext(identity.uuid, identity.key, identity.actionid), action: identity.uuid },
      toHost: (frame) => {
        const ulanzi = elgatoToUlanzi(frame, identity);

        if (ulanzi) this.real.send(JSON.stringify(ulanzi));
      },
      toPi: (frame) => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent),
      openLoopback: (channel, handlers) => openLoopbackSocket(channel, handlers, Native),
      warn: options.warn ?? ((m: string) => console.warn(m)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    });

    this.real.onopen = (ev): void => {
      this.readyState = WS_OPEN;
      const base = { uuid: identity.uuid, key: identity.key, actionid: identity.actionid };
      this.real.send(JSON.stringify({ code: 0, cmd: "connected", ...base }));
      this.real.send(
        JSON.stringify({ cmd: "sendToPlugin", ...base, payload: { event: "propertyInspectorDidAppear" } }),
      );
      this.onopen?.(ev);
      // Bootstrap read of the host copy (plugin scope) — the router decides where global settings go from here.
      this.router.onHostOpen();
    };

    this.real.onmessage = (ev: MessageEvent): void => {
      let frame: Record<string, unknown>;

      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const elgato = ulanziToElgato(frame, identity);

      if (elgato) this.router.onHostMessage(elgato as PiFrame);
    };

    this.real.onclose = (ev): void => {
      this.readyState = WS_CLOSED;
      this.router.onHostClose();
      this.onclose?.(ev as CloseEvent);
    };

    this.real.onerror = (ev): void => this.onerror?.(ev);
  }

  send(data: string): void {
    let frame: PiFrame;

    try {
      frame = JSON.parse(data) as PiFrame;
    } catch {
      return;
    }

    this.router.onPiSend(frame);
  }

  close(): void {
    this.router.onHostClose();
    this.real.close();
  }
}
```

Update the module doc at the top of `index.ts` (it currently says the bridge "TRANSLATES every frame both ways"): add that global-settings frames go through the shared settings-channel router (loopback once `_settingsChannel` is known; host path otherwise). Keep `installUlanziBridge` unchanged.

- [ ] **Step 4: Run** `pnpm exec vitest run packages/pi-components/src/ulanzi-bridge packages/pi-components/src/settings-channel`, then `pnpm --filter @iracedeck/pi-components build` (the ulanzi bundle must still build with the widened tsconfig from Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/src/ulanzi-bridge
git commit -m "feat(pi-components): Ulanzi PI bridge routes global settings through the plugin's loopback server (#993)"
```

---

### Task 6: Build wiring — inject `pi-settings-bridge.js` on Elgato/Mirabox, assert exactly one bridge per page on all three

**Files:**

- Modify: `packages/pi-components/src/build/index.mjs` (`PI_SETTINGS_BRIDGE`; export the new plugin), `packages/pi-components/src/build/inject-bridge-plugin.mjs` (+ `inject-bridge-plugin.test.ts`)
- Modify: `packages/iracing-plugin-stream-deck/rollup.config.mjs` (~L198-202 inject; ~L248-264 copy list), `packages/iracing-plugin-mirabox/rollup.config.mjs` (~L275-279; copy list ~L172), `packages/iracing-plugin-ulanzi/rollup.config.mjs` (~L318-327; add the assert)
- Modify: `packages/iracing-plugin-stream-deck/.gitignore` (add `*.sdPlugin/ui/pi-settings-bridge.js`)

**Interfaces:**

- Produces: `PI_SETTINGS_BRIDGE = "pi-settings-bridge.js"`; `assertBridgeInjectionPlugin({ outputDir, expectedBridge })` — a Rollup plugin whose `closeBundle()` throws if any `*.html` in `outputDir` does not contain `<script src="<expected>"></script>\n    <script src="sdpi-components.js"></script>` exactly once, or contains any OTHER known bridge tag (`KNOWN_BRIDGES = [PI_SETTINGS_BRIDGE, "ulanzi-pi-bridge.js", SETTINGS_WINDOW_BRIDGE]`). Files without an sdpi tag are skipped.

- [ ] **Step 1: Write the failing tests** (append to `packages/pi-components/src/build/inject-bridge-plugin.test.ts`, following its temp-dir + `run()` style):

```ts
describe("assertBridgeInjectionPlugin (#993 phase 2)", () => {
  const SDPI = '<script src="sdpi-components.js"></script>';
  const tag = (b: string) => `<script src="${b}"></script>`;
  const expected = (f: string) =>
    f === "settings-window.html" ? "settings-window-bridge.js" : "pi-settings-bridge.js";

  it("passes when every page carries exactly its bridge immediately before sdpi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ird-assert-"));
    writeFileSync(join(dir, "car-control.html"), `<head>${tag("pi-settings-bridge.js")}\n    ${SDPI}</head>`);
    writeFileSync(join(dir, "settings-window.html"), `<head>${tag("settings-window-bridge.js")}\n    ${SDPI}</head>`);
    const plugin = assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected });

    await expect(Promise.resolve(plugin.closeBundle.call({}))).resolves.toBeUndefined();
  });

  it("fails on a missing bridge, a doubled bridge, a wrong order, and a second bridge on the same page", async () => {
    const cases = [
      `<head>${SDPI}</head>`,
      `<head>${tag("pi-settings-bridge.js")}\n    ${tag("pi-settings-bridge.js")}\n    ${SDPI}</head>`,
      `<head>${SDPI}\n    ${tag("pi-settings-bridge.js")}</head>`,
      `<head>${tag("pi-settings-bridge.js")}\n    ${SDPI}\n${tag("ulanzi-pi-bridge.js")}</head>`,
    ];
    for (const html of cases) {
      const dir = mkdtempSync(join(tmpdir(), "ird-assert-"));
      writeFileSync(join(dir, "car-control.html"), html);
      const plugin = assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected });

      expect(() => plugin.closeBundle.call({})).toThrow(/car-control\.html/);
    }
  });

  it("skips pages without an sdpi tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "ird-assert-"));
    writeFileSync(join(dir, "plain.html"), "<head></head>");
    expect(() =>
      assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected }).closeBundle.call({}),
    ).not.toThrow();
  });
});
```

Import `assertBridgeInjectionPlugin` from `./inject-bridge-plugin.mjs` and `PI_SETTINGS_BRIDGE` from `./index.mjs`; add `it("PI_SETTINGS_BRIDGE names the bundle", () => expect(PI_SETTINGS_BRIDGE).toBe("pi-settings-bridge.js"))`.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/pi-components/src/build/inject-bridge-plugin.test.ts` — FAIL (not exported).

- [ ] **Step 3: Implement**

`packages/pi-components/src/build/index.mjs`: `export const PI_SETTINGS_BRIDGE = "pi-settings-bridge.js";` next to `SETTINGS_WINDOW_BRIDGE`; add `assertBridgeInjectionPlugin` to the re-export from `./inject-bridge-plugin.mjs`.

`inject-bridge-plugin.mjs` — append:

```js
const KNOWN_BRIDGES = ["pi-settings-bridge.js", "ulanzi-pi-bridge.js", "settings-window-bridge.js"];

/**
 * Build-time guard (#993 phase 2): every generated PI page carries EXACTLY the
 * one bridge it is meant to, immediately before sdpi-components.js, and no
 * other bridge — two bridges on one page double-patch WebSocket. Runs in
 * closeBundle (after every writeBundle-stage injector has finished).
 *
 * @param {{ outputDir: string, expectedBridge: (fileName: string) => string }} options
 */
export function assertBridgeInjectionPlugin({ outputDir, expectedBridge }) {
  const sdpiTag = '<script src="sdpi-components.js"></script>';

  return {
    name: "assert-bridge-injection",
    closeBundle() {
      const problems = [];

      for (const file of readdirSync(outputDir).filter((f) => f.endsWith(".html"))) {
        const content = readFileSync(join(outputDir, file), "utf-8");

        if (!content.includes(sdpiTag)) continue;

        const bridge = expectedBridge(file);
        const bridgeTag = `<script src="${bridge}"></script>`;
        const count = content.split(bridgeTag).length - 1;
        const ordered = content.includes(`${bridgeTag}\n    ${sdpiTag}`);
        const others = KNOWN_BRIDGES.filter((b) => b !== bridge && content.includes(`<script src="${b}"></script>`));

        if (count !== 1 || !ordered || others.length > 0) {
          problems.push(
            `${file}: expected ${bridge} exactly once before sdpi-components.js (found ${count}${ordered ? "" : ", wrong order"}${others.length ? `, also ${others.join("+")}` : ""})`,
          );
        }
      }

      if (problems.length > 0) throw new Error(`PI bridge injection check failed:\n${problems.join("\n")}`);
    },
  };
}
```

(`readFileSync`/`readdirSync`/`join` are already imported in that file for the injector — verify.)

Plugin rollup configs:

- **stream-deck** and **mirabox**: change the existing `injectBridgeScriptPlugin({ …, bridge: SETTINGS_WINDOW_BRIDGE, include: (file) => file === SETTINGS_WINDOW_HTML })` block into TWO calls — keep that one, add `injectBridgeScriptPlugin({ outputDir: \`${sdPlugin}/ui\`, bridge: PI_SETTINGS_BRIDGE, include: (file) => file !== SETTINGS_WINDOW_HTML })` — with the comment "PI settings bridge into every action PI — but NOT the settings window, which has its own bridge; two bridges must never share a page (#992, #993)". Add `PI_SETTINGS_BRIDGE` to the browser-asset copy list (`["sdpi-components.js", "pi-components.js", PI_SETTINGS_BRIDGE, SETTINGS_WINDOW_BRIDGE, SETTINGS_WINDOW_LOGO]`) and to the `@iracedeck/pi-components/build` import. Append `assertBridgeInjectionPlugin({ outputDir: \`${sdPlugin}/ui\`, expectedBridge: (file) => (file === SETTINGS_WINDOW_HTML ? SETTINGS_WINDOW_BRIDGE : PI_SETTINGS_BRIDGE) })` as the LAST plugin in the array.
- **ulanzi**: append `assertBridgeInjectionPlugin({ outputDir: \`${sdPlugin}/ui\`, expectedBridge: (file) => (file === SETTINGS_WINDOW_HTML ? SETTINGS_WINDOW_BRIDGE : "ulanzi-pi-bridge.js") })` as the last plugin (no copy/inject changes — its bridge grew in Task 5).
- `packages/iracing-plugin-stream-deck/.gitignore`: add `*.sdPlugin/ui/pi-settings-bridge.js` after the settings-window-bridge line (mirabox/ulanzi ignore the whole `ui/`).

- [ ] **Step 4: Verify** — `pnpm build` (22/22). Then, per plugin, exactly one bridge before sdpi on every page:

```bash
for p in iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin; do
  grep -L 'pi-settings-bridge.js' packages/$p/ui/*.html            # → only settings-window.html
  grep -c '<script src="pi-settings-bridge.js"></script>' packages/$p/ui/car-control.html   # → 1
  grep -c 'pi-settings-bridge.js' packages/$p/ui/settings-window.html                     # → 0
done
grep -c 'pi-settings-bridge.js' packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/ui/car-control.html   # → 0
grep -c 'ulanzi-pi-bridge.js' packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/ui/car-control.html     # → 1
```

Then break one on purpose to prove the assert bites: temporarily change stream-deck's `expectedBridge` to always return `SETTINGS_WINDOW_BRIDGE`, run `pnpm --filter @iracedeck/iracing-plugin-stream-deck build` → must FAIL with "PI bridge injection check failed"; revert. `pnpm test` green.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/src/build packages/iracing-plugin-stream-deck/rollup.config.mjs packages/iracing-plugin-stream-deck/.gitignore packages/iracing-plugin-mirabox/rollup.config.mjs packages/iracing-plugin-ulanzi/rollup.config.mjs
git commit -m "build(plugins): inject pi-settings-bridge.js into every Elgato/Mirabox action PI; assert one bridge per page on all hosts (#993)"
```

---

### Task 7: Docs, rules, changelog, architecture, spec amendment

**Files:** `.claude/rules/global-settings.md`, `.claude/rules/settings-window.md`, `.claude/rules/pi-templates.md` (one sentence on build-time bridge injection, if the head-common script order is described there), `packages/deck-adapter-ulanzi/CLAUDE.md`, `packages/iracing-plugin-ulanzi/CLAUDE.md`, root `.claude/CLAUDE.md` (pi-components row), `packages/deck-core/CLAUDE.md` (guard/server rows if they exist), `packages/website/src/content/docs/docs/development/architecture.md`, `packages/website/src/content/docs/changelog.mdx`, `packages/website/src/content/docs/docs/features/settings-window.md`, `docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md`.

- [ ] **Steps (edit → verify → commit):**

1. `.claude/rules/global-settings.md` "Single writer" section: delete the phase-1 caveat; describe the phase-2 model — PIs and the window all talk to the plugin's loopback server; the ONE host write per start is the guarded mirror (`hostMirrorPayload`: full cache + `_settingsChannel`, skipped on a fresh start; why never a partial); PIs bootstrap from a plain host read (`_settingsChannel`), then switch to `ws://127.0.0.1:<port>/ws?t=<token>`; the fallback rule; the token-first guard (a valid token authenticates regardless of Origin; the cookie path stays origin-strict); the passthrough keys `_settingsChannel`/`_settingsStorePath` reach PIs again; the debug log lines (`Settings socket accepted (origin: …)`, `Mirrored settings + channel…`). Update the `_warnings` (#610) sentence back to "every Property Inspector".
2. `.claude/rules/settings-window.md`: intro/architecture rows — add `settings-channel/router.ts` + `loopback.ts`, `pi-settings-bridge/`, the grown Ulanzi bridge, `assertBridgeInjectionPlugin`; the rules: "one bridge per page — `pi-settings-bridge.js` (Elgato/Mirabox action PIs), `ulanzi-pi-bridge.js` (Ulanzi action PIs), `settings-window-bridge.js` (the window) — the build asserts it"; rule 4 note; rule 7 (Ulanzi markers unaffected — global settings no longer traverse the normaliser once bootstrapped); the "Verifying a change" section back to the FULL round-trip: window edit → PI updates live (and file), PI edit → window updates (and file), restart → persists; delete the phase-1 substitution.
3. `packages/deck-adapter-ulanzi/CLAUDE.md` L19 + `packages/iracing-plugin-ulanzi/CLAUDE.md` PI-bridge bullet: the bridge now routes global settings to the plugin's loopback server after one plugin-scoped bootstrap read; the plugin writes the host once per start (guarded mirror); the open question for a community tester (does UlanziStudio answer the PI-scoped read within the session).
4. Root `.claude/CLAUDE.md` pi-components row: add `pi-settings-bridge.js` (from `src/pi-settings-bridge/`) and the shared `src/settings-channel/`.
5. Architecture page: the settings-path section — PIs now connect to the loopback server (`sdpi + bridge`), the host store is "read once (migration) + mirrored once per start"; redraw the Mermaid accordingly (PI → server edge; host ← plugin "mirror once per start — full object"; PI → host stays for per-action settings only); prose to match.
6. `changelog.mdx`: edit the existing 2.5.0 settings-window bullet — the "Changes made in the window and in a Property Inspector stay in sync live" sentence is now true; add that Property Inspectors read and write settings through the plugin as well, so on all three deck ecosystems (Ulanzi included) settings persist in the plugin-owned file. One bullet, MDX-safe.
7. Feature page: the "Where Your Settings Are Stored" section — PIs and the window share the file; the deck software keeps a mirror copy refreshed at each start (so a downgrade still finds settings).
8. Spec: append "Amendment (phase 2, <date>)" under §4.4/§9: token-first guard rationale; the shared router + fallback timeout + late bootstrap; the mirror write is the bootstrap write; the build assertion.
9. Verify: `pnpm --filter @iracedeck/website build`; `pnpm exec prettier --check` on the changed markdown that was clean before; grep sweep `grep -rn "phase-1 caveat\|PI edits are inert\|neither the plugin nor the file\|never receive plugin-published" .claude packages/*/CLAUDE.md packages/website/src/content/docs --include=*.md --include=*.mdx` → empty.
10. Commit: `docs(settings): PI bridge — rules, architecture, changelog, feature page, spec amendment (#993)`.

---

### Task 8: Hardware verification (Niklas) — the gate before release

Not code. `pnpm build`, restart Stream Deck (junction → `ir-release-3.0`), debug logging on:

1. Plugin log: `Global settings loaded from the settings file` → `Mirrored settings + channel to the deck host` (or `Host mirror skipped…` — only on a fresh start).
2. Open any action's PI: log shows `Settings socket accepted (origin: …)` (record the origin string — expected `null` or a host origin); the PI shows the file's values (on this PC the host copy was wiped in phase 1 — the mirror repopulated it, and PIs now read via the loopback anyway); the PI's Diagnostics "Settings file" row is filled; the `ird-warnings` banner would render if a warning existed.
3. PI edit → the settings window updates live and the file's CONTENT changes; window edit → the PI updates live; a second PI (another action) also updates.
4. Restart the plugin → values persist; the deck host copy (visible in a PI whose bridge is forced to fallback — e.g. temporarily blocking the port — optional) equals the file.
5. Downgrade sanity (optional): a pre-#993 build still finds the mirrored settings.
6. Mirabox: the same round-trip (2–4).
7. Ulanzi (community tester): does the PI's plugin-scoped bootstrap read get answered — PIs show the file's values within the session; if not, the fallback path is today's behaviour (report the browser console warning text).
8. Failure drill: kill the plugin while a PI is open — the PI's console warns `settings channel closed`; a reopened PI reconnects to the new port/token.

Then update the memory notes (controller) and finish the branch per Niklas's rules (no push/PR without being asked).
