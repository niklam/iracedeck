/**
 * Base Action for Deck Devices
 *
 * Platform-agnostic abstract base class for deck device actions with:
 * - SVG image management
 * - Per-instance active/inactive state tracking
 * - Flag overlay support (flashes flag colors when race flags are active)
 */
import { type FlagInfo, resolveAllActiveFlags } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { getGlobalSettings, onGlobalSettingsChange } from "./global-settings.js";
import { applyInactiveOverlay, svgToDataUri } from "./overlay-utils.js";
import { getController } from "./sdk-singleton.js";
import type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialDownEvent,
  IDeckDialRotateEvent,
  IDeckDialUpEvent,
  IDeckDidReceiveSettingsEvent,
  IDeckEvent,
  IDeckKeyDownEvent,
  IDeckKeyUpEvent,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
} from "./types.js";

/**
 * Union of event types that have an action property supporting isKey()
 * Note: WillDisappearEvent is excluded as its action may not support isKey()
 */
type KeyCompatibleEvent<T> = IDeckWillAppearEvent<T> | IDeckDidReceiveSettingsEvent<T> | IDeckEvent<T>;

/**
 * Stored context info for refreshing images
 */
interface ContextEntry {
  action: IDeckActionContext;
  svg: string;
  /** Optional callback to regenerate the SVG (for global color updates) */
  regenerate?: () => string;
}

/**
 * Abstract base class for deck device actions.
 *
 * Features:
 * - Provides `setKeyImage(ev, svg)` for setting images
 * - Provides `setActive(isActive)` to track active state
 * - Subclasses should handle inactive appearance in their SVG generation
 *
 * @template T - The settings type for this action
 */
export abstract class BaseAction<T = Record<string, unknown>> implements IDeckActionHandler<T> {
  /**
   * Logger instance - subclasses can override with a scoped logger
   */
  protected logger: ILogger;

  /**
   * Per-instance active state
   */
  private _isActive = true;

  /**
   * Per-instance storage: contextId -> { action, svg }
   * Used to refresh images when active state changes
   */
  private contexts = new Map<string, ContextEntry>();

  /** Contexts with flag overlay enabled (settings.flagsOverlay === true) */
  protected flagOverlayContexts = new Set<string>();

  /** Contexts currently displaying a flag color (image output gated) */
  protected flagOverlayActive = new Set<string>();

  /** Shared flash timer for all overlay contexts */
  private flagFlashTimer: ReturnType<typeof setInterval> | null = null;

  /** Current active flags from telemetry */
  private currentFlags: FlagInfo[] = [];

  /** Flash tick counter — even ticks show flag, odd ticks show original */
  private flagFlashTick = 0;

  /** Shared telemetry subscription ID */
  private flagTelemetrySubId: string | null = null;

  /** Last flag state key for change detection */
  private lastFlagStateKey = "";

  private static readonly FLAG_FLASH_INTERVAL_MS = 500;
  private static readonly FLAG_SUBSCRIPTION_PREFIX = "__flag_overlay__";
  private static flagSubscriptionCounter = 0;

  constructor(logger: ILogger = silentLogger) {
    this.logger = logger;

    // Subscribe to global settings changes to refresh overlays and re-render colors.
    // Constructor side-effect: needed because action instances are created once
    // at plugin startup and must react to settings changes throughout their lifetime.
    // Order matters: regenerate SVGs first, then push updated images to device.
    onGlobalSettingsChange(() => {
      this.onGlobalSettingsUpdated();
      this.refreshAllImages();
    });
  }

  /**
   * Called when global settings change. Re-generates icons for contexts
   * that have a regenerate callback registered.
   */
  protected onGlobalSettingsUpdated(): void {
    for (const [_contextId, entry] of this.contexts) {
      if (!entry.regenerate) continue;

      try {
        const newSvg = entry.regenerate();
        entry.svg = newSvg;
      } catch {
        // regenerate failed, keep existing svg
      }
    }
  }

  /**
   * Register a callback to regenerate the SVG for a context when global colors change.
   * Call this after setKeyImage() in your updateDisplay method.
   *
   * @param contextId - The action context ID
   * @param regenerate - Function that returns the new SVG data URI
   */
  protected setRegenerateCallback(contextId: string, regenerate: () => string): void {
    const entry = this.contexts.get(contextId);

    if (entry) {
      entry.regenerate = regenerate;
    }
  }

  /**
   * Refresh all context images with current overlay state.
   * Called when global settings change.
   */
  private refreshAllImages(): void {
    for (const [contextId, { action, svg }] of this.contexts) {
      // Skip contexts with active flag overlay
      if (this.flagOverlayActive.has(contextId)) continue;

      const finalImage = this.applyOverlayIfNeeded(svg);
      action.setImage(finalImage).catch((err) => {
        this.logger.warn(`Failed to refresh image for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Check if overlay should be applied based on active state and global settings.
   * @returns true if overlay should be applied (inactive AND disableWhenDisconnected is true)
   */
  private shouldApplyOverlay(): boolean {
    if (this._isActive) return false;

    const globalSettings = getGlobalSettings();

    return globalSettings.disableWhenDisconnected;
  }

  /**
   * Apply the appropriate image based on active state and global settings.
   * @param svg - The original SVG
   * @returns The final image (with or without overlay)
   */
  private applyOverlayIfNeeded(svg: string): string {
    return this.shouldApplyOverlay() ? applyInactiveOverlay(svg) : svg;
  }

  /**
   * Toggle active state for this action instance.
   * When inactive and disableWhenDisconnected is enabled, all stored images will have an overlay applied.
   *
   * @param isActive - Whether this action should appear active
   */
  setActive(isActive: boolean): void {
    if (this._isActive === isActive) return;

    this.logger.info(`setActive: ${this._isActive} -> ${isActive}`);
    this._isActive = isActive;

    const applyOverlay = this.shouldApplyOverlay();
    this.logger.info(`Refreshing ${this.contexts.size} contexts with overlay=${applyOverlay}`);

    for (const [contextId, { action, svg }] of this.contexts) {
      // Skip contexts with active flag overlay
      if (this.flagOverlayActive.has(contextId)) {
        this.logger.trace(`setActive: skipped context ${contextId} (flag overlay active)`);
        continue;
      }

      const finalImage = this.applyOverlayIfNeeded(svg);
      this.logger.trace(`Updating context ${contextId} image`);
      // Fire and forget - we don't want to block
      action.setImage(finalImage).catch((err) => {
        this.logger.warn(`Failed to update image for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Get the current active state for this action
   */
  getIsActive(): boolean {
    return this._isActive;
  }

  /**
   * Set the key image for an action. The image is stored for later reference.
   * If inactive, the grayscale overlay is applied automatically.
   *
   * @param ev - The event containing the action reference
   * @param svg - Raw SVG string or base64 data URI
   */
  protected async setKeyImage(ev: KeyCompatibleEvent<T>, svg: string): Promise<void> {
    if (!ev.action.isKey()) {
      this.logger.debug(`setKeyImage: skipping non-key action ${ev.action.id}`);

      return;
    }

    // Store original SVG for later refresh (always, even during flag overlay)
    this.contexts.set(ev.action.id, { action: ev.action, svg });
    this.logger.debug(`setKeyImage: stored context ${ev.action.id}, isActive=${this._isActive}`);

    // Skip visual update if flag overlay is active for this context
    if (this.flagOverlayActive.has(ev.action.id)) {
      this.logger.trace(`setKeyImage: skipped visual update (flag overlay active) for ${ev.action.id}`);

      return;
    }

    // Apply overlay if inactive and global setting is enabled
    const finalImage = this.applyOverlayIfNeeded(svg);
    await ev.action.setImage(finalImage);
    this.logger.trace(`setKeyImage: image set for ${ev.action.id}`);
  }

  /**
   * Get the stored original SVG for a context
   */
  protected getKeyImage(contextId: string): string | undefined {
    return this.contexts.get(contextId)?.svg;
  }

  /**
   * Update the key image for a context using a new SVG.
   * Uses the stored action reference from a previous setKeyImage call.
   * If inactive, the grayscale overlay is applied automatically.
   *
   * @param contextId - The context ID to update
   * @param svg - Raw SVG string or base64 data URI
   * @returns true if the context was found and updated, false otherwise
   */
  protected async updateKeyImage(contextId: string, svg: string): Promise<boolean> {
    const entry = this.contexts.get(contextId);

    if (!entry) {
      this.logger.debug(`updateKeyImage: context ${contextId} not found`);

      return false;
    }

    // Store original SVG for later refresh (always, even during flag overlay)
    entry.svg = svg;

    // Skip visual update if flag overlay is active for this context
    if (this.flagOverlayActive.has(contextId)) {
      this.logger.trace(`updateKeyImage: skipped visual update (flag overlay active) for ${contextId}`);

      return true;
    }

    // Apply overlay if inactive and global setting is enabled
    const finalImage = this.applyOverlayIfNeeded(svg);
    await entry.action.setImage(finalImage);
    this.logger.trace(`updateKeyImage: updated ${contextId}, isActive=${this._isActive}`);

    return true;
  }

  /**
   * Called when the action appears on the device.
   * Tracks flag overlay opt-in from settings.
   *
   * Subclasses should call `super.onWillAppear(ev)` if they override this.
   */
  async onWillAppear(ev: IDeckWillAppearEvent<T>): Promise<void> {
    const settings = ev.payload.settings as Record<string, unknown>;

    if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
      this.flagOverlayContexts.add(ev.action.id);
      this.ensureFlagTelemetrySubscription();
      this.logger.debug(`Flag overlay enabled for context ${ev.action.id}`);
    }
  }

  /**
   * Called when action settings change from the Property Inspector.
   * Updates flag overlay opt-in.
   *
   * Subclasses should call `super.onDidReceiveSettings(ev)` if they override this.
   */
  async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<T>): Promise<void> {
    const settings = ev.payload.settings as Record<string, unknown>;

    if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
      this.flagOverlayContexts.add(ev.action.id);
      this.ensureFlagTelemetrySubscription();
    } else {
      this.flagOverlayContexts.delete(ev.action.id);

      // Restore original image if flag overlay was active
      if (this.flagOverlayActive.delete(ev.action.id)) {
        this.restoreFlagOverlayImage(ev.action.id);
      }

      this.cleanupFlagSubscriptionIfUnneeded();
    }
  }

  /**
   * Called when the action disappears from the device.
   * Cleans up stored context.
   *
   * Subclasses should call `super.onWillDisappear(ev)` if they override this.
   */
  async onWillDisappear(ev: IDeckWillDisappearEvent<T>): Promise<void> {
    this.flagOverlayContexts.delete(ev.action.id);
    this.flagOverlayActive.delete(ev.action.id);
    this.cleanupFlagSubscriptionIfUnneeded();
    this.contexts.delete(ev.action.id);
    this.logger.debug(`onWillDisappear: removed context ${ev.action.id}, remaining=${this.contexts.size}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async onKeyDown(ev: IDeckKeyDownEvent<T>): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async onKeyUp(ev: IDeckKeyUpEvent<T>): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async onDialRotate(ev: IDeckDialRotateEvent<T>): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async onDialDown(ev: IDeckDialDownEvent<T>): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async onDialUp(ev: IDeckDialUpEvent<T>): Promise<void> {}

  /**
   * Generate a solid-color SVG for a flag overlay.
   */
  protected generateFlagOverlaySvg(flagInfo: FlagInfo): string {
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="8" fill="${flagInfo.color}"/></svg>`,
    );
  }

  /**
   * Ensure a single telemetry subscription exists for flag overlay.
   */
  private ensureFlagTelemetrySubscription(): void {
    if (this.flagTelemetrySubId) return;

    try {
      const controller = getController();
      const subId = `${BaseAction.FLAG_SUBSCRIPTION_PREFIX}${++BaseAction.flagSubscriptionCounter}`;

      controller.subscribe(subId, (telemetry, isConnected) => {
        if (!isConnected) {
          this.onFlagTelemetryUpdate(undefined);

          return;
        }

        this.onFlagTelemetryUpdate(telemetry?.SessionFlags);
      });

      this.flagTelemetrySubId = subId;
      this.logger.debug("Flag overlay telemetry subscription started");
    } catch (err) {
      this.logger.debug(`Flag overlay: skipping telemetry subscription: ${err}`);
    }
  }

  /**
   * Process telemetry update for flag detection.
   */
  private onFlagTelemetryUpdate(sessionFlags: number | undefined): void {
    const flags = resolveAllActiveFlags(sessionFlags);
    const stateKey = flags.map((f) => f.label).join(",");

    if (stateKey === this.lastFlagStateKey) return;

    this.logger.info("Flag state changed");
    this.logger.debug(`SessionFlags=0x${sessionFlags?.toString(16) ?? "undefined"}, resolved=[${stateKey || "none"}]`);

    this.lastFlagStateKey = stateKey;
    this.currentFlags = flags;
    this.flagFlashTick = 0;

    if (flags.length > 0) {
      this.startFlagFlash();
    } else {
      this.stopFlagFlash();
    }
  }

  /**
   * Start or restart the flag flash timer.
   */
  private startFlagFlash(): void {
    // Clear existing timer to prevent leaks
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
    }

    this.logger.debug(
      `Starting flag flash: flags=[${this.currentFlags.map((f) => f.label).join(",")}], contexts=${this.flagOverlayContexts.size}`,
    );

    // Immediately show first flag
    this.applyFlagOverlayToContexts();

    this.flagFlashTimer = setInterval(() => {
      this.flagFlashTick++;

      if (this.flagFlashTick % 2 === 0) {
        // Even tick: show flag color
        this.applyFlagOverlayToContexts();
      } else {
        // Odd tick: restore original image
        this.restoreAllFlagOverlayImages();
      }
    }, BaseAction.FLAG_FLASH_INTERVAL_MS);
  }

  /**
   * Stop the flag flash timer and restore original images.
   */
  private stopFlagFlash(): void {
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
      this.flagFlashTimer = null;
      this.logger.debug("Flag flash stopped");
    }

    // Restore all overlay-active contexts
    for (const contextId of this.flagOverlayActive) {
      this.restoreFlagOverlayImage(contextId);
    }

    this.flagOverlayActive.clear();

    // Reset state so flash restarts correctly if re-enabled
    this.lastFlagStateKey = "";
    this.currentFlags = [];
    this.flagFlashTick = 0;
  }

  /**
   * Apply the current flag color to all overlay-enabled contexts.
   */
  private applyFlagOverlayToContexts(): void {
    if (this.currentFlags.length === 0) return;

    // Rotate through flags using even ticks only (tick 0, 2, 4... → index 0, 1, 2...)
    const flagIndex = Math.floor(this.flagFlashTick / 2) % this.currentFlags.length;
    const flagInfo = this.currentFlags[flagIndex];
    const flagSvg = this.generateFlagOverlaySvg(flagInfo);

    for (const contextId of this.flagOverlayContexts) {
      const entry = this.contexts.get(contextId);

      if (!entry) continue;

      this.flagOverlayActive.add(contextId);
      entry.action.setImage(flagSvg).catch((err) => {
        this.logger.warn(`Failed to set flag overlay for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Restore original images for all overlay-enabled contexts (flash off-phase).
   */
  private restoreAllFlagOverlayImages(): void {
    for (const contextId of this.flagOverlayContexts) {
      this.restoreFlagOverlayImage(contextId);
    }
  }

  /**
   * Restore the original image for a context after flag overlay ends.
   */
  private restoreFlagOverlayImage(contextId: string): void {
    const entry = this.contexts.get(contextId);

    if (!entry) return;

    const finalImage = this.applyOverlayIfNeeded(entry.svg);
    entry.action.setImage(finalImage).catch((err) => {
      this.logger.warn(`Failed to restore image for context ${contextId}: ${err}`);
    });
  }

  /**
   * Unsubscribe from telemetry if no contexts need flag overlay.
   */
  private cleanupFlagSubscriptionIfUnneeded(): void {
    if (this.flagOverlayContexts.size > 0 || !this.flagTelemetrySubId) return;

    try {
      const controller = getController();
      controller.unsubscribe(this.flagTelemetrySubId);
    } catch (err) {
      this.logger.trace(`Flag overlay: unsubscription failed (SDK may not be initialized): ${err}`);
    }

    this.flagTelemetrySubId = null;
    this.stopFlagFlash();
    this.logger.debug("Flag overlay telemetry subscription stopped");
  }
}
