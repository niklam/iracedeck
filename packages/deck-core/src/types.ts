/**
 * Platform-Agnostic Deck Device Interfaces
 *
 * Defines the abstraction layer for deck device hardware (Elgato Stream Deck,
 * VSDinside, Mirabox, etc.). Actions import these interfaces instead of
 * platform-specific SDKs, enabling code reuse across platforms.
 */
import type { ILogger } from "@iracedeck/logger";

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
 * Interface that action classes implement to handle device events.
 */
export interface IDeckActionHandler<T = unknown> {
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
 */
export interface IDeckPlatformAdapter {
  /** Subscribe to global settings changes */
  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void;
  /** Request current global settings (triggers onDidReceiveGlobalSettings callback) */
  getGlobalSettings(): void;
  /** Write/update global settings */
  setGlobalSettings(settings: Record<string, unknown>): void;
  /**
   * Subscribe to the host connection becoming usable — the point from which a
   * {@link getGlobalSettings} read can actually be answered (#1056). Fires once,
   * or immediately if the host is already reachable when you subscribe.
   *
   * **Optional on purpose, and absence is a statement rather than a gap.** Only
   * the two WebSocket adapters have anything to report: they drop a frame
   * written before their socket opens, so the one-time migration read is issued
   * into a closed socket and covered by the connect-time reissue. An adapter
   * whose transport queues the read until it can be sent — Elgato, whose SDK
   * awaits the connection inside its own `send` — declares nothing here, and
   * deck-core then keeps the deadline it already armed.
   *
   * Do NOT make this required. A stub that never calls back would satisfy the
   * type while breaking the contract; it happens to be harmless for today's
   * single consumer (never firing means never re-arming, which is right for
   * Elgato) and would silently do the wrong thing for the next one.
   */
  onHostReady?(callback: () => void): void;
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
  /** Register an action handler for a UUID */
  registerAction(uuid: string, handler: IDeckActionHandler): void;
  /** Subscribe to key-down events across all actions */
  onKeyDown(callback: () => void): void;
  /** Subscribe to dial-down events across all actions */
  onDialDown(callback: () => void): void;
  /** Subscribe to dial-rotate events across all actions */
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
}
