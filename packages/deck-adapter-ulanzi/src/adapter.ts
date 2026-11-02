/**
 * Ulanzi Deck Platform Adapter
 *
 * Bridges the UlanziStudio WebSocket protocol to the platform-agnostic deck-core
 * interfaces. Implements the same `IDeckPlatformAdapter` contract as the Elgato
 * and Mirabox adapters, so every iRaceDeck action runs unchanged on Ulanzi Deck
 * devices.
 *
 * The Ulanzi-specific wire translation lives in {@link UlanziClient}, which
 * normalizes Ulanzi `cmd` frames into Elgato-style events. This adapter is
 * therefore structurally near-identical to the Mirabox `VSDPlatformAdapter`.
 */
import { type LogLocation } from "@iracedeck/app-constants";
import {
  ContextEventOrder,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  DEFAULT_KEY_IMAGE_SIZE,
  type DialCanvasProfile,
  type IDeckActionContext,
  type IDeckActionHandler,
  type IDeckDialRotateEvent,
  type IDeckEvent,
  type IDeckPlatformAdapter,
  type IDeckWillDisappearEvent,
  toDeviceImage,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { createConsoleLogger, LogLevel } from "@iracedeck/logger";

import { FileSink, withFileSink } from "./file-logger.js";
import { parseConnectionParams, PLUGIN_UUID, UlanziClient, type UlanziEvent } from "./ulanzi-client.js";

/** Valid controller types for Ulanzi devices. */
type ControllerType = "Keypad" | "Encoder" | "Information";

/**
 * Wraps a Ulanzi action context (identified by its context string) into a
 * platform-agnostic IDeckActionContext.
 */
class UlanziActionContext implements IDeckActionContext {
  constructor(
    private readonly client: UlanziClient,
    readonly id: string,
    private readonly controllerType: ControllerType,
  ) {}

  async setImage(dataUri: string): Promise<void> {
    const image = await toDeviceImage(this.id, dataUri, DEFAULT_KEY_IMAGE_SIZE);

    // null = superseded by a newer image for this context — skip the send.
    if (image === null) return;

    this.client.setImage(this.id, image);
  }

  async setTitle(_title: string): Promise<void> {
    // Ulanzi has no native title API: labels travel as the `text` field of the
    // icon setter. iRaceDeck bakes the title into the icon SVG and every action
    // only ever calls setTitle("") to clear the native title — which Ulanzi
    // never draws (setImage sends showtext:false) — so this is a no-op.
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    this.client.setSettings(this.id, settings);
  }

  isKey(): boolean {
    // Ulanzi's `add` frame carries no controller hint, so a context is a Keypad
    // until it delivers dial input, when the adapter re-appears it as an
    // Encoder (see UlanziPlatformAdapter.registerAction, #1530). The 293S-style
    // Information area, like Mirabox, updates through setImage.
    return this.controllerType === "Keypad" || this.controllerType === "Information";
  }

  isDial(): boolean {
    return this.controllerType === "Encoder";
  }

  // UlanziStudio has no plugin-facing touch-strip feedback, so these are
  // no-ops on Ulanzi (the interface members exist for Stream Deck+).
  async setFeedback(_feedback: DeckFeedbackPayload): Promise<void> {}

  async setFeedbackLayout(_layout: string): Promise<void> {}

  // Ulanzi encoders have no trigger descriptions, so this is a no-op too.
  async setTriggerDescription(_descriptions: DeckTriggerDescription): Promise<void> {}

  // UlanziStudio exposes no plugin-drawable dial screen (#1013 leaves Ulanzi
  // dials out of scope), so no context here has a dial canvas.
  dialCanvas(): DialCanvasProfile | null {
    return null;
  }

  async setDialCanvas(_dataUri: string): Promise<void> {}
}

/** Create a deck-core event from a Ulanzi event with full action context. */
function wrapEvent<T>(
  client: UlanziClient,
  data: UlanziEvent & { context: string },
  controllerType: ControllerType,
): IDeckEvent<T> {
  return {
    action: new UlanziActionContext(client, data.context, controllerType),
    payload: { settings: (data.payload?.settings ?? {}) as T },
  };
}

/** Create a deck-core disappear event with no-op image/title/settings stubs. */
function wrapDisappearEvent<T>(
  data: UlanziEvent & { context: string },
  controllerType: ControllerType,
): IDeckWillDisappearEvent<T> {
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
        return controllerType === "Keypad" || controllerType === "Information";
      },
      isDial() {
        return controllerType === "Encoder";
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
    payload: { settings: (data.payload?.settings ?? {}) as T },
  };
}

/** Create a deck-core dial rotate event (includes ticks in payload). */
function wrapDialRotateEvent<T>(
  client: UlanziClient,
  data: UlanziEvent & { context: string },
  controllerType: ControllerType,
): IDeckDialRotateEvent<T> {
  return {
    action: new UlanziActionContext(client, data.context, controllerType),
    payload: {
      settings: (data.payload?.settings ?? {}) as T,
      ticks: data.payload?.ticks ?? 0,
      // Default false when the frame omits it (rotate-while-pressed support).
      pressed: data.payload?.pressed ?? false,
    },
  };
}

/**
 * Ulanzi Deck platform adapter. Implements IDeckPlatformAdapter by wrapping the
 * UlanziStudio WebSocket protocol via {@link UlanziClient}.
 */
export class UlanziPlatformAdapter implements IDeckPlatformAdapter {
  /**
   * UlanziStudio's protocol has no app-monitoring events — the client's
   * cmd→event normalization maps nothing to applicationDidLaunch/Terminate,
   * so the handlers registered below can never fire. Declaring this lets the
   * app monitor keep SDK reconnect polling enabled instead of pausing it
   * while waiting for a launch event that will never arrive (issue #870).
   */
  readonly supportsApplicationMonitoring = false;

  private readonly client: UlanziClient;
  private readonly keyDownCallbacks: (() => void)[] = [];
  private readonly dialDownCallbacks: (() => void)[] = [];
  private readonly dialRotateCallbacks: (() => void)[] = [];

  /**
   * Controller type per LIVE context, kept by the ordered tasks: the appear
   * task sets it before it calls the handler, the disappear task reads and
   * deletes it before it calls the handler (#1597). Ulanzi's `add` frame
   * carries no controller hint, so a context is a Keypad here until it
   * delivers dial input and is promoted to an Encoder (#1530).
   */
  private readonly contextControllers = new Map<string, ControllerType>();

  /**
   * Contexts known to be Encoders this process, set at arrival: a context that
   * delivered dial input (its promotion step is enqueued at that moment, so a
   * burst queues behind one step instead of starting another), one appeared
   * with an explicit `payload.controller` of `Encoder`, or one the adapter
   * appeared itself as an Encoder on dial input with no prior `add`. Unlike
   * {@link contextControllers} this survives willDisappear, so a dial that
   * re-appears (a page switch is `clear` then `add`) is an Encoder from its
   * willAppear rather than from its next dial event (#1530). Never pruned, on
   * purpose: its growth is bounded by the dials placed in one plugin process,
   * a context string each.
   */
  private readonly knownEncoderContexts = new Set<string>();

  /**
   * The per-context order of every handler event (#1597). The client
   * dispatches without awaiting, so a disappear, a settings change or input
   * can arrive while an appear is still running; every per-context event of
   * {@link registerAction} is enqueued here inside the client callback, before
   * any await, and the primitive runs the tasks in the order the spec's
   * decisions 2–4 give. This replaced #1530's own ordering (promotion promises
   * awaited at the top of every handler).
   */
  private readonly order: ContextEventOrder;

  /** Logger for controller detection (the #1530 promotion line, the #1597 synthetic appear). */
  private readonly controllerLog: ILogger;

  /** Callbacks registered via {@link onDidReceiveGlobalSettings} (fan-out list). */
  private readonly globalSettingsCallbacks: ((settings: unknown) => void)[] = [];

  /** Whether any didReceiveGlobalSettings reply has arrived this process. */
  private globalSettingsReplyReceived = false;

  /**
   * Whether a non-empty plugin-scoped reply has been applied. Once set, late
   * action-scoped replies (the boot bootstrap fallback) are dropped so a
   * per-action bucket's stale contents can't clobber authoritative data (#868).
   */
  private globalSettingsSettled = false;

  /**
   * Whether the one-shot `willAppear` global-settings re-drive was sent. Since
   * #1041 this is a fallback that should never fire — the connect-time read is
   * addressed and answered milliseconds after the socket opens, long before
   * any key can appear.
   */
  private globalSettingsBootstrapSent = false;

  /**
   * Shared, runtime-mutable minimum log level (issue #609). `createConsoleLogger`
   * captures its level at creation time, so to honour the "Enable debug logging"
   * toggle without recreating every scoped logger, loggers built here read this
   * field live via a resolver. `setLogLevel` flips it. Default: Info.
   */
  private logLevel: LogLevel = LogLevel.Info;

  /**
   * When a log directory is supplied, loggers created by this adapter also tee
   * to `<dir>/<YYYY.M.D>.log` (issue #609). Like Mirabox's Stream Dock host, the
   * UlanziStudio host discards plugin stdout, so without this the debug toggle
   * would have nothing to capture for support.
   */
  private fileSink: FileSink | null = null;

  /**
   * The per-day directory `FileSink` writes (#609), or `undefined` when built
   * without one. See {@link IDeckPlatformAdapter.logLocation}.
   */
  readonly logLocation: LogLocation | undefined;

  constructor(logger?: ILogger, logDir?: string) {
    this.fileSink = logDir ? new FileSink(logDir) : null;
    this.logLocation = logDir ? { kind: "daily", dir: logDir } : undefined;
    const log = logger ?? this.buildLogger("Ulanzi");
    this.client = new UlanziClient(parseConnectionParams(), log.createScope("WebSocket"));
    this.controllerLog = log.createScope("Controllers");
    this.order = new ContextEventOrder(log.createScope("EventOrder"));

    // The Ulanzi PI bridge relays external-link clicks as a `sendToPlugin`
    // openUrl marker — UlanziStudio ignores `openurl` sent on the PI socket but
    // honours it from the plugin socket, so forward it from here (#845). Only
    // http(s) URLs are forwarded, matching the PI external-link contract (#243)
    // and the Elgato host's own behavior.
    this.client.onGlobalEvent("openUrl", (data) => {
      const url = data.payload?.url;

      if (typeof url !== "string") return;

      let parsed: URL;

      try {
        parsed = new URL(url);
      } catch {
        log.warn("Ignoring relayed PI URL: not a valid URL");

        return;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        log.warn("Ignoring relayed PI URL: unsupported scheme");

        return;
      }

      log.info("Opening URL relayed from Property Inspector");
      // Redacted to origin + path: query/fragment could carry identifiers that
      // don't belong in console or file logs.
      log.debug(`URL: ${parsed.origin}${parsed.pathname}`);
      this.client.openUrl(url);
    });

    // Global-settings reply routing (#868). Registered here (not in
    // onDidReceiveGlobalSettings) so reply tracking runs even before the settings package
    // wires its callback. Plugin-scoped replies (uuid absent or the plugin
    // UUID) are authoritative and always forwarded. Action-scoped replies
    // exist only as the boot bootstrap fallback — forwarded while nothing
    // better has arrived, dropped once a non-empty plugin-scoped reply has
    // been applied, so a per-action bucket's stale contents can't clobber it.
    this.client.onGlobalEvent("didReceiveGlobalSettings", (data) => {
      this.globalSettingsReplyReceived = true;

      const scope = data.action ?? "";
      const pluginScoped = scope === "" || scope === PLUGIN_UUID;

      if (!pluginScoped && this.globalSettingsSettled) return;

      const settings = data.payload?.settings ?? {};

      if (pluginScoped && Object.keys(settings).length > 0) {
        this.globalSettingsSettled = true;
      }

      for (const callback of this.globalSettingsCallbacks) {
        callback(settings);
      }
    });
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
   * Set the minimum log level applied to every logger this adapter created.
   * Runtime-mutable so the PI "Enable debug logging" toggle takes effect without
   * a restart (issue #609).
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  onDidReceiveGlobalSettings(callback: (settings: unknown) => void): void {
    // Delivery runs through the constructor-registered reply router, which
    // applies the #868 scope policy before fanning out.
    this.globalSettingsCallbacks.push(callback);
  }

  /**
   * Read the deck host's global settings. The settings package calls this once per start,
   * for the one-time migration, as soon as it finds no settings file — usually
   * before the host socket is open, in which case the client's connect-time
   * read asks in its place. Either way the frame is addressed, so the host
   * answers it (#1041); see `UlanziClient.requestGlobalSettings`.
   */
  getGlobalSettings(): void {
    this.client.requestGlobalSettings();
  }

  /**
   * Report the host socket becoming usable, so the settings package can restart the
   * settings-migration deadline from the point its read can actually be
   * answered (#1056). Implemented here because this host drops a frame written
   * before its socket opens; Elgato's SDK awaits the connection inside its own
   * `send`, so that adapter declares no `onHostReady` at all and the settings package
   * keeps the deadline it armed when the read went out.
   */
  onHostReady(callback: () => void): void {
    this.client.onHostReady(callback);
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
    // UlanziStudio has no host-generated PI-appear event, so the Ulanzi PI
    // bridge sends a `sendToPlugin` marker on connect, which the client
    // normalizes to this global event (see ulanzi-client.normalizeFrame).
    this.client.onGlobalEvent("propertyInspectorDidAppear", () => {
      callback();
    });
  }

  /**
   * Register a listener for the Property Inspector's "iRaceDeck Settings"
   * request (issue #992). The shared button's `sendToPlugin { event:
   * "openSettings" }` reaches the plugin as a `sendToPlugin` frame that the
   * client normalizes to a global `openSettings` event (same path as the
   * PI-appear and openUrl markers). An `IDeckPlatformAdapter` member since
   * #1349 — the PI→plugin transport differs per host.
   */
  onOpenSettingsRequest(listener: () => void): void {
    this.client.onGlobalEvent("openSettings", () => {
      listener();
    });
  }

  createLogger(scope: string): ILogger {
    // Resolver (not a fixed level) so setLogLevel affects already-created loggers.
    return this.buildLogger(scope);
  }

  /**
   * Route every per-context event of `uuid` through {@link order} (#1597).
   * Each client callback enqueues its task before any await of its own, so
   * arrival order is the order the handler sees; the task builds the deck-core
   * event when it runs, so the controller and the settings it reads are those
   * after the events ahead of it. The result of each enqueue is returned to the
   * client, whose dispatch logs a handler's error as before; an event dropped
   * at arrival (a context that is not live) returns nothing.
   *
   * What only Ulanzi adds to the shared order:
   *
   * - **Input with no prior `add` appears the context first** (decision 3's
   *   fallback). UlanziStudio sends input for a context a plugin process never
   *   got an `add` for — the process started with keys already on the deck
   *   (measured on the SDK simulator for #1597). Such a context is appeared
   *   synthetically ahead of the input, as an Encoder when the first input is a
   *   dial event (it goes into {@link knownEncoderContexts}, so no promotion
   *   follows) and a Keypad otherwise. A context that has appeared and then
   *   disappeared is not revived: the primitive drops its input, or the #1329
   *   leak returns.
   * - **An `add` for a live context is a settings change.** The host's own
   *   `add` arriving after a synthetic appear is not a second appear; it is
   *   enqueued as `didReceiveSettings` with the frame's settings.
   * - **The Keypad → Encoder promotion is one exclusive step**, enqueued at a
   *   dial event's arrival ahead of that event (#1530, decision 5).
   * - **Every input task reads its settings when it runs**: the client's
   *   write-through cache (#1236), falling back to the frame's. An appear and a
   *   settings change keep the frame's own settings.
   * - **Broadcasts fire at arrival, for a live context only**, like Elgato's
   *   SDK-wide listeners. The synthetic appear is enqueued before that check,
   *   so a never-appeared input's broadcast fires.
   */
  registerAction<T>(uuid: string, handler: IDeckActionHandler<T>): void {
    type Frame = UlanziEvent & { context: string };

    const getControllerType = (context: string): ControllerType => {
      return this.contextControllers.get(context) ?? (this.knownEncoderContexts.has(context) ? "Encoder" : "Keypad");
    };

    /**
     * The settings an input task delivers, read when it runs: what the host
     * last sent or the plugin last wrote (the cache is write-through, #1236),
     * so a write an appear made while the input waited is not undone by the
     * frame's older snapshot. The frame's own settings when the cache has no
     * entry (a context after its `clear`).
     */
    const settingsNow = (data: Frame): Record<string, unknown> =>
      this.client.cachedSettings(data.context) ?? data.payload?.settings ?? {};

    /** `data` with `settings` in place of its own, and `event` renamed when given. */
    const withSettings = (data: Frame, settings: Record<string, unknown>, event = data.event): Frame => ({
      ...data,
      event,
      payload: { ...data.payload, settings },
    });

    /**
     * The appear task: record the controller, then call the handler. Inside the
     * task, so a disappear queued behind it never deletes an entry this has
     * not set yet.
     */
    const appear = (data: Frame, controller: ControllerType): Promise<void> | void => {
      this.contextControllers.set(data.context, controller);

      return handler.onWillAppear?.(wrapEvent<T>(this.client, data, controller));
    };

    /**
     * Re-appear a live non-Encoder context as an Encoder (#1530): tear down
     * what its willAppear built as a Keypad, then appear it again as a dial,
     * so the action routes it to its dial surface (which drops input for a
     * context its willAppear never created — encoders-and-touchscreen.md rule
     * 11). An exclusive step of the order, so when it runs every earlier event
     * of the context — the Keypad appear included — has settled, and the dial
     * event that started it waits behind it. The teardown and the re-appear
     * each carry a copy of the context's settings as the client caches them
     * now, so a write that appear made (an `addedWithVersion` stamp, seeded
     * defaults) is not lost and then overwritten from a stale view; the dial
     * event's own settings are the fallback when the cache has no entry.
     *
     * A handler that throws here is logged and the promotion carries on: the
     * context still ends up an Encoder and the dial event behind the step is
     * still delivered. Failing the step instead would leave the context a
     * Keypad whose every dial event re-runs the teardown.
     */
    const promoteToEncoder = async (data: Frame): Promise<void> => {
      const { context } = data;
      const previous = getControllerType(context);
      const settings = settingsNow(data);
      const withSettingsCopy = (event: string): Frame => withSettings(data, structuredClone(settings), event);

      this.controllerLog.info(
        `Context ${context} delivered dial input: re-appearing it as a dial (Ulanzi add frames carry no controller, #1530)`,
      );

      // Each step is awaited to completion before the next starts: actions
      // keep cleaning up (unsubscribe by id) after their base disappear, and
      // that must not land after the dial appear has subscribed.
      try {
        await handler.onWillDisappear?.(wrapDisappearEvent<T>(withSettingsCopy("willDisappear"), previous));
      } catch (error) {
        this.controllerLog.error(`Context ${context}: willDisappear as ${previous} failed while promoting: ${error}`);
      }

      try {
        await appear(withSettingsCopy("willAppear"), "Encoder");
      } catch (error) {
        this.controllerLog.error(`Context ${context}: willAppear as Encoder failed while promoting: ${error}`);
      }
    };

    /**
     * Input for a context the host never sent an `add` for: appear it first,
     * ahead of the input (decision 3's Ulanzi fallback). Only a context that
     * NEVER appeared; one that has disappeared is dropped by the order itself.
     * Logged at info once per context: this is the visible trace of the
     * appear-before-input assumption failing on this host, and a support log
     * at the default level must show it.
     */
    const appearIfNeverAdded = (data: Frame, controller: "Keypad" | "Encoder"): void => {
      const { context } = data;

      if (this.order.isLive(context) || this.order.hasAppeared(context)) return;

      this.controllerLog.info(`Synthesised willAppear for ${context}: input arrived before any add`);

      if (controller === "Encoder") this.knownEncoderContexts.add(context);

      // Discarded on purpose: a discarded enqueue result is safe (never an
      // unhandled rejection) but silent, and a synthetic appear's failure is
      // this adapter's to log, as the promotion's is.
      void this.order
        .enqueue(context, "willAppear", () => appear(withSettings(data, settingsNow(data), "willAppear"), controller))
        ?.catch((error: unknown) => {
          this.controllerLog.error(`Context ${context}: synthetic willAppear as ${controller} failed: ${error}`);
        });
    };

    /**
     * A dial event's arrival: appear a never-added context as an Encoder, fire
     * the broadcast for a live context, enqueue the promotion step for a live
     * context not yet known as an Encoder, then the event itself. The step is
     * discarded on purpose — it logs its own failures and never rejects.
     */
    const dialArrived = (data: Frame, broadcasts: readonly (() => void)[]): void => {
      const { context } = data;

      appearIfNeverAdded(data, "Encoder");

      if (this.order.isLive(context)) {
        for (const cb of broadcasts) cb();

        if (!this.knownEncoderContexts.has(context)) {
          this.knownEncoderContexts.add(context);
          void this.order.enqueue(context, "step:promoteToEncoder", () => promoteToEncoder(data));
        }
      }
    };

    // willAppear — the host's `add`. Its controller is decided at arrival: an
    // explicit one wins (forward compatibility); otherwise a context known as an
    // Encoder is one, and any other is a Keypad until it delivers dial input
    // (#1530). For a context that is already live — the host replaying its
    // `add` after the adapter appeared the context on input — this is a
    // settings change, not a second appear.
    this.client.onActionEvent(uuid, "willAppear", (data) => {
      if (!data.context) return;

      const frame = data as Frame;
      const { context } = frame;

      // Global-settings re-drive (#868), now a FALLBACK rather than the
      // mechanism (#1041): the connect-time read carries an address of its own
      // and is answered, so by the time any key appears a reply has long since
      // arrived and this is skipped. It stays for the one assumption the
      // addressed read rests on — that the host keeps echoing an `actionid` it
      // has never seen rather than resolving it. A real action context is a
      // different shape that #1039 measured as answered, so if a host version
      // ever stopped echoing, this is the only route left to a reply.
      if (!this.globalSettingsReplyReceived && !this.globalSettingsBootstrapSent) {
        this.globalSettingsBootstrapSent = true;
        this.client.requestGlobalSettings(context);
      }

      if (this.order.isLive(context)) {
        this.controllerLog.debug(`Context ${context}: add arrived while live, delivered as a settings change`);

        return this.order.enqueue(context, "didReceiveSettings", () =>
          handler.onDidReceiveSettings?.(wrapEvent<T>(this.client, frame, getControllerType(context))),
        );
      }

      const explicit = frame.payload?.controller as ControllerType | undefined;

      if (explicit === "Encoder") this.knownEncoderContexts.add(context);

      const controller = explicit ?? (this.knownEncoderContexts.has(context) ? "Encoder" : "Keypad");

      return this.order.enqueue(context, "willAppear", () => appear(frame, controller));
    });

    // willDisappear — the controller entry is read and dropped inside the task,
    // before the handler runs, so it is dropped even if the handler throws and
    // a re-add queued behind this teardown sets its fresh entry after the delete.
    this.client.onActionEvent(uuid, "willDisappear", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      return this.order.enqueue(frame.context, "willDisappear", () => {
        const controller = getControllerType(frame.context);

        this.contextControllers.delete(frame.context);

        return handler.onWillDisappear?.(wrapDisappearEvent<T>(frame, controller));
      });
    });

    // didReceiveSettings — the host's settings, not a backfill, so the frame's own.
    this.client.onActionEvent(uuid, "didReceiveSettings", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      return this.order.enqueue(frame.context, "didReceiveSettings", () =>
        handler.onDidReceiveSettings?.(wrapEvent<T>(this.client, frame, getControllerType(frame.context))),
      );
    });

    // keyDown — appear a never-added context, broadcast (for window focus), then the handler.
    this.client.onActionEvent(uuid, "keyDown", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      appearIfNeverAdded(frame, "Keypad");

      if (this.order.isLive(frame.context)) for (const cb of this.keyDownCallbacks) cb();

      return this.order.enqueue(frame.context, "keyDown", () =>
        handler.onKeyDown?.(
          wrapEvent<T>(this.client, withSettings(frame, settingsNow(frame)), getControllerType(frame.context)),
        ),
      );
    });

    // keyUp
    this.client.onActionEvent(uuid, "keyUp", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      appearIfNeverAdded(frame, "Keypad");

      return this.order.enqueue(frame.context, "keyUp", () =>
        handler.onKeyUp?.(
          wrapEvent<T>(this.client, withSettings(frame, settingsNow(frame)), getControllerType(frame.context)),
        ),
      );
    });

    // dialRotate
    this.client.onActionEvent(uuid, "dialRotate", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      dialArrived(frame, this.dialRotateCallbacks);

      return this.order.enqueue(frame.context, "dialRotate", () =>
        handler.onDialRotate?.(
          wrapDialRotateEvent<T>(
            this.client,
            withSettings(frame, settingsNow(frame)),
            getControllerType(frame.context),
          ),
        ),
      );
    });

    // dialDown
    this.client.onActionEvent(uuid, "dialDown", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      dialArrived(frame, this.dialDownCallbacks);

      return this.order.enqueue(frame.context, "dialDown", () =>
        handler.onDialDown?.(
          wrapEvent<T>(this.client, withSettings(frame, settingsNow(frame)), getControllerType(frame.context)),
        ),
      );
    });

    // dialUp
    this.client.onActionEvent(uuid, "dialUp", (data) => {
      if (!data.context) return;

      const frame = data as Frame;

      dialArrived(frame, []);

      return this.order.enqueue(frame.context, "dialUp", () =>
        handler.onDialUp?.(
          wrapEvent<T>(this.client, withSettings(frame, settingsNow(frame)), getControllerType(frame.context)),
        ),
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
   * Open a URL in the user's default browser. Best-effort: delegates to the
   * Ulanzi client's `openurl` command, harmless if the host ignores it.
   */
  async openUrl(url: string): Promise<void> {
    this.client.openUrl(url);
  }

  /**
   * No-op: Stream Deck profiles are an Elgato-only concept and the UlanziStudio
   * host has no profile system. The "Stream Deck Profiles" settings accordion is
   * hidden on this platform (via the `profiles` feature flag), so this is never
   * reached in practice; it exists to satisfy `IDeckPlatformAdapter`.
   */
  async switchToProfile(_deviceId: string, _profile?: string, _page?: number): Promise<void> {
    // no-op
  }

  connect(): void {
    void this.client.connect();
  }
}
