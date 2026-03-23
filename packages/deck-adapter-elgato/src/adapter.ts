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
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialDownEvent,
  IDeckDialRotateEvent,
  IDeckDialUpEvent,
  IDeckDidReceiveSettingsEvent,
  IDeckKeyDownEvent,
  IDeckKeyUpEvent,
  IDeckPlatformAdapter,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
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
      setImage(dataUri: string): Promise<void>;
      setTitle(title: string): Promise<void>;
      isKey(): boolean;
    },
  ) {}

  get id(): string {
    return this.sdAction.id;
  }

  async setImage(dataUri: string): Promise<void> {
    await this.sdAction.setImage(dataUri);
  }

  async setTitle(title: string): Promise<void> {
    await this.sdAction.setTitle(title);
  }

  isKey(): boolean {
    return this.sdAction.isKey();
  }
}

/**
 * Wrap an Elgato SDK event into a deck-core event.
 * Full-featured variant for events where action supports setImage/setTitle/isKey.
 */
function wrapEvent<T>(ev: {
  action: {
    id: string;
    setImage(dataUri: string): Promise<void>;
    setTitle(title: string): Promise<void>;
    isKey(): boolean;
  };
  payload: { settings: T };
}): { action: IDeckActionContext; payload: { settings: T } } {
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
      isKey() {
        return false;
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
    },
  };
}

/**
 * Elgato Stream Deck platform adapter.
 * Implements IDeckPlatformAdapter by delegating to the Elgato SDK.
 */
export class ElgatoPlatformAdapter implements IDeckPlatformAdapter {
  constructor(private readonly sd: typeof StreamDeck) {}

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

  connect(): void {
    this.sd.connect();
  }
}
