/**
 * Phase 9 (#1349; 8 until #1467): window focus and the mouse pointer, the
 * Always-mode focus listeners, the replay busy indicator's logger, then every
 * action — the shared list, then the host's extras.
 */
import { focusIRacingIfEnabled, initMousePointer, initWindowFocus } from "@iracedeck/deck-core";
import { hasElevationMismatch, isIRacingActive } from "@iracedeck/deck-iracing";

import { setReplayBusyIndicatorLogger, SHARED_ACTIONS } from "../actions.js";
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

  // The Always-mode focus site (#977): before every key press, dial press and dial
  // rotation. Under When required the focus happens inside the keystroke paths
  // instead (keyboard service, chat send) — the gate lives in the service, so
  // these registrations are the same in every mode.
  // MUST be registered BEFORE actions so the listener fires first in the EventEmitter chain.
  adapter.onKeyDown(() => focusIRacingIfEnabled());
  adapter.onDialDown(() => focusIRacingIfEnabled());
  adapter.onDialRotate(() => focusIRacingIfEnabled());

  // The replay busy indicator (#1437) has no registration entry point of its
  // own; its lines (a look started or ended, a spinner stopped at its ceiling)
  // go to a scope set here, once, before the replay actions are constructed (#1467).
  setReplayBusyIndicatorLogger(adapter.createLogger("ReplayBusy"));

  // The shared list, then what only this host has (#1349). Registration order
  // across distinct UUIDs is not observable; each handler is keyed by its UUID.
  for (const action of [...SHARED_ACTIONS, ...(core.host.extension?.extraActions ?? [])]) {
    adapter.registerAction(action.uuid, action.create(adapter.createLogger(action.scope)));
  }
}
