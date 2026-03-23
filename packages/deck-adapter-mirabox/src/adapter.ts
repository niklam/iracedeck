/**
 * VSDinside Stream Dock Platform Adapter
 *
 * Bridges the VSD Craft WebSocket protocol to the platform-agnostic deck-core
 * interfaces. Implements the same IDeckPlatformAdapter contract as the Elgato
 * adapter, enabling all iRaceDeck actions to run on VSDinside devices.
 */
import type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialRotateEvent,
  IDeckEvent,
  IDeckPlatformAdapter,
  IDeckWillDisappearEvent,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { createConsoleLogger } from "@iracedeck/logger";

import { parseConnectionParams, VSDClient, type VSDEvent } from "./vsd-client.js";

/** Valid controller types for VSD/Elgato devices. */
type ControllerType = "Keypad" | "Encoder" | "Knob";

/**
 * Wraps a VSD action context (identified by context string) into
 * a platform-agnostic IDeckActionContext.
 */
class VSDActionContext implements IDeckActionContext {
  constructor(
    private readonly client: VSDClient,
    readonly id: string,
    private readonly controllerType: ControllerType,
  ) {}

  async setImage(dataUri: string): Promise<void> {
    this.client.setImage(this.id, dataUri);
  }

  async setTitle(title: string): Promise<void> {
    this.client.setTitle(this.id, title);
  }

  isKey(): boolean {
    return this.controllerType === "Keypad";
  }
}

/**
 * Create a deck-core event from a VSD event with full action context.
 */
function wrapEvent<T>(
  client: VSDClient,
  data: VSDEvent & { context: string },
  controllerType: ControllerType,
): IDeckEvent<T> {
  return {
    action: new VSDActionContext(client, data.context, controllerType),
    payload: { settings: (data.payload?.settings ?? {}) as T },
  };
}

/**
 * Create a deck-core disappear event with no-op stubs.
 * Similar to Elgato adapter: disappearing actions don't need setImage/setTitle.
 */
function wrapDisappearEvent<T>(data: VSDEvent & { context: string }): IDeckWillDisappearEvent<T> {
  return {
    action: {
      get id() {
        return data.context;
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
    payload: { settings: (data.payload?.settings ?? {}) as T },
  };
}

/**
 * Create a deck-core dial rotate event (includes ticks in payload).
 */
function wrapDialRotateEvent<T>(
  client: VSDClient,
  data: VSDEvent & { context: string },
  controllerType: ControllerType,
): IDeckDialRotateEvent<T> {
  return {
    action: new VSDActionContext(client, data.context, controllerType),
    payload: {
      settings: (data.payload?.settings ?? {}) as T,
      ticks: data.payload?.ticks ?? 0,
    },
  };
}

/**
 * VSDinside Stream Dock platform adapter.
 * Implements IDeckPlatformAdapter by wrapping the VSD Craft WebSocket protocol.
 */
export class VSDPlatformAdapter implements IDeckPlatformAdapter {
  private readonly client: VSDClient;
  private readonly keyDownCallbacks: (() => void)[] = [];
  private readonly dialDownCallbacks: (() => void)[] = [];
  private readonly dialRotateCallbacks: (() => void)[] = [];

  /** Track controller type per context from willAppear events */
  private readonly contextControllers = new Map<string, ControllerType>();

  constructor(logger?: ILogger) {
    const log = logger ?? createConsoleLogger("VSD");
    this.client = new VSDClient(parseConnectionParams(), log.createScope("WebSocket"));
  }

  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void {
    this.client.onGlobalEvent("didReceiveGlobalSettings", (data) => {
      callback(data.payload?.settings ?? {});
    });
  }

  getGlobalSettings(): void {
    this.client.requestGlobalSettings();
  }

  setGlobalSettings(settings: Record<string, unknown>): void {
    this.client.setGlobalSettings(settings);
  }

  onApplicationDidLaunch(callback: (application: string) => void): void {
    this.client.onGlobalEvent("applicationDidLaunch", (data) => {
      const app = (data.payload as Record<string, unknown>)?.application;

      if (typeof app === "string") {
        callback(app);
      }
    });
  }

  onApplicationDidTerminate(callback: (application: string) => void): void {
    this.client.onGlobalEvent("applicationDidTerminate", (data) => {
      const app = (data.payload as Record<string, unknown>)?.application;

      if (typeof app === "string") {
        callback(app);
      }
    });
  }

  createLogger(scope: string): ILogger {
    return createConsoleLogger(scope);
  }

  registerAction<T>(uuid: string, handler: IDeckActionHandler<T>): void {
    const getControllerType = (context: string): ControllerType => {
      return this.contextControllers.get(context) ?? "Keypad";
    };

    // willAppear — track controller type and delegate
    this.client.onActionEvent(uuid, "willAppear", async (data) => {
      if (!data.context) return;

      const controller = ((data.payload?.controller as string) ?? "Keypad") as ControllerType;
      this.contextControllers.set(data.context, controller);

      await handler.onWillAppear?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // willDisappear — clean up controller tracking
    this.client.onActionEvent(uuid, "willDisappear", async (data) => {
      if (!data.context) return;

      await handler.onWillDisappear?.(wrapDisappearEvent<T>(data as VSDEvent & { context: string }));
      this.contextControllers.delete(data.context);
    });

    // didReceiveSettings
    this.client.onActionEvent(uuid, "didReceiveSettings", async (data) => {
      if (!data.context) return;

      await handler.onDidReceiveSettings?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // keyDown — fire broadcast callbacks first (for window focus), then handler
    this.client.onActionEvent(uuid, "keyDown", async (data) => {
      if (!data.context) return;

      for (const cb of this.keyDownCallbacks) cb();

      await handler.onKeyDown?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // keyUp
    this.client.onActionEvent(uuid, "keyUp", async (data) => {
      if (!data.context) return;

      await handler.onKeyUp?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // dialRotate — fire broadcast callbacks first, then handler
    this.client.onActionEvent(uuid, "dialRotate", async (data) => {
      if (!data.context) return;

      for (const cb of this.dialRotateCallbacks) cb();

      await handler.onDialRotate?.(
        wrapDialRotateEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // dialDown — fire broadcast callbacks first, then handler
    this.client.onActionEvent(uuid, "dialDown", async (data) => {
      if (!data.context) return;

      for (const cb of this.dialDownCallbacks) cb();

      await handler.onDialDown?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });

    // dialUp
    this.client.onActionEvent(uuid, "dialUp", async (data) => {
      if (!data.context) return;

      await handler.onDialUp?.(
        wrapEvent<T>(this.client, data as VSDEvent & { context: string }, getControllerType(data.context)),
      );
    });
  }

  onKeyDown(callback: () => void): void {
    this.keyDownCallbacks.push(callback);
  }

  onDialDown(callback: () => void): void {
    this.dialDownCallbacks.push(callback);
  }

  onDialRotate(callback: () => void): void {
    this.dialRotateCallbacks.push(callback);
  }

  connect(): void {
    this.client.connect();
  }
}
