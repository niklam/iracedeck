/**
 * Elgato Stream Deck Platform Adapter
 *
 * Bridges the Elgato Stream Deck SDK to the platform-agnostic deck-core interfaces.
 * Wraps Elgato-specific events, action contexts, and SDK calls into the
 * IDeckPlatformAdapter interface.
 */
import type StreamDeck from "@elgato/streamdeck";
import {
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type DidReceiveSettingsEvent,
  type FeedbackPayload,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import {
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  deviceProfileName,
  type IDeckActionContext,
  type IDeckActionHandler,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckPlatformAdapter,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isDataUri,
  keyImageSizeForDevice,
  requestProfileSwitch,
  toDeviceImage,
  TOUCH_STRIP_SLOT_WIDTH,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import { createSDLogger } from "./sd-logger.js";

/**
 * Wraps an Elgato SDK action reference into a platform-agnostic IDeckActionContext.
 */
class ElgatoActionContext implements IDeckActionContext {
  constructor(
    private readonly sdAction: {
      id: string;
      device?: { id: string; type: number };
      setImage(dataUri: string): Promise<void>;
      setTitle(title: string): Promise<void>;
      setSettings(settings: unknown): Promise<void>;
      isKey(): boolean;
      isDial?(): boolean;
      setFeedback?(feedback: FeedbackPayload): Promise<void>;
      setFeedbackLayout?(layout: string): Promise<void>;
      setTriggerDescription?(descriptions: {
        rotate?: string;
        push?: string;
        touch?: string;
        longTouch?: string;
      }): Promise<void>;
      /** Present on KeyAction only (dials have no warning indicator). */
      showAlert?(): Promise<void>;
    },
  ) {}

  get id(): string {
    return this.sdAction.id;
  }

  get deviceId(): string | undefined {
    return this.sdAction.device?.id;
  }

  get deviceType(): number | undefined {
    return this.sdAction.device?.type;
  }

  async setImage(dataUri: string): Promise<void> {
    const image = await toDeviceImage(this.id, dataUri, keyImageSizeForDevice(this.sdAction.device?.type));

    // null = superseded by a newer image for this context — skip the send.
    if (image === null) return;

    await this.sdAction.setImage(image);
  }

  async setTitle(title: string): Promise<void> {
    await this.sdAction.setTitle(title);
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    await this.sdAction.setSettings(settings);
  }

  isKey(): boolean {
    return this.sdAction.isKey();
  }

  isDial(): boolean {
    return this.sdAction.isDial?.() ?? false;
  }

  // Route every data-URI value (SVG or already-rasterized PNG/etc.) through
  // toDeviceImage so it participates in per-context supersede tracking —
  // toDeviceImage passes non-SVG data URIs through unchanged, but still bumps
  // the sequence, which is what lets a later PNG push drop a stale in-flight
  // SVG render for the same key (#642). Plain-text string values (e.g. a
  // `title` field) are never data URIs and skip the image pipeline entirely.
  //
  // Assumes at most one image value per feedback payload (today's only
  // caller, fuel-service/fuel-dial-surface.ts, sends a single full-slot
  // pixmap): a superseded value drops the WHOLE payload via the early return
  // below, and if a payload ever carried multiple image values they would
  // rasterize serially (one toDeviceImage await at a time), not in parallel.
  async setFeedback(feedback: DeckFeedbackPayload): Promise<void> {
    if (!this.sdAction.setFeedback) return;

    const converted: DeckFeedbackPayload = {};

    for (const [key, value] of Object.entries(feedback)) {
      if (typeof value === "string" && isDataUri(value)) {
        const image = await toDeviceImage(`${this.id}#${key}`, value, TOUCH_STRIP_SLOT_WIDTH);

        if (image === null) return; // a newer feedback push superseded this one

        converted[key] = image;
      } else {
        converted[key] = value;
      }
    }

    await this.sdAction.setFeedback(converted as FeedbackPayload);
  }

  async setFeedbackLayout(layout: string): Promise<void> {
    if (this.sdAction.setFeedbackLayout) await this.sdAction.setFeedbackLayout(layout);
  }

  async setTriggerDescription(descriptions: DeckTriggerDescription): Promise<void> {
    if (this.sdAction.setTriggerDescription) await this.sdAction.setTriggerDescription(descriptions);
  }

  async showAlert(): Promise<void> {
    await this.sdAction.showAlert?.();
  }
}

/**
 * Wrap an Elgato SDK event into a deck-core event.
 * Full-featured variant for events where action supports setImage/setTitle/isKey.
 */
function wrapEvent<T>(ev: {
  action: {
    id: string;
    device?: { id: string; type: number };
    setImage(dataUri: string): Promise<void>;
    setTitle(title: string): Promise<void>;
    setSettings(settings: unknown): Promise<void>;
    isKey(): boolean;
    isDial?(): boolean;
    setFeedback?(feedback: FeedbackPayload): Promise<void>;
    setFeedbackLayout?(layout: string): Promise<void>;
    setTriggerDescription?(descriptions: {
      rotate?: string;
      push?: string;
      touch?: string;
      longTouch?: string;
    }): Promise<void>;
  };
  payload: { settings: T; coordinates?: { row: number; column: number } };
}): { action: IDeckActionContext; payload: { settings: T; coordinates?: { row: number; column: number } } } {
  return {
    action: new ElgatoActionContext(ev.action),
    payload: ev.payload,
  };
}

/**
 * Wrap a WillDisappearEvent where action is ActionContext (no setImage/setTitle/isKey).
 * Provides a minimal IDeckActionContext with stubs for unavailable methods.
 *
 * Note: isKey() always returns false here because Elgato's ActionContext doesn't
 * expose the controller type. BaseAction.onWillDisappear only uses ev.action.id
 * for cleanup, so this is safe. If future logic needs key vs. dial distinction
 * in onWillDisappear, track the controller type in the context map during onWillAppear.
 */
function wrapDisappearEvent<T>(ev: WillDisappearEvent<T & JsonObject>): IDeckWillDisappearEvent<T> {
  return {
    action: {
      get id() {
        return ev.action.id;
      },
      async setImage() {
        /* no-op: action is disappearing */
      },
      async setTitle() {
        /* no-op: action is disappearing */
      },
      async setSettings() {
        /* no-op: action is disappearing */
      },
      isKey() {
        return false;
      },
      isDial() {
        return false;
      },
      async setFeedback() {
        /* no-op: action is disappearing */
      },
      async setFeedbackLayout() {
        /* no-op: action is disappearing */
      },
      async setTriggerDescription() {
        /* no-op: action is disappearing */
      },
    },
    payload: ev.payload as { settings: T },
  };
}

/**
 * Wrap an Elgato dial rotate event (includes ticks in payload).
 */
function wrapDialRotateEvent<T>(ev: DialRotateEvent<T & JsonObject>): IDeckDialRotateEvent<T> {
  return {
    action: new ElgatoActionContext(ev.action),
    payload: {
      settings: ev.payload.settings as T,
      ticks: ev.payload.ticks,
      pressed: ev.payload.pressed,
    },
  };
}

/**
 * Wrap an Elgato encoder touch-tap event (Stream Deck+ touchscreen).
 */
function wrapTouchTapEvent<T>(ev: TouchTapEvent<T & JsonObject>): IDeckTouchTapEvent<T> {
  return {
    action: new ElgatoActionContext(ev.action),
    payload: {
      settings: ev.payload.settings as T,
      tapPos: ev.payload.tapPos,
      hold: ev.payload.hold,
      coordinates: ev.payload.coordinates,
    },
  };
}

/**
 * Elgato Stream Deck platform adapter.
 * Implements IDeckPlatformAdapter by delegating to the Elgato SDK.
 */
export class ElgatoPlatformAdapter implements IDeckPlatformAdapter {
  constructor(private readonly sd: typeof StreamDeck) {
    // Route "Stream Deck Profiles" settings-accordion button presses — sent from
    // the Property Inspector via `sendToPlugin` — to `switchToProfile`, targeting
    // the device whose PI is open (`ev.action.device.id`). Profiles are
    // Elgato-only, so only this adapter wires it; the non-Elgato adapters
    // implement `switchToProfile` as a no-op and never receive this message.
    this.sd.ui.onSendToPlugin((ev) => {
      this.handleSendToPlugin(ev.action.device.id, ev.action.device.type, ev.payload);
    });
  }

  /**
   * Handle a Property Inspector `sendToPlugin` payload. Currently only the
   * `switchToProfile` command is recognised; anything else is ignored.
   */
  private handleSendToPlugin(deviceId: string, deviceType: number | undefined, payload: unknown): void {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    const message = payload as { event?: unknown; profile?: unknown; page?: unknown };

    if (message.event !== "switchToProfile") {
      return;
    }

    // The "Stream Deck Profiles" accordion sends clean display names (one row
    // per template); resolve to the pressing device's manifest name by
    // appending its suffix (#753). Idempotent for already-suffixed names.
    const profile = typeof message.profile === "string" ? deviceProfileName(message.profile, deviceType) : undefined;
    const page = typeof message.page === "number" ? message.page : undefined;

    // Route through the deck-core switcher singleton (not this.switchToProfile
    // directly) so the switch is recorded in the per-device profile history and
    // the Switch Profile "Back to previous" mode can walk back to it (#762).
    void requestProfileSwitch(deviceId, profile, page);
  }

  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void {
    this.sd.settings.onDidReceiveGlobalSettings((ev: { settings: unknown }) => {
      callback(ev.settings);
    });
  }

  getGlobalSettings(): void {
    this.sd.settings.getGlobalSettings();
  }

  setGlobalSettings(settings: Record<string, unknown>): void {
    this.sd.settings.setGlobalSettings(settings as JsonObject);
  }

  onApplicationDidLaunch(callback: (application: string) => void): void {
    this.sd.system.onApplicationDidLaunch((ev) => {
      callback(ev.application);
    });
  }

  onApplicationDidTerminate(callback: (application: string) => void): void {
    this.sd.system.onApplicationDidTerminate((ev) => {
      callback(ev.application);
    });
  }

  onPropertyInspectorDidAppear(callback: () => void): void {
    // streamDeck.ui.onDidAppear fires once per PI becoming visible, regardless
    // of which action opens it. The payload carries action/context info; we
    // only care that *some* PI opened, so the callback is parameterless.
    this.sd.ui.onDidAppear(() => {
      callback();
    });
  }

  createLogger(scope: string): ILogger {
    return createSDLogger(this.sd.logger.createScope(scope));
  }

  registerAction<T>(uuid: string, handler: IDeckActionHandler<T>): void {
    // Create a SingletonAction subclass that delegates to the handler.
    // Set manifestId directly instead of using the @action decorator to avoid
    // the __esDecorate helper which emits `(this && ...)` — invalid in ESM.
    class BridgeAction extends SingletonAction<T & JsonObject> {
      override manifestId = uuid;

      override async onWillAppear(ev: WillAppearEvent<T & JsonObject>): Promise<void> {
        await handler.onWillAppear?.(wrapEvent(ev) as IDeckWillAppearEvent<T>);
      }

      override async onWillDisappear(ev: WillDisappearEvent<T & JsonObject>): Promise<void> {
        await handler.onWillDisappear?.(wrapDisappearEvent<T>(ev));
      }

      override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T & JsonObject>): Promise<void> {
        await handler.onDidReceiveSettings?.(wrapEvent(ev) as IDeckDidReceiveSettingsEvent<T>);
      }

      override async onKeyDown(ev: KeyDownEvent<T & JsonObject>): Promise<void> {
        await handler.onKeyDown?.(wrapEvent(ev) as IDeckKeyDownEvent<T>);
      }

      override async onKeyUp(ev: KeyUpEvent<T & JsonObject>): Promise<void> {
        await handler.onKeyUp?.(wrapEvent(ev) as IDeckKeyUpEvent<T>);
      }

      override async onDialRotate(ev: DialRotateEvent<T & JsonObject>): Promise<void> {
        await handler.onDialRotate?.(wrapDialRotateEvent<T>(ev));
      }

      override async onDialDown(ev: DialDownEvent<T & JsonObject>): Promise<void> {
        await handler.onDialDown?.(wrapEvent(ev) as IDeckDialDownEvent<T>);
      }

      override async onDialUp(ev: DialUpEvent<T & JsonObject>): Promise<void> {
        await handler.onDialUp?.(wrapEvent(ev) as IDeckDialUpEvent<T>);
      }

      override async onTouchTap(ev: TouchTapEvent<T & JsonObject>): Promise<void> {
        await handler.onTouchTap?.(wrapTouchTapEvent<T>(ev));
      }
    }

    this.sd.actions.registerAction(new BridgeAction());
  }

  onKeyDown(callback: () => void): void {
    this.sd.actions.onKeyDown(() => callback());
  }

  onDialDown(callback: () => void): void {
    this.sd.actions.onDialDown(() => callback());
  }

  onDialRotate(callback: () => void): void {
    this.sd.actions.onDialRotate(() => callback());
  }

  /**
   * Open a URL in the user's default browser via the Elgato SDK.
   */
  async openUrl(url: string): Promise<void> {
    await this.sd.system.openUrl(url);
  }

  /**
   * Switch a device to a bundled profile via the Elgato SDK. When the profile
   * isn't installed yet the Stream Deck app prompts the user to install it —
   * this is how iRaceDeck's bundled profiles get installed and updated.
   */
  async switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void> {
    await this.sd.profiles.switchToProfile(deviceId, profile, page);
  }

  connect(): void {
    this.sd.connect();
  }
}
