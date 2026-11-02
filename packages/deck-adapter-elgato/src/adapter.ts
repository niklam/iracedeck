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
import { type LogLocation } from "@iracedeck/app-constants";
import {
  ContextEventOrder,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  deviceProfileName,
  DIAL_CANVAS_KEY,
  type DialCanvasProfile,
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
  SD_PLUS_STRIP_CANVAS,
  toDeviceImage,
  TOUCH_STRIP_SLOT_WIDTH,
} from "@iracedeck/deck-core";
import { type ILogger, LogLevel } from "@iracedeck/logger";

import { elgatoPluginLogFile } from "./log-file.js";
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
  // Assumes at most one image value per feedback payload (every dial surface
  // reaches this through setDialCanvas, which sends a single full-slot pixmap
  // under DIAL_CANVAS_KEY): a superseded value drops the WHOLE payload via the
  // early return below, and if a payload ever carried multiple image values
  // they would rasterize serially (one toDeviceImage await at a time), not in
  // parallel.
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

  dialCanvas(): DialCanvasProfile | null {
    return this.isDial() ? SD_PLUS_STRIP_CANVAS : null;
  }

  // The strip is the `box` pixmap of every dial layout under layouts/; the
  // feedback path rasterizes it at the slot width and keeps its supersede key.
  async setDialCanvas(dataUri: string): Promise<void> {
    if (!this.isDial()) return;

    await this.setFeedback({ [DIAL_CANVAS_KEY]: dataUri });
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
      dialCanvas() {
        return null;
      },
      async setDialCanvas() {
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

/** Marks that no global-settings event has arrived yet. */
const NO_EVENT_YET: unique symbol = Symbol("no global-settings event yet");

/**
 * `@iracedeck/logger` level → the Elgato SDK's level name. The SDK has no
 * "silent"; error is its quietest. Trace maps to "debug" because the SDK caps
 * its logger at `minimumLevel` ("debug" unless the plugin runs under
 * `--inspect`), and `Logger.setLevel` replaces any level more verbose than that
 * with "info" — so "trace" would log LESS than "debug" in production.
 */
const ELGATO_LOG_LEVELS: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  [LogLevel.Trace]: "debug",
  [LogLevel.Debug]: "debug",
  [LogLevel.Info]: "info",
  [LogLevel.Warn]: "warn",
  [LogLevel.Error]: "error",
  [LogLevel.Silent]: "error",
};

/**
 * Elgato Stream Deck platform adapter.
 * Implements IDeckPlatformAdapter by delegating to the Elgato SDK.
 */
export class ElgatoPlatformAdapter implements IDeckPlatformAdapter {
  private openSettingsListeners: Array<() => void> = [];
  private globalSettingsListeners: Array<(settings: unknown) => void> = [];
  private globalSettingsSubscribed = false;
  /**
   * The last event payload, by reference — see {@link getGlobalSettings}. A
   * sentinel until then, so a read answered with no settings is never mistaken
   * for an event that did not happen.
   */
  private lastEventSettings: unknown = NO_EVENT_YET;
  /** Created on first use, so the constructor stays free of logger calls; see {@link order}. */
  private contextEventOrder: ContextEventOrder | undefined;
  /** The handler registered for each action UUID; see {@link registerAction}. */
  private readonly handlers = new Map<string, IDeckActionHandler<never>>();

  /**
   * The file the SDK's own logger writes, `<cwd>/logs/<plugin UUID>.0.log`
   * (#1330) — derived, since the SDK does not expose it; `log-file.test.ts`
   * checks the derivation against the SDK. See
   * {@link IDeckPlatformAdapter.logLocation}.
   */
  readonly logLocation: LogLocation = { kind: "file", path: elgatoPluginLogFile() };

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
   * Register a listener for the Property Inspector's "iRaceDeck Settings"
   * request (issue #992). An `IDeckPlatformAdapter` member since #1349; the
   * PI→plugin transport differs per host, so each adapter implements it its
   * own way.
   */
  onOpenSettingsRequest(listener: () => void): void {
    this.openSettingsListeners.push(listener);
  }

  /**
   * Set the SDK logger's level (#609, #1349). The SDK's logger is runtime-mutable
   * and every scope this adapter created inherits it, so the PI "Enable debug
   * logging" toggle takes effect without recreating loggers.
   */
  setLogLevel(level: LogLevel): void {
    this.sd.logger.setLevel(ELGATO_LOG_LEVELS[level]);
  }

  /**
   * Handle a Property Inspector `sendToPlugin` payload. Recognises the
   * `switchToProfile` (#736) and `openSettings` (#992) commands; anything else
   * is ignored.
   */
  private handleSendToPlugin(deviceId: string, deviceType: number | undefined, payload: unknown): void {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    const message = payload as { event?: unknown; profile?: unknown; page?: unknown };

    if (message.event === "openSettings") {
      for (const listener of this.openSettingsListeners) listener();

      return;
    }

    if (message.event !== "switchToProfile") {
      return;
    }

    this.switchToBundledProfile(
      deviceId,
      typeof message.profile === "string" ? message.profile : undefined,
      typeof message.page === "number" ? message.page : undefined,
      deviceType,
    );
  }

  /**
   * Switch `deviceId` to a bundled profile named by its clean DISPLAY name
   * (one row per template in the "Stream Deck Profiles" accordion): resolve it
   * to the device's manifest name by appending the device-type suffix (#753 —
   * idempotent for already-suffixed names) and route through the deck-core
   * switcher singleton (not `this.switchToProfile` directly) so the switch is
   * recorded in the per-device profile history and the Switch Profile "Back to
   * previous" mode can walk back to it (#762).
   *
   * The ONE dispatch for both surfaces (#992): the PI path passes the pressing
   * device's type from its event; the settings window names the device
   * explicitly and the type is looked up here.
   */
  switchToBundledProfile(deviceId: string, profile: string | undefined, page?: number, deviceType?: number): void {
    const type = deviceType ?? this.sd.devices.getDeviceById(deviceId)?.type;
    const manifestName = profile !== undefined ? deviceProfileName(profile, type) : undefined;

    // The registered switcher awaits `sd.profiles.switchToProfile`; a rejected
    // SDK call must be logged, not left as an unhandled rejection.
    requestProfileSwitch(deviceId, manifestName, page).catch((error: unknown) => {
      this.createLogger("ProfileSwitch").error(`Profile switch failed: ${String(error)}`);
    });
  }

  /**
   * Subscribe to the host's global settings: a Property Inspector's save (the
   * SDK event) and the answer to a {@link getGlobalSettings} read both arrive
   * here, through one fan-out.
   */
  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void {
    this.globalSettingsListeners.push(callback);

    if (this.globalSettingsSubscribed) return;

    this.globalSettingsSubscribed = true;
    this.sd.settings.onDidReceiveGlobalSettings((ev: { settings: unknown }) => {
      this.lastEventSettings = ev.settings;
      this.deliverGlobalSettings(ev.settings);
    });
  }

  /**
   * Request the host's global settings and deliver the answer to every
   * {@link onDidReceiveGlobalSettings} subscriber (#1208).
   *
   * Since `@elgato/streamdeck` 3.0 the SDK's `onDidReceiveGlobalSettings` fires
   * only for a Property Inspector's save: the reply to a read carries a request
   * id, and the SDK hands it to the promise `getGlobalSettings()` returns and
   * drops it from the event. So the answer is delivered here, through the same
   * fan-out the event feeds — exactly once per read, which is what the settings package's
   * one-time host migration (#993) waits for. Leaving `useLegacySettingsBehavior`
   * off is deliberate: turning it on would deliver the reply twice, once through
   * each path (lint refuses the property for that reason).
   *
   * The SDK resolves that promise on the NEXT `didReceiveGlobalSettings` frame,
   * correlated by nothing, so a PI save landing while the read is pending — even
   * long after the settings package stopped waiting — resolves it as well as firing the
   * event. Both paths are handed the same frame's `payload.settings` object, and
   * the event runs first (its listener was registered before the read's), so a
   * promise value identical to the event's last payload is that frame again and
   * is dropped. Which frame answers the migration — a genuine reply or a PI's
   * save — is still first-come, as on the other hosts (#1053).
   */
  getGlobalSettings(): void {
    this.sd.settings.getGlobalSettings().then(
      (settings: unknown) => {
        if (settings === this.lastEventSettings) return;

        this.deliverGlobalSettings(settings);
      },
      (error: unknown) => {
        this.createLogger("GlobalSettings").error(`Global settings read failed: ${String(error)}`);
      },
    );
  }

  /**
   * Hand a payload to every subscriber. A throwing subscriber is logged and
   * does not stop the rest — nor, on the read path, escape as an unhandled
   * rejection (the SDK's event path already contained it the same way).
   */
  private deliverGlobalSettings(settings: unknown): void {
    for (const listener of this.globalSettingsListeners) {
      try {
        listener(settings);
      } catch (error) {
        this.createLogger("GlobalSettings").error(`Global settings subscriber failed: ${String(error)}`);
      }
    }
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

  /**
   * The per-context event order every action of this adapter shares (#1597):
   * context ids are unique per host and a context belongs to one action, so
   * one instance orders them all. Created on first use with its own logger
   * scope, so its wait, drop and abandon lines say where they came from.
   */
  private get order(): ContextEventOrder {
    this.contextEventOrder ??= new ContextEventOrder(this.createLogger("ContextEventOrder"));

    return this.contextEventOrder;
  }

  /**
   * Register `handler` for `uuid` as an SDK `SingletonAction` whose every
   * per-context event goes through {@link order} (#1597).
   *
   * Each `BridgeAction` method calls `enqueue` synchronously, inside the SDK
   * callback and before any await — the SDK's emitter reaches it in the same
   * call stack as the host frame, so arrival order is the order fixed there —
   * and returns the enqueue promise, so the SDK's route awaits the handler and
   * sees its rejection exactly as it did when the method awaited the handler
   * itself. The task builds the deck-core event and calls the handler when it
   * runs, as a non-async lambda so a handler with nothing ahead of it is called
   * inside the SDK callback, as before. An event the order drops (a context
   * that is not live) resolves to nothing.
   *
   * One `BridgeAction` per UUID: a second registration of the same UUID
   * replaces the handler — the one registered when an event arrives is the one
   * its task calls — rather than adding a second SDK action, as the other
   * adapters' one-handler-per-UUID maps do. The SDK has no way to unregister an
   * action, and two bridges for one UUID would both enqueue every event of a
   * context on the one shared order, where the second `willAppear` of a live
   * context is dropped.
   *
   * The adapter keeps no per-context state of its own: the SDK's action store
   * carries the controller and the settings, and the event wraps the SDK's
   * action object, so there is no bookkeeping to move into the tasks.
   */
  registerAction<T>(uuid: string, handler: IDeckActionHandler<T>): void {
    const alreadyBridged = this.handlers.has(uuid);

    this.handlers.set(uuid, handler);

    if (alreadyBridged) return;

    const order = this.order;
    const handlers = this.handlers;
    /** The handler registered for `uuid` when an event arrives. */
    const current = (): IDeckActionHandler<T> => handlers.get(uuid) as IDeckActionHandler<T>;

    // Create a SingletonAction subclass that delegates to the handler.
    // Set manifestId directly instead of using the @action decorator to avoid
    // the __esDecorate helper which emits `(this && ...)` — invalid in ESM.
    class BridgeAction extends SingletonAction<T & JsonObject> {
      override manifestId = uuid;

      // `@elgato/streamdeck` 3.0 widened the lifecycle events' action to include
      // `NeoInfobarAction`, which has no image or title (#1208). No manifest
      // entry declares the Neo Infobar controller, so the host never sends one;
      // narrowing it out keeps the wrapper honest without a cast. willDisappear
      // is narrowed too, so the handler never sees one vanish that it never saw
      // appear. A Neo Infobar context is never enqueued, so it never becomes
      // live and its broadcasts never fire.
      override onWillAppear(ev: WillAppearEvent<T & JsonObject>): Promise<void> | undefined {
        if (ev.action.isNeoInfobar()) return undefined;

        const action = ev.action;
        const payload = ev.payload;

        const handler = current();

        return order.enqueue(action.id, "willAppear", () =>
          handler.onWillAppear?.(wrapEvent({ action, payload }) as IDeckWillAppearEvent<T>),
        );
      }

      override onWillDisappear(ev: WillDisappearEvent<T & JsonObject>): Promise<void> | undefined {
        if (ev.action.controllerType === "Neo") return undefined;

        const handler = current();

        return order.enqueue(ev.action.id, "willDisappear", () => handler.onWillDisappear?.(wrapDisappearEvent<T>(ev)));
      }

      override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T & JsonObject>): Promise<void> | undefined {
        if (ev.action.isNeoInfobar()) return undefined;

        const action = ev.action;
        const payload = ev.payload;

        const handler = current();

        return order.enqueue(action.id, "didReceiveSettings", () =>
          handler.onDidReceiveSettings?.(wrapEvent({ action, payload }) as IDeckDidReceiveSettingsEvent<T>),
        );
      }

      override onKeyDown(ev: KeyDownEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "keyDown", () => handler.onKeyDown?.(wrapEvent(ev) as IDeckKeyDownEvent<T>));
      }

      override onKeyUp(ev: KeyUpEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "keyUp", () => handler.onKeyUp?.(wrapEvent(ev) as IDeckKeyUpEvent<T>));
      }

      override onDialRotate(ev: DialRotateEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "dialRotate", () => handler.onDialRotate?.(wrapDialRotateEvent<T>(ev)));
      }

      override onDialDown(ev: DialDownEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "dialDown", () =>
          handler.onDialDown?.(wrapEvent(ev) as IDeckDialDownEvent<T>),
        );
      }

      override onDialUp(ev: DialUpEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "dialUp", () => handler.onDialUp?.(wrapEvent(ev) as IDeckDialUpEvent<T>));
      }

      override onTouchTap(ev: TouchTapEvent<T & JsonObject>): Promise<void> | undefined {
        const handler = current();

        return order.enqueue(ev.action.id, "touchTap", () => handler.onTouchTap?.(wrapTouchTapEvent<T>(ev)));
      }
    }

    this.sd.actions.registerAction(new BridgeAction());
  }

  /**
   * The three broadcasts fire at the event's arrival — the SDK-wide listener
   * runs in the same emit as the action's own route — and only for a context
   * {@link order} holds live (#1597): its `willAppear` has arrived and its
   * `willDisappear` has not. The SDK already passes only a context in its
   * action store; the gate is the adapter's own, so the contract holds
   * whatever the SDK's store does.
   */
  onKeyDown(callback: () => void): void {
    this.sd.actions.onKeyDown((ev) => {
      if (this.order.isLive(ev.action.id)) callback();
    });
  }

  onDialDown(callback: () => void): void {
    this.sd.actions.onDialDown((ev) => {
      if (this.order.isLive(ev.action.id)) callback();
    });
  }

  onDialRotate(callback: () => void): void {
    this.sd.actions.onDialRotate((ev) => {
      if (this.order.isLive(ev.action.id)) callback();
    });
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
