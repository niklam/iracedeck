/**
 * Platform-Agnostic Deck Device Interfaces
 *
 * Defines the abstraction layer for deck device hardware (Elgato Stream Deck,
 * VSDinside, Mirabox, etc.). Actions import these interfaces instead of
 * platform-specific SDKs, enabling code reuse across platforms.
 */
import type { LogLocation } from "@iracedeck/app-constants";
import type { ILogger, LogLevel } from "@iracedeck/logger";
import type { SettingsHost } from "@iracedeck/settings";

import type { DialCanvasProfile } from "./dial-canvas.js";
import type { DeckFeedbackPayload } from "./feedback-types.js";

/**
 * Handle to a single action instance on the device.
 * Wraps platform-specific action references (e.g., Elgato's KeyAction/DialAction).
 */
export interface IDeckActionContext {
  /** Unique identifier for this action instance */
  readonly id: string;
  /**
   * Id of the device this action instance is on. Optional — only platforms that
   * expose it populate it (Elgato does; used for profile switching, #736).
   */
  readonly deviceId?: string;
  /**
   * Elgato `DeviceType` of the device this action instance is on (see
   * `device-profiles.ts`). Optional — populated by adapters that expose it
   * (Elgato); used to filter device-specific bundled profiles.
   */
  readonly deviceType?: number;
  /** Set the button/key image */
  setImage(dataUri: string): Promise<void>;
  /** Set the button/key title text */
  setTitle(title: string): Promise<void>;
  /** Persist action-level settings (triggers didReceiveSettings on both plugin and PI) */
  setSettings(settings: Record<string, unknown>): Promise<void>;
  /** Whether this context is a key (button) rather than a dial/encoder */
  isKey(): boolean;
  /** Whether this context is a dial/encoder rather than a key (button). */
  isDial(): boolean;
  /**
   * Update the encoder touch-strip layout items (Stream Deck+). No-op on
   * platforms/controllers without a plugin-drawable touch strip.
   */
  setFeedback(feedback: DeckFeedbackPayload): Promise<void>;
  /**
   * Switch the encoder touch-strip layout (built-in id or plugin-relative JSON
   * path). No-op where unsupported.
   */
  setFeedbackLayout(layout: string): Promise<void>;
  /**
   * Update the encoder trigger descriptions (Stream Deck+). No-op where
   * unsupported.
   */
  setTriggerDescription(descriptions: DeckTriggerDescription): Promise<void>;
  /**
   * The dial's own screen — the Stream Deck+ touch-strip slot, or the Stream
   * Dock knob's LCD segment — or `null` when this context has none: a key, an
   * Information area, or a dial on a host with no plugin-drawable dial screen
   * (Ulanzi). Renderers branch on `profile.id`, never on the platform (#1013).
   */
  dialCanvas(): DialCanvasProfile | null;
  /**
   * Push one full-canvas image (a data URI drawn at `dialCanvas()`'s size) to
   * that screen. A no-op when `dialCanvas()` is `null`. On a Mirabox knob this
   * addresses the same pixels as `setImage`; on Elgato it is the strip and
   * `setImage` stays the app-UI dial canvas.
   */
  setDialCanvas(dataUri: string): Promise<void>;
  /**
   * Briefly flash the host's warning indicator on the key (Elgato: the yellow
   * warning triangle). Optional — adapters whose host has no equivalent omit
   * it; callers invoke via `action.showAlert?.()`. Used for refused actions
   * that would otherwise be silent no-ops (e.g. the #747 AI-target guard).
   */
  showAlert?(): Promise<void>;
}

/**
 * Base event delivered to action handlers.
 */
export interface IDeckEvent<T> {
  action: IDeckActionContext;
  payload: { settings: T; coordinates?: { row: number; column: number } };
}

/** Fired when the action becomes visible on the device */
export type IDeckWillAppearEvent<T> = IDeckEvent<T>;

/** Fired when the action is removed from the device */
export type IDeckWillDisappearEvent<T> = IDeckEvent<T>;

/** Fired when action settings change (e.g., from Property Inspector) */
export type IDeckDidReceiveSettingsEvent<T> = IDeckEvent<T>;

/** Fired when a key/button is pressed */
export type IDeckKeyDownEvent<T> = IDeckEvent<T>;

/** Fired when a key/button is released */
export type IDeckKeyUpEvent<T> = IDeckEvent<T>;

/** Fired when a rotary encoder/dial is turned */
export interface IDeckDialRotateEvent<T> extends IDeckEvent<T> {
  /**
   * `pressed` reports whether the dial button was held down while the rotation
   * occurred — the basis for the "Push + Turn" gesture. Native on both the
   * Elgato (`DialRotate.pressed`) and Mirabox/Ulanzi (`payload.pressed`) SDKs.
   */
  payload: { settings: T; ticks: number; pressed: boolean };
}

/** Fired when a rotary encoder/dial is pressed */
export type IDeckDialDownEvent<T> = IDeckEvent<T>;

/** Fired when a rotary encoder/dial is released */
export type IDeckDialUpEvent<T> = IDeckEvent<T>;

/** Fired when the encoder touchscreen (Stream Deck+) is tapped */
export interface IDeckTouchTapEvent<T> extends IDeckEvent<T> {
  payload: { settings: T; tapPos: [number, number]; hold: boolean; coordinates?: { row: number; column: number } };
}

/** Encoder trigger (interaction) descriptions shown in the Stream Deck app (Stream Deck+). */
export interface DeckTriggerDescription {
  rotate?: string;
  push?: string;
  touch?: string;
  longTouch?: string;
}

/**
 * What shape a press has, for the press sounds (issue #269). An action declares
 * it through {@link IDeckActionHandler.keyPressShape},
 * {@link IDeckActionHandler.dialPressShape} and
 * {@link IDeckActionHandler.touchPressShape}; `withPressSounds` in
 * `press-sounds.ts` owns the timing and plays the sounds, so no action plays a
 * press sound itself.
 *
 * - `tap`     — acts now, no long press: the tap sound (a single bleep) now,
 *               never the long one.
 * - `hold`    — acts now and keeps acting while held: the tap sound now, the
 *               long sound (a double bleep) at `thresholdMs` if still held.
 * - `release` — decided at release: the tap sound at a short release if
 *               `short`, the long sound at `thresholdMs` if `long`. `short` /
 *               `long` say whether that outcome does anything; a gesture set
 *               to `none` is `false`.
 * - `long`    — this event is a completed long press (a long touch): the long
 *               sound now.
 * - `none`    — this press makes no sound.
 *
 * `thresholdMs` is the exact threshold the action classifies with
 * (`getDualPressThresholdMs()` today), read once at down.
 */
export type PressShape =
  | { kind: "tap" }
  | { kind: "hold"; thresholdMs: number }
  | { kind: "release"; thresholdMs: number; short: boolean; long: boolean }
  | { kind: "long" }
  | { kind: "none" };

/**
 * Interface that action classes implement to handle device events.
 */
export interface IDeckActionHandler<T = unknown> {
  /**
   * The shape of the press a key-down starts (issue #269), for the press
   * sounds. Called by `withPressSounds` with the key-down event, BEFORE
   * `onKeyDown`, and only while press sounds are on and the sim is connected.
   * Must be synchronous and free of side effects: it describes the press, it
   * does not act on it. Optional — a handler without it is a `tap`
   * (`DEFAULT_KEY_PRESS_SHAPE`). A throw reads as `none`.
   */
  keyPressShape?(ev: IDeckKeyDownEvent<T>): PressShape;
  /**
   * The shape of the press a dial-down starts (issue #269), under the same
   * rules as {@link keyPressShape}, called BEFORE `onDialDown`. It is the
   * wrapper's dial path that calls it, so it never has to ask the context
   * which controller it is. Optional — a handler without it is a `release` at
   * 500 ms that plays the tap sound when short and never the long one
   * (`DEFAULT_DIAL_PRESS_SHAPE`).
   */
  dialPressShape?(ev: IDeckDialDownEvent<T>): PressShape;
  /**
   * The shape of a touch on a dial's strip (issue #269), under the same rules
   * as {@link keyPressShape}, called BEFORE `onTouchTap`. A touch arrives
   * complete (its `hold` says whether it was long), so `release` reads that
   * flag as its classification. Optional — a handler without it is a `tap`.
   */
  touchPressShape?(ev: IDeckTouchTapEvent<T>): PressShape;
  onWillAppear?(ev: IDeckWillAppearEvent<T>): Promise<void>;
  onWillDisappear?(ev: IDeckWillDisappearEvent<T>): Promise<void>;
  onDidReceiveSettings?(ev: IDeckDidReceiveSettingsEvent<T>): Promise<void>;
  onKeyDown?(ev: IDeckKeyDownEvent<T>): Promise<void>;
  onKeyUp?(ev: IDeckKeyUpEvent<T>): Promise<void>;
  onDialRotate?(ev: IDeckDialRotateEvent<T>): Promise<void>;
  onDialDown?(ev: IDeckDialDownEvent<T>): Promise<void>;
  onDialUp?(ev: IDeckDialUpEvent<T>): Promise<void>;
  onTouchTap?(ev: IDeckTouchTapEvent<T>): Promise<void>;
}

/**
 * Platform adapter that bridges platform-specific SDKs to the deck-core abstraction.
 * Each platform (Elgato, VSDinside, Mirabox) implements this interface.
 * The global-settings read/write and `onHostReady` live on `SettingsHost` in
 * `@iracedeck/settings`.
 */
export interface IDeckPlatformAdapter extends SettingsHost {
  /** Subscribe to application launch events */
  onApplicationDidLaunch(callback: (application: string) => void): void;
  /** Subscribe to application termination events */
  onApplicationDidTerminate(callback: (application: string) => void): void;
  /**
   * Whether the host actually delivers the application launch/terminate
   * events for `ApplicationsToMonitor` (issue #870). Omitted/undefined means
   * supported. Declare `false` when the protocol has no app-monitoring
   * events at all (UlanziStudio) — the app monitor then keeps SDK reconnect
   * polling enabled at startup, since no launch event will ever arrive to
   * re-enable it, and the resulting connection doubles as the exit signal
   * for the SDK-disconnect fallback.
   */
  readonly supportsApplicationMonitoring?: boolean;
  /**
   * Subscribe to Property Inspector appear events (fires each time any
   * action's PI becomes visible). Used to refresh dynamic PI state that
   * only makes sense while the PI is open — e.g. re-enumerating audio
   * output devices so a headset plugged in after plugin startup appears.
   */
  onPropertyInspectorDidAppear(callback: () => void): void;
  /** Create a scoped logger for a component */
  createLogger(scope: string): ILogger;
  /**
   * Register an action handler for a UUID.
   *
   * **Per-context order and liveness (#1597).** The adapter delivers the
   * handler's events for one context in arrival order through
   * `ContextEventOrder`: `onWillAppear`, `onWillDisappear` and
   * `onDidReceiveSettings` each start only after every earlier event of the
   * context has settled and hold every later one; an input event
   * (`onKeyDown`, `onKeyUp`, `onDialDown`, `onDialUp`, `onDialRotate`,
   * `onTouchTap`) waits for earlier lifecycle events but not for earlier
   * input, so two presses still run concurrently. A context is live from the
   * arrival of its `willAppear` to the arrival of its `willDisappear`; input,
   * a settings change or a second disappear for a context that is not live
   * never reaches the handler, and a re-appear runs after the teardown it
   * follows. An event that overlaps nothing reaches the handler synchronously
   * at arrival. A wait is bounded by `CONTEXT_EVENT_WAIT_LIMIT_MS`.
   *
   * The guarantee is part of implementing this interface, and it is checked:
   * every adapter's tests run `CONTEXT_EVENT_ORDER_SCENARIOS` from
   * `@iracedeck/deck-core/testing` through a harness over its real dispatch
   * (`scripts/deck-adapter-order-contract.test.mjs` fails an adapter that does
   * not). In return a handler must never await another event of its own
   * context — a settings echo, an input — since that event is queued behind it.
   */
  registerAction(uuid: string, handler: IDeckActionHandler): void;
  /**
   * Subscribe to key-down events across all actions. Fires at the event's
   * arrival, before the handler's `onKeyDown` is enqueued, and only for a live
   * context (one whose `willAppear` has arrived and whose `willDisappear` has
   * not) — see {@link registerAction}.
   */
  onKeyDown(callback: () => void): void;
  /**
   * Subscribe to dial-down events across all actions. Fires at arrival, for a
   * live context only, like {@link onKeyDown}.
   */
  onDialDown(callback: () => void): void;
  /**
   * Subscribe to dial-rotate events across all actions. Fires at arrival, for a
   * live context only, like {@link onKeyDown}.
   */
  onDialRotate(callback: () => void): void;
  /** Start the platform connection */
  connect(): void;
  /**
   * Switch the given device to a bundled profile distributed with the plugin.
   *
   * Profiles are an Elgato Stream Deck concept: the Elgato adapter delegates to
   * `streamDeck.profiles.switchToProfile`, which prompts the user to install the
   * profile when it isn't installed yet — the mechanism that installs/updates
   * bundled profiles. Non-Elgato adapters (Mirabox, Ulanzi) have no profile
   * system and implement this as a no-op. Omitting `profile` returns to the
   * device's default profile; `page` optionally selects a page within it.
   */
  switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void>;
  /**
   * Open a URL in the user's browser through the host. Resolving means the
   * request was sent to the host, not that a page opened — no host reports
   * that — and hosts open http(s) URLs only.
   */
  openUrl(url: string): Promise<void>;
  /** Subscribe to the Property Inspector's "iRaceDeck Settings" request (#992). */
  onOpenSettingsRequest(listener: () => void): void;
  /** Set the minimum level of every logger this adapter created, live (#609). */
  setLogLevel(level: LogLevel): void;
  /**
   * The file or directory this adapter's loggers write; `undefined` when it
   * writes none (an adapter built without a log directory: tests, the scenario
   * harness). Read once at startup by the bootstrap for the main-thread
   * watchdog's target and the CPU-profile folder (`<log dir>/profiles`).
   */
  readonly logLocation: LogLocation | undefined;
}
