/**
 * Phase 10 (#1349; 8 until #1467, 9 until #1112): window focus and the mouse
 * pointer, the replay busy indicator's logger, the press sound player, then
 * every action — the shared list, then the host's extras — each wrapped for
 * its press sounds and, around that, its per-key window focus (#1654), so the
 * focus comes before the press sounds stamp the press.
 */
import {
  initMousePointer,
  initPressSounds,
  initWindowFocus,
  withPressSounds,
  withWindowFocus,
} from "@iracedeck/deck-core";
import { hasElevationMismatch, isIRacingActive } from "@iracedeck/deck-iracing";

import { playPressSound, setReplayBusyIndicatorLogger, SHARED_ACTIONS } from "../actions.js";
import type { Core, Input } from "../types.js";

export function registerActions(core: Core, input: Input): void {
  const { adapter } = core;
  const { native } = input;

  // Initialize window focus service for focusing iRacing before any action. The
  // app monitor's isIRacingActive is injected rather than imported inside
  // deck-core, which would close an import cycle through the SDK singleton (#1176),
  // and the elevation check is injected for the same reason (#1351).
  initWindowFocus(
    adapter.createLogger("WindowFocus"),
    () => native.focusIRacingWindow(),
    isIRacingActive,
    hasElevationMismatch,
  );

  // Initialize the mouse pointer service for the Mouse to Sim mode (#926)
  initMousePointer(adapter.createLogger("MousePointer"), (x, y) => native.moveMouseToIRacingWindow(x, y));

  // The replay busy indicator (#1437) has no registration entry point of its
  // own; its lines (a look started or ended, a spinner stopped at its ceiling)
  // go to a scope set here, once, before the replay actions are constructed (#1467).
  setReplayBusyIndicatorLogger(adapter.createLogger("ReplayBusy"));

  // Press sounds (#269): deck-core's wrapper decides when a press plays the tap
  // or the long sound and reads the mode and the sim connection itself; it
  // plays through the player installed here, the clips and the Feedback channel that live
  // with the audio code in iracing-actions. Installed once, before the first
  // action registers, so no press can reach a wrapper without a player.
  initPressSounds({ play: playPressSound, logger: adapter.createLogger("PressSounds") });

  // The shared list, then what only this host has (#1349). Registration order
  // across distinct UUIDs is not observable; each handler is keyed by its UUID.
  // Every handler is registered wrapped, the extras too, so all three plugins
  // get both behaviours from this one line and no action implements either
  // itself. `withWindowFocus` (#1654) does what the adapter-level focus
  // listeners did before it, but per key: at a key press, dial press and dial
  // rotation it focuses iRacing as the key's own `windowFocus` setting says
  // (the global mode for a key left at "Use global setting"), before the
  // handler runs, and it runs every press inside that setting's scope, so the
  // keystrokes the press sends are focused the same way. It sits outside
  // `withPressSounds`: the focus can block for up to a second on a timeout, and
  // `withPressSounds` stamps the press's start and arms its long-press timer
  // before it calls the handler, so a focus inside it would count against the
  // dial long-press threshold (500 ms) and turn a tap into a long press. Out
  // here the focus comes first, the press sounds start once it has returned,
  // and the down sound still plays after the focus. Both wrappers expose only
  // `IDeckActionHandler`'s members, which are all an adapter calls.
  for (const action of [...SHARED_ACTIONS, ...(core.host.extension?.extraActions ?? [])]) {
    adapter.registerAction(
      action.uuid,
      withWindowFocus(withPressSounds(action.create(adapter.createLogger(action.scope)))),
    );
  }
}
