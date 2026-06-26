/**
 * VSDinside Stream Dock Platform Adapter
 *
 * Bridges the VSD Craft WebSocket protocol to the platform-agnostic deck-core
 * interfaces. Implements the same IDeckPlatformAdapter contract as the Elgato
 * adapter, enabling all iRaceDeck actions to run on VSDinside devices.
 */
import type {
  DeckFeedbackPayload,
  DeckTriggerDescription,
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialRotateEvent,
  IDeckEvent,
  IDeckPlatformAdapter,
  IDeckWillDisappearEvent,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { createConsoleLogger, LogLevel } from "@iracedeck/logger";

import { FileSink, withFileSink } from "./file-logger.js";
import { parseConnectionParams, VSDClient, type VSDEvent } from "./vsd-client.js";

/** Valid controller types for VSD/Elgato devices. */
type ControllerType = "Keypad" | "Encoder" | "Knob" | "Information";

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

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    this.client.setSettings(this.id, settings);
  }

  isKey(): boolean {
    // Stream Dock 293S exposes its read-only information area through
    // setImage, so display-only contexts should use the shared image path.
    return this.controllerType === "Keypad" || this.controllerType === "Information";
  }

  isDial(): boolean {
    return this.controllerType === "Knob" || this.controllerType === "Encoder";
  }

  // Stream Dock protocol has no plugin-facing touch-strip feedback, so these
  // are no-ops on Mirabox (the interface members exist for Stream Deck+).
  async setFeedback(_feedback: DeckFeedbackPayload): Promise<void> {}

  async setFeedbackLayout(_layout: string): Promise<void> {}

  // Stream Dock knobs have no trigger descriptions, so this is a no-op too.
  async setTriggerDescription(_descriptions: DeckTriggerDescription): Promise<void> {}
}

/**
 * Create a deck-core event from a VSD event with full action context.
 */
function wrapEvent<T>(
  client: VSDClient,
  data: VSDEvent & { context: string },
  controllerType: ControllerType,
): IDeckEvent<T> {
  const payload = data.payload as Record<string, unknown> | undefined;
  const coordinates = payload?.coordinates as { row: number; column: number } | undefined;

  return {
    action: new VSDActionContext(client, data.context, controllerType),
    payload: { settings: (payload?.settings ?? {}) as T, coordinates },
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
      // Mirabox's C++ SDK sends `pressed` on rotate frames (rotate-while-pressed
      // is native, not Elgato-only). Default false when the frame omits it.
      pressed: data.payload?.pressed ?? false,
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

  /**
   * Shared, runtime-mutable minimum log level (issue #609). `createConsoleLogger`
   * captures its level at creation time, so to honour the "Enable debug logging"
   * toggle without recreating every scoped logger, loggers built here read this
   * field live via a resolver. `setLogLevel` flips it; the change takes effect on
   * the next log call from any logger this adapter created. Default: Info.
   */
  private logLevel: LogLevel = LogLevel.Info;

  /**
   * When a log directory is supplied, loggers created by this adapter also tee
   * to `<dir>/<YYYY.M.D>.log` (issue #609). The Stream Dock host discards plugin
   * stdout, so without this the debug toggle would have nothing to capture for
   * support.
   */
  private fileSink: FileSink | null = null;

  constructor(logger?: ILogger, logDir?: string) {
    this.fileSink = logDir ? new FileSink(logDir) : null;
    const log = logger ?? this.buildLogger("VSD");
    this.client = new VSDClient(parseConnectionParams(), log.createScope("WebSocket"));
  }

  /**
   * Build a logger for `scope`: a console logger reading the live level,
   * additionally teed to the per-day log file when file logging is enabled.
   */
  private buildLogger(scope: string): ILogger {
    const base = createConsoleLogger(scope, () => this.logLevel);

    return this.fileSink ? withFileSink(base, scope, () => this.logLevel, this.fileSink) : base;
  }

  /**
   * Set the minimum log level applied to every logger this adapter created
   * (including its own and all action scopes). Runtime-mutable so the PI
   * "Enable debug logging" toggle takes effect without a restart (issue #609).
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
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

  onPropertyInspectorDidAppear(callback: () => void): void {
    // VSD Craft mimics the Elgato protocol; `propertyInspectorDidAppear`
    // carries an `action` field, but `routeEvent` also fans it out to
    // global handlers, so a single generic subscription here is enough.
    // Callback is parameterless because consumers today only need the
    // "some PI opened" signal, not per-action identity.
    this.client.onGlobalEvent("propertyInspectorDidAppear", () => {
      callback();
    });
  }

  createLogger(scope: string): ILogger {
    // Resolver (not a fixed level) so setLogLevel affects already-created loggers.
    return this.buildLogger(scope);
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

  /**
   * Open a URL in the user's default browser. Best-effort: delegates to the VSD
   * client's `openUrl` command, which is harmless if the Stream Dock host ignores it.
   */
  async openUrl(url: string): Promise<void> {
    this.client.openUrl(url);
  }

  connect(): void {
    this.client.connect();
  }
}
