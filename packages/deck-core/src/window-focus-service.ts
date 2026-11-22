/**
 * Window Focus Service
 *
 * Focuses the iRacing window before inputs are sent. Two call sites, one mode
 * (issue #977): every press asks at its start through `focusIRacingIfEnabled()`,
 * which runs under the `always` mode only; the keystroke paths — the keyboard
 * service's press-emitting methods and the chat command's text send — call
 * `focusIRacingBeforeInput()`, which runs under `always` and `required`. Under
 * `always` a keybind press therefore asks twice; the second ask returns
 * `AlreadyFocused` and costs one foreground-window compare, and it is what
 * covers touch-strip gestures (#978) without a press-time touch hook. `never`
 * runs neither.
 *
 * **The per-key layer (#1654).** A key's own `windowFocus` setting
 * (`CommonSettings`) can override the mode for that key: `focus` brings iRacing
 * forward whatever the mode, `no-focus` never does, `global` (the default) is
 * the mode as above. `withWindowFocus` (`window-focus-wrapper.ts`), which
 * `plugin-runtime`'s `registerActions` puts around every action, makes the
 * press-time ask through {@link focusIRacingForPress}, and runs each press's
 * handler member inside {@link runInWindowFocusScope}. That scope is an
 * `AsyncLocalStorage`, so it follows everything the handler starts — awaits,
 * promise chains, timers — down to the keystroke site, which reads it in
 * `focusIRacingBeforeInput()` before the mode: no signature between the action
 * and the native send carries the key's choice. A keystroke outside any press
 * has no scope and follows the mode. `focus` keeps the elevation-mismatch gate
 * and the timeout cooldown (they keep an ask that cannot succeed from stalling
 * the plugin) but skips the mode and the settings-store-ready gate, since the
 * key's own setting is the decision.
 *
 * What actually needs the foreground: **keystrokes** (`SendInput` goes to the
 * focused window) and therefore every keybind- and chat-driven action. Pure SDK
 * broadcasts do NOT — `irsdk_broadcastMsg` uses `SendNotifyMessage(HWND_BROADCAST,
 * …)`, which reaches iRacing whatever has focus. Those are blocked only by a
 * Windows integrity-level (UIPI) mismatch, which focusing cannot fix; that's what
 * the `getElevationStatus()` probe is for (see `.claude/rules/keyboard-shortcuts.md`).
 *
 * The focuser itself is injected at startup (same dependency-injection shape as
 * `keyboard-service`): the actual window handling lives in the native addon,
 * and deck-core must stay platform-agnostic, so this module never imports
 * `@iracedeck/iracing-native`.
 *
 * So is the "is iRacing running?" check that picks the log level for a missing
 * window (#1176). Importing it from `app-monitor` closed an import cycle —
 * `sdk-singleton` imports this module for the chat `beforeKeystrokes` hook, and
 * `app-monitor` imports `sdk-singleton` for the controller — so the plugins
 * hand in `isIRacingActive` the way they hand it to `runVersionCheck` as
 * `isSimRunning`. The elevation check is injected the same way (#1351): the
 * probe lives in `@iracedeck/deck-iracing`, which depends on deck-core.
 */
import type { FocusIRacingMode } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { getGlobalSettings, isSettingsStoreReady } from "@iracedeck/settings";
import { AsyncLocalStorage } from "node:async_hooks";

import type { WindowFocusOverride } from "./common-settings.js";

/**
 * Status codes a {@link WindowFocuser} may return.
 *
 * MIRROR of the `FocusResult` enum in `@iracedeck/iracing-native` — deck-core
 * deliberately does not depend on that package (importing it loads the native
 * addon as a module side effect, which a platform-agnostic, heavily
 * unit-tested package must not do). The values are part of the native
 * contract: keep them in sync with `packages/iracing-native/src/index.ts`.
 * `focus-result.test.ts` in the Stream Deck plugin — which depends on both
 * packages — asserts the two stay identical.
 */
export const FocusResult = {
  /** Window was already in the foreground */
  AlreadyFocused: 0,
  /** Window was found and successfully focused */
  Focused: 1,
  /** No window with the expected title exists */
  WindowNotFound: 2,
  /** Window was found but focus did not transfer within timeout */
  FocusTimedOut: 3,
} as const;

export type FocusResult = (typeof FocusResult)[keyof typeof FocusResult];

/**
 * Function that focuses the iRacing window.
 * Returns a {@link FocusResult} status code.
 */
export type WindowFocuser = () => FocusResult;

/**
 * Whether anything says iRacing is running — the plugins pass the app
 * monitor's `isIRacingActive`. Asked only when the window was not found, to
 * choose between a debug line (expected: iRacing is closed) and a warning
 * (the window should have been there).
 */
export type SimRunningCheck = () => boolean;

/**
 * Whether the plugin and the sim run at different integrity levels (#976);
 * plugins pass `deck-iracing`'s `hasElevationMismatch`.
 */
export type ElevationMismatchCheck = () => boolean;

/**
 * How long after a `FocusTimedOut` the gated entry points — the two mode
 * sites and the per-key {@link focusIRacingForKey} (#1654) — skip the native
 * ask (#977). A timed-out ask blocks the JS thread for the focuser's full
 * ~1000 ms wait, and under `always` (or a key set to `focus`) a keybind press
 * asks twice — at press time and then at the keystroke site — so without this a persistent cause would
 * cost ~2 s per press, and a held setup key repeating every 150 ms ~1 s per
 * tick. The usual cause, an elevation mismatch, is skipped outright once the
 * probe has reported it (#976); the cooldown covers the rest — a mismatch
 * before the probe has answered or when it threw, and any other window that
 * refuses focus. `focusIRacingNow()` is exempt: there the press is the focus.
 */
export const FOCUS_TIMEOUT_COOLDOWN_MS = 2000;

let focuser: WindowFocuser | null = null;
let isSimRunning: SimRunningCheck = () => false;
let elevationMismatch: ElevationMismatchCheck = () => false;
let logger: ILogger = silentLogger;
/**
 * When the last `FocusTimedOut` happened (`Date.now()`), or `null` outside a
 * timeout episode. One record serves two purposes with the same lifecycle:
 * it is what the cooldown measures from, and its being set is what drops the
 * repeat-timeout log line to debug. A success (`AlreadyFocused` / `Focused`)
 * or a vanished window (`WindowNotFound`) ends the episode — the condition
 * behind the timeouts, a window present but unfocusable, is gone.
 */
let lastTimedOutAt: number | null = null;
/**
 * Whether the current elevation-mismatch skip episode has been logged (#976).
 * Cleared whenever a gated ask finds the gate open, so the next mismatch logs
 * its skip again.
 */
let elevationSkipLogged = false;

/**
 * Initialize the window focus service.
 * Should be called once at plugin startup.
 *
 * @param log - Logger instance
 * @param windowFocuser - Function that focuses the iRacing window
 * @param simRunning - Whether iRacing is running; plugins pass `isIRacingActive`.
 *   Required, and set together with the focuser, so there is no moment in which
 *   a focus result can be logged without it.
 * @param mismatch - Whether the plugin and the sim run at different integrity
 *   levels; plugins pass `hasElevationMismatch` from `@iracedeck/deck-iracing`.
 */
export function initWindowFocus(
  log: ILogger,
  windowFocuser: WindowFocuser,
  simRunning: SimRunningCheck,
  mismatch: ElevationMismatchCheck,
): void {
  if (focuser) {
    throw new Error("Window focus service already initialized. initWindowFocus() should only be called once.");
  }

  logger = log;
  focuser = windowFocuser;
  isSimRunning = simRunning;
  elevationMismatch = mismatch;
}

/**
 * The injected {@link SimRunningCheck}, read as `false` if it throws: the
 * answer only picks a log level, and this service never throws into the action
 * the user pressed.
 */
function simRunningNow(): boolean {
  try {
    return isSimRunning();
  } catch {
    return false;
  }
}

/** The injected {@link ElevationMismatchCheck}, read as `false` if it throws, like {@link simRunningNow}. */
function elevationMismatchNow(): boolean {
  try {
    return elevationMismatch();
  } catch {
    return false;
  }
}

/**
 * The focus mode the cache holds, or `null` when nothing may act yet.
 */
function currentMode(): FocusIRacingMode | null {
  if (!focuser) return null;

  // Gate on the stored settings having loaded, NOT on `isGlobalSettingsInitialized()`:
  // that flag flips true before the settings store has been read, while the
  // cache is still pure schema defaults — and since #930 the default says focus
  // is ON (`always` since #977). Acting on it would yank iRacing forward for a
  // user who explicitly opted out, every time the deck host restarts or
  // auto-updates the plugin mid-session. Fail closed until the real value is in.
  if (!isSettingsStoreReady()) return null;

  return getGlobalSettings().focusIRacingWindow;
}

/**
 * The press-time call site for a key left at `global`: before every key press,
 * dial press and dial rotation, through {@link focusIRacingForPress}. Runs
 * under the `always` mode only. Best-effort: logs on failure but never throws,
 * so a focus problem can't stop the action the user actually pressed.
 */
export function focusIRacingIfEnabled(): void {
  if (currentMode() !== "always") return;

  if (blockedByElevationMismatch()) return;

  if (inTimeoutCooldown()) return;

  runFocuser();
}

/**
 * Focus the iRacing window because the pressed key's own setting says so
 * (`windowFocus: "focus"`, #1654), whatever the global mode. It skips the mode
 * and the `isSettingsStoreReady()` gate — the key's stored setting is the
 * decision, and it is not a global default the startup window could mistake
 * for the user's choice — but keeps the elevation-mismatch gate (#976) and the
 * post-timeout cooldown, which keep an ask that cannot succeed from stalling
 * the plugin on every press, a per-key ask as much as a global one.
 */
export function focusIRacingForKey(): void {
  if (!focuser) return;

  if (blockedByElevationMismatch()) return;

  if (inTimeoutCooldown()) return;

  runFocuser();
}

/**
 * Which kind of press {@link focusIRacingForPress} is asked about: a key down,
 * dial down or dial rotation (`press`), which asks for focus at press time, or
 * a touch-strip tap (`touch`), which never does (#978) and is focused, if at
 * all, at its keystrokes.
 */
export type FocusPressKind = "press" | "touch";

/**
 * The press-time decision for one press of a key whose own setting is
 * `override` (#1654), made by `withWindowFocus` before the handler runs:
 *
 * - `global` asks as the global mode says: {@link focusIRacingIfEnabled} on a
 *   press, nothing on a touch.
 * - `focus` asks through {@link focusIRacingForKey} on a press, and nothing on
 *   a touch, whose keystrokes are focused by the scope instead.
 * - `no-focus` asks nothing.
 *
 * When the key's setting changes what happens it logs one debug line for the
 * press, so a support log explains a press that did or did not bring iRacing
 * forward: always for `no-focus`, and for `focus` when the global mode would
 * not have focused (at press time for a press; at the keystrokes for a touch).
 * Best-effort like the rest of the service, though a settings read that throws
 * reaches the caller, which guards it.
 */
export function focusIRacingForPress(override: WindowFocusOverride, kind: FocusPressKind = "press"): void {
  switch (override) {
    case "global":
      if (kind === "press") focusIRacingIfEnabled();

      return;
    case "no-focus":
      logger.debug("Focus skipped for this key (per-key setting)");

      return;
    case "focus": {
      const mode = currentMode();
      const globalWouldFocus = kind === "press" ? mode === "always" : mode === "always" || mode === "required";

      if (!globalWouldFocus) logger.debug("Focus requested by this key's setting");

      if (kind === "press") focusIRacingForKey();

      return;
    }
  }
}

/**
 * The pressed key's own `windowFocus` value, carried through everything its
 * handler starts (#1654). Unset outside a press.
 */
const focusScope = new AsyncLocalStorage<WindowFocusOverride>();

/**
 * Run `fn` as part of a press of a key whose own setting is `override`, so
 * every keystroke it leads to — awaited, chained or set on a timer inside it —
 * is focused as that setting says rather than as the global mode alone says.
 * Returns what `fn` returns, and a synchronous throw from `fn` propagates.
 */
export function runInWindowFocusScope<R>(override: WindowFocusOverride, fn: () => R): R {
  return focusScope.run(override, fn);
}

/**
 * The `windowFocus` value of the press the caller runs inside, or `undefined`
 * outside any press.
 */
export function getWindowFocusScope(): WindowFocusOverride | undefined {
  return focusScope.getStore();
}

/**
 * The keystroke call site (issue #977): called by the keyboard service's
 * press-emitting methods immediately before each native send (never on a
 * release), and by the chat command before it types. Inside a press of a key
 * whose own setting is `no-focus` it asks nothing, and under `focus` it asks
 * through {@link focusIRacingForKey} (#1654); otherwise — a `global` key, or
 * no press at all — it runs under `always` and `required`.
 *
 * Deliberately NOT keyed on the comms catalog (#612): everything that reaches
 * the keyboard service's send path or the chat text send is a keystroke by
 * definition, and the catalog would be a second source of truth for a fact
 * the call site already knows. SimHub roles go out over TCP and never come
 * here; SDK broadcasts arrive whatever has focus and never come here either.
 */
export function focusIRacingBeforeInput(): void {
  const override = focusScope.getStore();

  if (override === "no-focus") return;

  if (override === "focus") {
    focusIRacingForKey();

    return;
  }

  const mode = currentMode();

  if (mode !== "always" && mode !== "required") return;

  if (blockedByElevationMismatch()) return;

  if (inTimeoutCooldown()) return;

  runFocuser();
}

/**
 * Whether the elevation probe has reported an integrity-level mismatch on the
 * current connection (#976), so the gated entry points should not ask the
 * native focuser at all. Across the mismatch `SetForegroundWindow` can never
 * succeed, so the ask would only spend the focuser's full ~1000 ms wait —
 * and a focus that did transfer would not help either, because UIPI drops
 * input sent to the higher-integrity window. Before the probe has answered,
 * or when it threw, the gate stays open. Logs the skip at info once per
 * episode, so a support log at the default threshold shows that focus is
 * being withheld and why.
 *
 * Closing the gate also ends any timeout episode (#977 cooldown): no gated ask
 * runs while it is closed, so nothing else would clear one begun before the
 * probe answered, and it would otherwise demote the first genuine timeout
 * after the gate reopens to debug.
 */
function blockedByElevationMismatch(): boolean {
  if (!elevationMismatchNow()) {
    elevationSkipLogged = false;

    return false;
  }

  lastTimedOutAt = null;

  if (!elevationSkipLogged) {
    logger.info(
      "Not focusing the iRacing window: it runs at a higher integrity level than the plugin, so focus cannot transfer",
    );
    elevationSkipLogged = true;
  }

  return true;
}

/**
 * Whether a recent timeout means the gated entry points should not ask the
 * native focuser right now (see {@link FOCUS_TIMEOUT_COOLDOWN_MS}). Logs the
 * skip at debug, with how long ago the timeout was.
 */
function inTimeoutCooldown(): boolean {
  if (lastTimedOutAt === null) return false;

  const elapsed = Date.now() - lastTimedOutAt;

  if (elapsed >= FOCUS_TIMEOUT_COOLDOWN_MS) return false;

  logger.debug(`iRacing focus skipped: a focus timed out ${elapsed} ms ago`);

  return true;
}

/**
 * Focus the iRacing window **unconditionally**, ignoring the
 * `focusIRacingWindow` global setting (issue #926).
 *
 * For action code where focusing IS the thing the user pressed the key for — the
 * View Adjustment *Mouse to Sim* mode is the only consumer today. That is an
 * explicit request to go to the sim, so neither the mode, the
 * `isSettingsStoreReady()` startup gate, the elevation-mismatch gate (#976) nor
 * the post-timeout cooldown applies: all four exist to keep the *implicit*
 * before-every-action focus from surprising someone or stalling the plugin,
 * and there is nothing implicit about pressing this key. Under a mismatch the
 * result code (`FocusTimedOut`) is what tells the user why nothing happened.
 *
 * Shares {@link focusIRacingIfEnabled}'s result handling and logging exactly.
 *
 * @returns the {@link FocusResult}, or `null` when the call could not be made at
 *   all (no focuser injected, or it threw). `null` says nothing about the window
 *   — callers must not read it as "iRacing is not running".
 */
export function focusIRacingNow(): FocusResult | null {
  return runFocuser();
}

/**
 * Invokes the injected focuser and logs the outcome.
 *
 * @returns the result, or `null` when no focuser is configured or it threw.
 */
function runFocuser(): FocusResult | null {
  if (!focuser) return null;

  let result: FocusResult;

  try {
    result = focuser();
  } catch (error) {
    logger.warn(`Failed to focus iRacing window: ${error}`);

    return null;
  }

  switch (result) {
    case FocusResult.AlreadyFocused:
      lastTimedOutAt = null;
      logger.debug("iRacing window already focused");
      break;
    case FocusResult.Focused:
      lastTimedOutAt = null;
      logger.debug("iRacing window focused successfully");
      break;
    case FocusResult.WindowNotFound:
      // A window that no longer exists ends any in-flight timeout episode: the
      // condition that caused the timeouts (a window present but unfocusable)
      // is gone. A timeout after this is a new episode and must warn again, or
      // a relaunch-as-Administrator would never surface the elevation hint.
      lastTimedOutAt = null;

      // The setting is on by default (#930), so this runs before every key and
      // dial press — including every press made while iRacing is closed, where
      // a missing window is the expected outcome rather than a fault. Log by
      // expectation: debug when nothing says iRacing is running, warn when the
      // app monitor or a live SDK connection says it IS (the injected
      // `isIRacingActive`), because then the window really should have been
      // found and the log line is a genuine diagnostic worth having in a
      // support log.
      if (simRunningNow()) {
        logger.warn("iRacing window not found — is iRacing running?");
      } else {
        logger.debug("iRacing window not found (iRacing is not running)");
      }

      break;
    case FocusResult.FocusTimedOut:
      // A timeout is always worth reporting, but it does not occur in isolation:
      // its usual cause is an integrity-level mismatch (iRacing elevated, the
      // plugin not), which makes EVERY press time out. Warn once per episode and
      // drop to debug until a focus succeeds, so one persistent condition can't
      // bury the rest of the log — including the elevation warning that explains
      // it. Each of these also costs the native focuser's full 1000 ms wait,
      // which is why the timestamp also arms the cooldown the gated entry
      // points check (#977).
      if (lastTimedOutAt !== null) {
        logger.debug("iRacing window found but focus timed out (1000ms)");
      } else {
        logger.warn(
          "iRacing window found but focus timed out (1000ms) — if iRacing runs as Administrator, run the deck app elevated too",
        );
      }

      lastTimedOutAt = Date.now();

      break;
    default:
      logger.warn(`Unexpected focus result: ${result}`);
      break;
  }

  return result;
}

/**
 * Reset the service to its uninitialized state.
 *
 * @internal Exported for testing
 */
export function _resetWindowFocus(): void {
  focuser = null;
  isSimRunning = () => false;
  elevationMismatch = () => false;
  logger = silentLogger;
  lastTimedOutAt = null;
  elevationSkipLogged = false;
}
