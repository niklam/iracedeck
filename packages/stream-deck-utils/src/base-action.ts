/**
 * Base Action for Stream Deck
 *
 * Abstract base class that extends SingletonAction with:
 * - SVG image management with inactive overlay support
 * - Per-instance active/inactive state
 */
import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { applyInactiveOverlay } from "./overlay-utils.js";

/**
 * Union of event types that have an action property supporting isKey()
 * Note: WillDisappearEvent is excluded as its action is ActionContext, not KeyAction/DialAction
 */
type KeyCompatibleEvent<T extends JsonObject> =
  | WillAppearEvent<T>
  | KeyDownEvent<T>
  | KeyUpEvent<T>
  | DidReceiveSettingsEvent<T>;

/**
 * Stored context info for refreshing images
 */
interface ContextEntry<T extends JsonObject> {
  action: KeyAction<T>;
  svg: string;
}

/**
 * Abstract base class for Stream Deck actions with inactive overlay support.
 *
 * Features:
 * - Provides `setKeyImage(ev, svg)` for setting images with automatic overlay when inactive
 * - Provides `setActive(isActive)` to toggle overlay state and refresh all contexts
 *
 * @template T - The settings type for this action
 *
 * @example
 * ```typescript
 * @action({ UUID: "com.example.my-action" })
 * export class MyAction extends BaseAction<MySettings> {
 *   override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
 *     await super.onWillAppear(ev);
 *     await this.setKeyImage(ev, generateMySvg());
 *   }
 * }
 *
 * // In plugin.ts:
 * const myAction = new MyAction();
 * streamDeck.actions.registerAction(myAction);
 * controller.on('connectionChange', (isConnected) => myAction.setActive(isConnected));
 * ```
 */
export abstract class BaseAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
  /**
   * Per-instance active state - when false, images get the inactive overlay
   */
  private _isActive = true;

  /**
   * Per-instance storage: contextId -> { action, svg }
   * Used to refresh images when active state changes
   */
  private contexts = new Map<string, ContextEntry<T>>();

  /**
   * Toggle active state for this action instance.
   * When inactive, all stored images will have an overlay applied.
   *
   * @param isActive - Whether this action should appear active
   */
  setActive(isActive: boolean): void {
    if (this._isActive === isActive) return;

    this._isActive = isActive;

    // Refresh all contexts with new active state
    for (const [, { action, svg }] of this.contexts) {
      const finalImage = isActive ? svg : applyInactiveOverlay(svg);
      // Fire and forget - we don't want to block
      action.setImage(finalImage).catch(() => {
        // Ignore errors (action may have disappeared)
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
   * Set the key image for an action. The image is stored and will have
   * an inactive overlay applied if this action is inactive.
   *
   * @param ev - The event containing the action reference
   * @param svg - Raw SVG string or base64 data URI
   */
  protected async setKeyImage(ev: KeyCompatibleEvent<T>, svg: string): Promise<void> {
    if (!ev.action.isKey()) return;

    const keyAction = ev.action as KeyAction<T>;

    // Store for later refresh
    this.contexts.set(ev.action.id, { action: keyAction, svg });

    const finalImage = this._isActive ? svg : applyInactiveOverlay(svg);
    await keyAction.setImage(finalImage);
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
   *
   * @param contextId - The context ID to update
   * @param svg - Raw SVG string or base64 data URI
   * @returns true if the context was found and updated, false otherwise
   */
  protected async updateKeyImage(contextId: string, svg: string): Promise<boolean> {
    const entry = this.contexts.get(contextId);

    if (!entry) return false;

    entry.svg = svg;
    const finalImage = this._isActive ? svg : applyInactiveOverlay(svg);
    await entry.action.setImage(finalImage);

    return true;
  }

  /**
   * Called when the action disappears from the Stream Deck.
   * Cleans up stored context.
   *
   * Subclasses should call `super.onWillDisappear(ev)` if they override this.
   */
  override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
    this.contexts.delete(ev.action.id);
  }
}
