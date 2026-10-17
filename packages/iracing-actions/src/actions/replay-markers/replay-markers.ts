import {
  assembleIcon,
  type BusyMark,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  IconUpdateThrottle,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import { SimIRacingAction } from "@iracedeck/deck-iracing";
import addIconSvg from "@iracedeck/icons/replay-markers/add.svg";
import confirmAddedIconSvg from "@iracedeck/icons/replay-markers/confirm-added.svg";
import confirmDeletedIconSvg from "@iracedeck/icons/replay-markers/confirm-deleted.svg";
import deleteIconSvg from "@iracedeck/icons/replay-markers/delete.svg";
import nextIconSvg from "@iracedeck/icons/replay-markers/next.svg";
import previousIconSvg from "@iracedeck/icons/replay-markers/previous.svg";
import { getReplaySessionStore, isReplaySessionStoreInitialized } from "@iracedeck/replay-store";
import { getGlobalColors } from "@iracedeck/settings";

import { getReplayBusyLook, registerReplayBusySurface } from "../../shared/replay-busy-indicator.js";
import { replayBusyKeyMark } from "../../shared/replay-busy-mark.js";
import { unavailableLook } from "../../shared/unavailable-look.js";
import { ReplayMarkersDialSurface } from "./replay-markers-dial-surface.js";
import {
  addMarkerAt,
  CONFIRMATION_FLASH_MS,
  deleteMarkerAt,
  followMarkerJump,
  jumpToMarkerFrame,
  type MarkerDirection,
  readReplayContext,
  type ReplayContextResult,
  type ReplayContextSource,
  resolveJumpTarget,
  resolveMarkerJumpAnchor,
} from "./replay-markers-ops.js";
import {
  parseReplayMarkersSettings,
  type ReplayMarkersMode,
  type ReplayMarkersSettings,
} from "./replay-markers-settings.js";

// The keypad's helpers moved to their own modules so the dial surface shares
// them (#1230); re-exported so this module's API is unchanged.
export { buildMarker, CONFIRMATION_FLASH_MS, pickMarkerToDelete, readSubSessionId } from "./replay-markers-ops.js";
export {
  ReplayMarkersDialSettings,
  ReplayMarkersSettings,
  SECONDS_BACK_DEFAULT,
  SECONDS_BACK_MAX,
} from "./replay-markers-settings.js";

/**
 * Replay Markers (issue #1162): mark a moment and jump back to it. A marker is
 * an absolute replay frame kept in the per-session replay store; Next and
 * Previous jump to one with the shared replay jump sequence, which leaves the
 * replay the way the Replay jump playback setting says (#1276). Design:
 * `docs/superpowers/specs/2026-09-13-issue-1162-replay-markers.md`. Since
 * #1230 the action is dual-surface: a dial instance routes every event to
 * {@link ReplayMarkersDialSurface}.
 */

/** The modes that jump, and so grey out when there is nowhere to jump to. */
type ReplayMarkersJumpMode = Extract<ReplayMarkersMode, MarkerDirection>;

function isJumpMode(mode: ReplayMarkersMode): mode is ReplayMarkersJumpMode {
  return mode === "next" || mode === "previous";
}

/** Title text for each mode (format: "subLabel\nmainLabel"). */
const REPLAY_MARKERS_TITLES: Record<ReplayMarkersMode, string> = {
  add: "MARKER\nADD",
  delete: "MARKER\nDELETE",
  next: "MARKER\nNEXT",
  previous: "MARKER\nPREVIOUS",
};

const REPLAY_MARKERS_ICONS: Record<ReplayMarkersMode, string> = {
  add: addIconSvg,
  delete: deleteIconSvg,
  next: nextIconSvg,
  previous: previousIconSvg,
};

/** The confirmation a successful Add or Delete flashes on the key. */
export type ReplayMarkerConfirmation = "added" | "deleted";

const CONFIRMATION_ICONS: Record<ReplayMarkerConfirmation, string> = {
  added: confirmAddedIconSvg,
  deleted: confirmDeletedIconSvg,
};

const CONFIRMATION_TITLES: Record<ReplayMarkerConfirmation, string> = {
  added: "MARKER\nADDED",
  deleted: "MARKER\nDELETED",
};

/**
 * What a key shows besides its plain mode icon: the brief Added / Deleted
 * flash, or `"unavailable"` — a Next / Previous key whose press would send
 * nothing right now.
 */
export type ReplayMarkersKeyState = ReplayMarkerConfirmation | "unavailable";

/**
 * @internal Exported for testing
 *
 * The key icon for a mode, or — with `state` — the brief Added / Deleted
 * flash or the greyed "unavailable" look. The flash keeps the key's title
 * styling but not its colour or title text overrides: it is a fixed green /
 * red signal, so it reads the same on every key. The unavailable look is the
 * key's own icon, overrides and all, greyed and faded (`unavailableLook`,
 * shared with Replay Control's Jump to Race Start), so a customised key still
 * reads as itself, only switched off.
 *
 * With `busy` (#1437), the key's own icon in its own colours with the replay
 * busy mark in place of the artwork. It beats both states: the press is what
 * the user is looking at, so neither the grey nor a flash is drawn while it
 * stands.
 */
export function generateReplayMarkersSvg(
  settings: ReplayMarkersSettings,
  state?: ReplayMarkersKeyState,
  busy?: BusyMark,
): string {
  if (busy) state = undefined;

  if (state === "added" || state === "deleted") {
    const confirmation = state;
    const iconSvg = CONFIRMATION_ICONS[confirmation];
    const colors = resolveIconColors(iconSvg, getGlobalColors(), undefined);
    const { titleText: _ignored, ...titleStyle } = settings.titleOverrides ?? {};
    const title = resolveTitleSettings(
      iconSvg,
      getGlobalTitleSettings(),
      { ...titleStyle, showTitle: true },
      CONFIRMATION_TITLES[confirmation],
    );
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
  }

  const unavailable = state === "unavailable";
  const iconSvg = REPLAY_MARKERS_ICONS[settings.mode] ?? REPLAY_MARKERS_ICONS.add;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    REPLAY_MARKERS_TITLES[settings.mode] ?? REPLAY_MARKERS_TITLES.add,
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({
    graphicSvg: iconSvg,
    title,
    graphic,
    busy,
    ...(unavailable ? unavailableLook(colors, border) : { colors, border }),
  });
}

export const REPLAY_MARKERS_UUID = "com.iracedeck.sd.core.replay-markers" as const;

export class ReplayMarkers extends SimIRacingAction<ReplayMarkersSettings> {
  private readonly activeContexts = new Map<string, ReplayMarkersSettings>();
  private readonly flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly imageThrottle = new IconUpdateThrottle();
  /** Per Next / Previous context: whether the icon on the key shows the jump as available. */
  private readonly shownAvailable = new Map<string, boolean>();
  /**
   * Per Next / Previous key: the unregister of its registration with the
   * replay busy indicator (#1437). Add and Delete send no replay command and
   * have no entry.
   */
  private readonly busyRegistrations = new Map<string, () => void>();

  /** Where both surfaces read the replay context from. */
  private readonly contextSource: ReplayContextSource = {
    getConnectionStatus: () => this.sdkController.getConnectionStatus(),
    getCurrentTelemetry: () => this.sdkController.getCurrentTelemetry(),
    getSessionInfo: () => this.sdkController.getSessionInfo(),
    getReplayState: (nowMs) => this.sdkController.getReplayState(nowMs),
    isStoreInitialized: () => isReplaySessionStoreInitialized(),
    getStore: () => getReplaySessionStore(),
  };

  /** The dial half of the action (#1230); every dial event routes here. */
  private readonly dialSurface = new ReplayMarkersDialSurface({
    logger: this.logger,
    readReplayContext: () => this.readReplayContext(),
    readTelemetry: () => this.sdkController.getCurrentTelemetry(),
  });

  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayMarkersSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const contextId = ev.action.id;
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.willAppear(ev.action, settings.dial);
      // The dial's screen follows the replay as it plays and the marker list as
      // any key or dial edits it; a tick only compares, and renders on a change.
      this.sdkController.subscribe(contextId, () => this.dialSurface.onTick(contextId));

      return;
    }

    this.activeContexts.set(contextId, settings);
    // Before the first draw: an unregistered key reads rest, and a key coming
    // back while its jump still stands shows the look at once.
    this.syncBusyRegistration(contextId, settings.mode);
    await this.updateDisplay(ev, settings);
    // Next / Previous follow the replay as it plays and the marker list as any
    // key edits it; a tick only compares, and renders on a flip.
    this.sdkController.subscribe(contextId, () => this.refreshAvailability(contextId));
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ReplayMarkersSettings>): Promise<void> {
    const contextId = ev.action.id;
    this.imageThrottle.clear(contextId);
    this.sdkController.unsubscribe(contextId);
    this.dialSurface.willDisappear(contextId);
    this.cancelFlash(contextId);
    this.activeContexts.delete(contextId);
    this.shownAvailable.delete(contextId);
    this.busyRegistrations.get(contextId)?.();
    this.busyRegistrations.delete(contextId);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayMarkersSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.activeContexts.set(ev.action.id, settings);
    this.cancelFlash(ev.action.id);
    this.syncBusyRegistration(ev.action.id, settings.mode);
    await this.updateDisplay(ev, settings);
  }

  /**
   * Registers a Next / Previous key with the replay busy indicator, replacing
   * any registration it had, or unregisters a key whose mode no longer jumps.
   * The jump is the key's own command, so it draws working. The new
   * registration goes in before the old one is dropped, so a look standing for
   * the token carries over.
   */
  private syncBusyRegistration(contextId: string, mode: ReplayMarkersMode): void {
    const previous = this.busyRegistrations.get(contextId);

    if (isJumpMode(mode)) {
      this.busyRegistrations.set(
        contextId,
        registerReplayBusySurface({
          token: contextId,
          drawsWorking: true,
          redraw: () => this.redrawBusyKey(contextId),
        }),
      );
    } else {
      this.busyRegistrations.delete(contextId);
    }

    previous?.();
  }

  /**
   * The replay busy indicator's redraw (#1437), through the same throttle as
   * the availability redraw, so the two together stay within ten images a
   * second and the newest render wins. Eight frames a second are 125 ms
   * apart, outside the throttle's 100 ms window, so no frame is dropped; a
   * look that ends inside the window is drawn at the window's end. The render
   * reads the look when it runs, not the one it was scheduled for.
   */
  private redrawBusyKey(contextId: string): void {
    this.imageThrottle.schedule(contextId, async () => {
      const settings = this.activeContexts.get(contextId);

      if (!settings) return;

      await this.updateKeyImage(contextId, this.keySvg(contextId, settings));
    });
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplayMarkersSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.logger.info(`Key down: ${settings.mode}`);

    const confirmation = this.execute(settings, ev.action.id);

    if (confirmation) this.flash(ev.action.id, settings, confirmation);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayMarkersSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ReplayMarkersSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<ReplayMarkersSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<ReplayMarkersSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): ReplayMarkersSettings {
    return parseReplayMarkersSettings(settings);
  }

  private readReplayContext(): ReplayContextResult {
    return readReplayContext(this.contextSource);
  }

  /**
   * Run the mode. Returns the confirmation to flash for an Add or Delete that
   * changed the store, and undefined for everything else — a press that does
   * nothing shows nothing. A Next / Previous jump is started here and finishes
   * on its own ({@link followMarkerJump}): the press does not wait for the landing.
   */
  private execute(settings: ReplayMarkersSettings, contextId: string): ReplayMarkerConfirmation | undefined {
    const context = this.readReplayContext();

    if (!context.ok) {
      this.logger.debug(`${context.reason}; ignoring`);

      return undefined;
    }

    switch (settings.mode) {
      case "add": {
        const { marker, added } = addMarkerAt(context, settings.secondsBack);
        this.logger.info(added ? "Marker added" : "Marker not added");
        this.logger.debug(`frame=${marker.frame} current=${context.frame} secondsBack=${settings.secondsBack}`);

        return added ? "added" : undefined;
      }
      case "delete": {
        const removed = deleteMarkerAt(context);
        this.logger.info(removed ? "Marker deleted" : "No marker near the current frame");
        this.logger.debug(`current=${context.frame} removed=${removed?.frame ?? "none"}`);

        return removed ? "deleted" : undefined;
      }
      case "next":
      case "previous": {
        if (!context.inReplay) {
          this.logger.debug(
            `${settings.mode}: replay not playing, and iRacing ignores replay commands from the car; open the replay first`,
          );

          return undefined;
        }

        // From the replay's pending target while the replay has not reached it
        // (#1230, #1430), so a press right after a turn or another press steps on.
        const anchor = resolveMarkerJumpAnchor(context.frame, context.telemetry);
        const target = resolveJumpTarget(settings.mode, context, anchor);

        if (!target) {
          this.logger.info(`No ${settings.mode} marker`);
          this.logger.debug(`current=${context.frame} anchor=${anchor}`);

          return undefined;
        }

        // Takes the replay cursor (#1203) and records the target before it
        // returns; a paused replay has its seek by then too. The rest — the
        // landing, and the speed the setting asks for — follows the press.
        const jump = jumpToMarkerFrame(
          settings.mode,
          target.frame,
          () => this.sdkController.getCurrentTelemetry(),
          Date.now(),
          contextId,
        );
        this.logger.info(`Jumped to ${settings.mode} marker`);
        this.logger.debug(`current=${context.frame}, anchor=${anchor}, target=${target.frame}`);
        followMarkerJump(this.logger, `${settings.mode} marker`, target.frame, jump);

        return undefined;
      }
    }
  }

  /**
   * Whether a Next / Previous press would jump now — the one predicate the
   * press and the dial's turn and side marks apply ({@link resolveJumpTarget}),
   * read fresh: connected, a store and a frame, a replay on screen, and a
   * marker outside the mode's window in that direction, measured from where a
   * press would measure (the shared pending landing, #1230).
   */
  private isJumpAvailable(mode: ReplayMarkersJumpMode): boolean {
    const context = this.readReplayContext();

    return (
      context.ok && resolveJumpTarget(mode, context, resolveMarkerJumpAnchor(context.frame, context.telemetry)) !== null
    );
  }

  /**
   * The icon a context shows now, computed fresh: the replay busy look while
   * the indicator reports one (#1437), else {@link restingSvg}. A busy key
   * records no availability, since none is on the key; the redraw at the end
   * of the look records it.
   */
  private keySvg(contextId: string, settings: ReplayMarkersSettings): string {
    const busy = replayBusyKeyMark(getReplayBusyLook(contextId));

    if (busy) return generateReplayMarkersSvg(settings, undefined, busy);

    return this.restingSvg(contextId, settings);
  }

  /**
   * The icon a context shows at rest, computed fresh. For Next / Previous it
   * also records which look went out, so a tick renders only on a flip.
   */
  private restingSvg(contextId: string, settings: ReplayMarkersSettings): string {
    if (!isJumpMode(settings.mode)) {
      this.shownAvailable.delete(contextId);

      return generateReplayMarkersSvg(settings);
    }

    const available = this.isJumpAvailable(settings.mode);
    this.shownAvailable.set(contextId, available);

    return generateReplayMarkersSvg(settings, available ? undefined : "unavailable");
  }

  /**
   * Per tick: re-read a Next / Previous key's availability and redraw it, at
   * most 10 Hz, only when it differs from what the key shows. A key in its
   * confirmation flash is left alone; the flash's own end redraws it.
   */
  private refreshAvailability(contextId: string): void {
    if (!this.needsRedraw(contextId)) return;

    this.imageThrottle.schedule(contextId, async () => {
      // Re-checked at flush time: the state may have flipped back, or the key
      // changed mode, went away or started a flash since the tick.
      if (!this.needsRedraw(contextId)) return;

      const settings = this.activeContexts.get(contextId);

      if (settings) await this.updateKeyImage(contextId, this.keySvg(contextId, settings));
    });
  }

  /**
   * Whether a tick must redraw the key: a Next / Previous key whose
   * availability differs from what it shows. Never while a flash runs, nor
   * while the replay busy look stands (#1437): the key shows no availability
   * then, and the indicator's redraw at the end of the look draws it fresh.
   */
  private needsRedraw(contextId: string): boolean {
    const settings = this.activeContexts.get(contextId);

    if (!settings || !isJumpMode(settings.mode) || this.flashTimers.has(contextId)) return false;

    if (getReplayBusyLook(contextId).kind !== "rest") return false;

    return this.shownAvailable.get(contextId) !== this.isJumpAvailable(settings.mode);
  }

  private flash(contextId: string, settings: ReplayMarkersSettings, confirmation: ReplayMarkerConfirmation): void {
    this.cancelFlash(contextId);
    void this.updateKeyImage(contextId, generateReplayMarkersSvg(settings, confirmation));

    const timer = setTimeout(() => {
      this.flashTimers.delete(contextId);
      const current = this.activeContexts.get(contextId);

      if (current) void this.updateKeyImage(contextId, this.keySvg(contextId, current));
    }, CONFIRMATION_FLASH_MS);

    this.flashTimers.set(contextId, timer);
  }

  private cancelFlash(contextId: string): void {
    const timer = this.flashTimers.get(contextId);

    if (timer) {
      clearTimeout(timer);
      this.flashTimers.delete(contextId);
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayMarkersSettings> | IDeckDidReceiveSettingsEvent<ReplayMarkersSettings>,
    settings: ReplayMarkersSettings,
  ): Promise<void> {
    const contextId = ev.action.id;
    await ev.action.setTitle("");
    await this.setKeyImage(ev, this.keySvg(contextId, settings));
    this.setRegenerateCallback(contextId, () => this.keySvg(contextId, this.activeContexts.get(contextId) ?? settings));
  }
}
