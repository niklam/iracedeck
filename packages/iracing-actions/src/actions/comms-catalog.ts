/**
 * Per-mode sim-communication catalog (issue #612) — authoritative source.
 *
 * Maps every (action, mode) to how it talks to iRacing: the iRacing API, a key
 * binding (keyboard OR SimHub, possibly resolved from a secondary setting), or
 * a chat command. The PI binding-status line and the docs read the GENERATED
 * `data/action-comms.json`; regenerate it with `pnpm generate:action-comms`
 * after editing this file (a freshness test guards the two staying in sync).
 *
 * Classification is the code-verified audit in
 * `docs/superpowers/specs/2026-05-31-comms-method-audit.md`.
 *
 * Each action entry also records `modeSetting` — the name of the action setting
 * whose value selects the mode — so the PI knows which setting to watch. It is
 * emitted under the reserved `_meta` key inside each action's map.
 *
 * Display-only / internal actions (session-info, telemetry-display, pit-crew,
 * camera-cycle) are intentionally absent: they issue no iRacing command, so they
 * get no status line and no icon warning. Camera Controls carries BOTH surfaces
 * (`camera-focus` keypad, `camera-focus-dial`): almost every camera mode is an
 * SDK command, but Cycle Sub-Camera is a key binding — iRacing's camera switch
 * broadcasts act on the focus and the group only, their `camera` argument never
 * selects a sub-camera, so the sim's own Next / Previous Sub Camera bindings
 * are the only working mechanism (issue #852).
 */
import {
  type ActionCommMap,
  type CommDescriptor,
  keybind,
  keybindBy,
  keybindFixed,
  keybindKeys,
} from "@iracedeck/deck-core";

import { BLACK_BOX_GLOBAL_KEYS } from "../shared/black-box.js";
import { SPOTTER_GLOBAL_KEYS } from "../shared/spotter-bindings.js";
import {
  dialMuteBindingMap,
  type KeybindDialCategory,
  rotationBindingKeys,
} from "./audio-controls/audio-controls-settings.js";
import { SUB_CAMERA_BINDING_KEYS } from "./camera-controls/sub-camera-bindings.js";

const api: CommDescriptor = { method: "api" };
const chat: CommDescriptor = { method: "chat" };

/** Build a `{ mode: <descriptor> }` map for a list of same-method modes. */
function allApi(modes: string[]): ActionCommMap {
  return Object.fromEntries(modes.map((m) => [m, api]));
}
function allChat(modes: string[]): ActionCommMap {
  return Object.fromEntries(modes.map((m) => [m, chat]));
}

/** Per-action metadata carried alongside the mode map. */
export interface ActionCommMeta {
  /** Name of the action setting whose value selects the mode. */
  modeSetting: string;
}

/** An action's mode map plus its `_meta`. The PI reads both from the JSON. */
export type ActionCommEntry = ActionCommMap & { _meta: ActionCommMeta };

function entry(modeSetting: string, modes: ActionCommMap): ActionCommEntry {
  return { _meta: { modeSetting }, ...modes };
}

/** Directional keybind mode whose key is chosen by the `direction` secondary setting. */
function dir(increase: string, decrease: string): CommDescriptor {
  return keybindBy("direction", { increase, decrease });
}

/**
 * Setup `view-*` mode: nudges-and-reads via the adjustment's increase AND
 * decrease keys (both required — warn if either is unset).
 */
function pair(increase: string, decrease: string): CommDescriptor {
  return keybindKeys([increase, decrease]);
}

/**
 * The Audio Controls dial's rotation descriptor for a keybind category, taken
 * from the settings module's own binding table (the surface dispatches from
 * that table, so the PI status line can't describe a different key).
 */
function dialRotation(category: KeybindDialCategory): CommDescriptor {
  return keybindKeys(rotationBindingKeys(category));
}

export const COMMS_CATALOG: Record<string, ActionCommEntry> = {
  // One entry for BOTH Fuel Service surfaces (#759): the keypad modes (keyed by
  // the `mode` setting) and the dial gesture-slot values (the dial PI passes its
  // own mode-setting per slot, e.g. `dial.pressAction`) share one map — the keys
  // don't collide. All fuel-value modes are `api` since the chat→SDK switch.
  "fuel-service": entry("mode", {
    "toggle-fuel-fill": api,
    "add-fuel": api,
    "reduce-fuel": api,
    "set-fuel-amount": api,
    "clear-fuel": api,
    "toggle-autofuel": keybind("fuelServiceToggleAutofuel"),
    "lap-margin-increase": keybind("fuelServiceLapMarginIncrease"),
    "lap-margin-decrease": keybind("fuelServiceLapMarginDecrease"),
    // Dial gesture-slot values. "switch-mode" and "none" intentionally omitted —
    // they issue no iRacing command, so the binding-status line renders nothing
    // for them.
    "toggle-fueling": api,
    "fill-to-max": api,
    "toggle-autofuel-mode": keybind("fuelServiceToggleAutofuel"),
  }),

  "tire-service": entry("mode", {
    "change-all-tires": chat,
    "clear-tires": api,
    "change-compound": api,
    "toggle-tires": chat,
  }),

  "black-box-selector": entry("mode", {
    direct: keybindBy("blackBox", BLACK_BOX_GLOBAL_KEYS),
    next: keybind("blackBoxCycleNext"),
    previous: keybind("blackBoxCyclePrevious"),
  }),

  // The dial surface of Black Box Selector (#808). Rotation always cycles — there
  // is no rotation-setting selector — so it is a single fixed mode the PI selects
  // via `default-mode="cycle"` (there is no `dial.rotation` control to read;
  // `_meta.modeSetting` names a setting that never exists in the DOM). The
  // "cycle" descriptor is the next/previous key PAIR (warn if either is unset).
  // The press gesture `open-selected-box` opens the box chosen by `dial.pressBox`,
  // reusing the keypad Direct mode's per-box keys via the keyBy descriptor (the
  // audio-controls `mute-unmute` pattern). Every dial path is keybind-backed —
  // black-box selection has no SDK support. A separate entry from the keypad map:
  // the keypad `next`/`previous` are single keys, the dial rotation needs both.
  "black-box-selector-dial": entry("dial.rotation", {
    cycle: pair("blackBoxCycleNext", "blackBoxCyclePrevious"),
    "open-selected-box": keybindBy("dial.pressBox", BLACK_BOX_GLOBAL_KEYS),
  }),

  "splits-delta-cycle": entry("mode", {
    cycle: keybindBy("direction", { next: "splitsDeltaNext", previous: "splitsDeltaPrevious" }),
    "toggle-ref-car": keybind("toggleUiDisplayRefCar"),
    "custom-sector-start": keybind("splitsDeltaCustomSectorStart"),
    "custom-sector-end": keybind("splitsDeltaCustomSectorEnd"),
    "active-reset-set": keybind("splitsDeltaActiveResetSet"),
    "active-reset-run": keybind("splitsDeltaActiveResetRun"),
  }),

  // The dial surface of Splits & Reference (#807) — the smallest of the batch: a
  // single rotation behavior (cycle) and no `dial.setting` select. Rotation taps
  // BOTH the Next and Previous bindings (either unset → warn); the press / touch
  // gesture slots offer every one-shot mode the keypad map above has (#807
  // follow-up). Separate from the keypad map because the dial has no
  // `direction` setting — rotation needs the pair, while the keypad `cycle`
  // mode resolves one key via `direction`. `_meta.modeSetting` names the
  // (control-less) rotation slot, so the PI's rotation status line falls back to
  // its `default-mode="cycle"`; the gesture lines read `dial.pressAction` etc.
  "splits-delta-cycle-dial": entry("dial.rotation", {
    cycle: pair("splitsDeltaNext", "splitsDeltaPrevious"),
    "toggle-ref-car": keybind("toggleUiDisplayRefCar"),
    "custom-sector-start": keybind("splitsDeltaCustomSectorStart"),
    "custom-sector-end": keybind("splitsDeltaCustomSectorEnd"),
    "active-reset-set": keybind("splitsDeltaActiveResetSet"),
    "active-reset-run": keybind("splitsDeltaActiveResetRun"),
  }),

  "look-direction": entry("direction", {
    "look-left": keybind("lookDirectionLeft"),
    "look-right": keybind("lookDirectionRight"),
    "look-up": keybind("lookDirectionUp"),
    "look-down": keybind("lookDirectionDown"),
  }),

  "car-control": entry("control", {
    "pit-speed-limiter": keybind("carControlPitSpeedLimiter"),
    "push-to-pass": keybind("carControlPushToPass"),
    drs: keybind("carControlDrs"),
    "headlight-flash": keybind("carControlHeadlightFlash"),
    "tear-off-visor": keybind("carControlTearOffVisor"),
    ignition: keybind("carControlIgnition"),
    starter: keybind("carControlStarter"),
    "enter-exit-tow": keybind("carControlEnterExitTow"),
    "pause-sim": keybind("carControlPauseSim"),
    handbrake: keybind("carControlHandbrake"),
    "second-clutch": keybind("carControlSecondClutch"),
    "second-up-shift": keybind("carControlSecondUpShift"),
    "second-down-shift": keybind("carControlSecondDownShift"),
    // Hardcoded Escape — no user binding.
    escape: keybindFixed(),
  }),

  // `mouse-to-sim` is intentionally absent from BOTH View Adjustment maps (#926):
  // it is a native Windows window/pointer call, not an iRacing command, so it has
  // no binding and the status line renders nothing for it (the Telemetry Control
  // `snapshot` precedent). The same value is also a dial gesture-slot option.
  "view-adjustment": entry("adjustment", {
    fov: keybindBy("direction", { increase: "viewAdjustFovIncrease", decrease: "viewAdjustFovDecrease" }),
    horizon: keybindBy("direction", { increase: "viewAdjustHorizonUp", decrease: "viewAdjustHorizonDown" }),
    "driver-height": keybindBy("direction", {
      increase: "viewAdjustDriverHeightUp",
      decrease: "viewAdjustDriverHeightDown",
    }),
    "recenter-vr": keybind("viewAdjustRecenterVr"),
    "ui-size": keybindBy("direction", { increase: "viewAdjustUiSizeIncrease", decrease: "viewAdjustUiSizeDecrease" }),
  }),

  // The dial surface of View Adjustment (#806). Separate from the keypad map:
  // the same setting names carry different descriptors per surface (keypad
  // `fov` is direction-keyed via `keybindBy`, dial rotation requires BOTH keys
  // via `pair` since the dial has no `direction` setting). Recenter VR is not a
  // rotation mode here — it is the default press gesture (`recenter-vr`), a
  // single keybind. iRacing exposes no telemetry for any of these, so the strip
  // is label-only; every setting still needs both increase and decrease bound.
  "view-adjustment-dial": entry("dial.setting", {
    fov: pair("viewAdjustFovIncrease", "viewAdjustFovDecrease"),
    horizon: pair("viewAdjustHorizonUp", "viewAdjustHorizonDown"),
    "driver-height": pair("viewAdjustDriverHeightUp", "viewAdjustDriverHeightDown"),
    "ui-size": pair("viewAdjustUiSizeIncrease", "viewAdjustUiSizeDecrease"),
    "recenter-vr": keybind("viewAdjustRecenterVr"),
  }),

  "camera-editor-adjustments": entry("adjustment", {
    latitude: dir("camEditLatitudeIncrease", "camEditLatitudeDecrease"),
    longitude: dir("camEditLongitudeIncrease", "camEditLongitudeDecrease"),
    altitude: dir("camEditAltitudeIncrease", "camEditAltitudeDecrease"),
    yaw: dir("camEditYawIncrease", "camEditYawDecrease"),
    pitch: dir("camEditPitchIncrease", "camEditPitchDecrease"),
    "fov-zoom": dir("camEditFovZoomIncrease", "camEditFovZoomDecrease"),
    "key-step": dir("camEditKeyStepIncrease", "camEditKeyStepDecrease"),
    "vanish-x": dir("camEditVanishXIncrease", "camEditVanishXDecrease"),
    "vanish-y": dir("camEditVanishYIncrease", "camEditVanishYDecrease"),
    "blimp-radius": dir("camEditBlimpRadiusIncrease", "camEditBlimpRadiusDecrease"),
    "blimp-velocity": dir("camEditBlimpVelocityIncrease", "camEditBlimpVelocityDecrease"),
    "mic-gain": dir("camEditMicGainIncrease", "camEditMicGainDecrease"),
    // Both directions trigger the same key — a single fixed binding.
    "auto-set-mic-gain": keybind("camEditAutoSetMicGain"),
    "f-number": dir("camEditFNumberIncrease", "camEditFNumberDecrease"),
    "focus-depth": dir("camEditFocusDepthIncrease", "camEditFocusDepthDecrease"),
  }),

  // The dial surface of Camera Editor Adjustments (#804). Rotation steps one of
  // the 14 camera-tool parameters via BOTH increase/decrease keys (warn if
  // either is unset). Auto Set Mic Gain is not a rotation value — it is offered
  // only as a press gesture, a single fixed binding. Separate from the keypad
  // map: rotation has no `direction` setting, so each value needs the pair.
  "camera-editor-adjustments-dial": entry("dial.setting", {
    latitude: pair("camEditLatitudeIncrease", "camEditLatitudeDecrease"),
    longitude: pair("camEditLongitudeIncrease", "camEditLongitudeDecrease"),
    altitude: pair("camEditAltitudeIncrease", "camEditAltitudeDecrease"),
    yaw: pair("camEditYawIncrease", "camEditYawDecrease"),
    pitch: pair("camEditPitchIncrease", "camEditPitchDecrease"),
    "fov-zoom": pair("camEditFovZoomIncrease", "camEditFovZoomDecrease"),
    "f-number": pair("camEditFNumberIncrease", "camEditFNumberDecrease"),
    "focus-depth": pair("camEditFocusDepthIncrease", "camEditFocusDepthDecrease"),
    "vanish-x": pair("camEditVanishXIncrease", "camEditVanishXDecrease"),
    "vanish-y": pair("camEditVanishYIncrease", "camEditVanishYDecrease"),
    "blimp-radius": pair("camEditBlimpRadiusIncrease", "camEditBlimpRadiusDecrease"),
    "blimp-velocity": pair("camEditBlimpVelocityIncrease", "camEditBlimpVelocityDecrease"),
    "key-step": pair("camEditKeyStepIncrease", "camEditKeyStepDecrease"),
    "mic-gain": pair("camEditMicGainIncrease", "camEditMicGainDecrease"),
    // Press/touch gesture values (dial.pressAction/longPressAction/tapAction/
    // longTouchAction all share this map). Auto Set Mic Gain taps the
    // camera-editor's own fixed binding; the camera-tool one-shots reuse Camera
    // Editor Controls' camCtrl* keys verbatim (#804) — cross-action binding
    // reuse, keys shared plugin-wide (precedent: cockpit-misc ffb-max-force).
    "auto-mic-gain": keybind("camEditAutoSetMicGain"),
    "open-camera-tool": keybind("camCtrlOpenCameraTool"),
    "key-acceleration-toggle": keybind("camCtrlKeyAccelerationToggle"),
    "key-10x-toggle": keybind("camCtrlKey10xToggle"),
    "parabolic-mic-toggle": keybind("camCtrlParabolicMicToggle"),
    "cycle-position-type": keybind("camCtrlCyclePositionType"),
    "cycle-aim-type": keybind("camCtrlCycleAimType"),
    "acquire-start": keybind("camCtrlAcquireStart"),
    "acquire-end": keybind("camCtrlAcquireEnd"),
    "temporary-edits-toggle": keybind("camCtrlTemporaryEditsToggle"),
    "dampening-toggle": keybind("camCtrlDampeningToggle"),
    "zoom-toggle": keybind("camCtrlZoomToggle"),
    "beyond-fence-toggle": keybind("camCtrlBeyondFenceToggle"),
    "in-cockpit-toggle": keybind("camCtrlInCockpitToggle"),
    "mouse-navigation-toggle": keybind("camCtrlMouseNavigationToggle"),
    "pitch-gyro-toggle": keybind("camCtrlPitchGyroToggle"),
    "roll-gyro-toggle": keybind("camCtrlRollGyroToggle"),
    "limit-shot-range-toggle": keybind("camCtrlLimitShotRangeToggle"),
    "show-camera-toggle": keybind("camCtrlShowCameraToggle"),
    "shot-selection-toggle": keybind("camCtrlShotSelectionToggle"),
    "manual-focus-toggle": keybind("camCtrlManualFocusToggle"),
    "insert-camera": keybind("camCtrlInsertCamera"),
    "remove-camera": keybind("camCtrlRemoveCamera"),
    "copy-camera": keybind("camCtrlCopyCamera"),
    "paste-camera": keybind("camCtrlPasteCamera"),
    "copy-group": keybind("camCtrlCopyGroup"),
    "paste-group": keybind("camCtrlPasteGroup"),
    "save-track-camera": keybind("camCtrlSaveTrackCamera"),
    "load-track-camera": keybind("camCtrlLoadTrackCamera"),
    "save-car-camera": keybind("camCtrlSaveCarCamera"),
    "load-car-camera": keybind("camCtrlLoadCarCamera"),
  }),

  "camera-editor-controls": entry("control", {
    "open-camera-tool": keybind("camCtrlOpenCameraTool"),
    "key-acceleration-toggle": keybind("camCtrlKeyAccelerationToggle"),
    "key-10x-toggle": keybind("camCtrlKey10xToggle"),
    "parabolic-mic-toggle": keybind("camCtrlParabolicMicToggle"),
    "cycle-position-type": keybind("camCtrlCyclePositionType"),
    "cycle-aim-type": keybind("camCtrlCycleAimType"),
    "acquire-start": keybind("camCtrlAcquireStart"),
    "acquire-end": keybind("camCtrlAcquireEnd"),
    "temporary-edits-toggle": keybind("camCtrlTemporaryEditsToggle"),
    "dampening-toggle": keybind("camCtrlDampeningToggle"),
    "zoom-toggle": keybind("camCtrlZoomToggle"),
    "beyond-fence-toggle": keybind("camCtrlBeyondFenceToggle"),
    "in-cockpit-toggle": keybind("camCtrlInCockpitToggle"),
    "mouse-navigation-toggle": keybind("camCtrlMouseNavigationToggle"),
    "pitch-gyro-toggle": keybind("camCtrlPitchGyroToggle"),
    "roll-gyro-toggle": keybind("camCtrlRollGyroToggle"),
    "limit-shot-range-toggle": keybind("camCtrlLimitShotRangeToggle"),
    "show-camera-toggle": keybind("camCtrlShowCameraToggle"),
    "shot-selection-toggle": keybind("camCtrlShotSelectionToggle"),
    "manual-focus-toggle": keybind("camCtrlManualFocusToggle"),
    "insert-camera": keybind("camCtrlInsertCamera"),
    "remove-camera": keybind("camCtrlRemoveCamera"),
    "copy-camera": keybind("camCtrlCopyCamera"),
    "paste-camera": keybind("camCtrlPasteCamera"),
    "copy-group": keybind("camCtrlCopyGroup"),
    "paste-group": keybind("camCtrlPasteGroup"),
    "save-track-camera": keybind("camCtrlSaveTrackCamera"),
    "load-track-camera": keybind("camCtrlLoadTrackCamera"),
    "save-car-camera": keybind("camCtrlSaveCarCamera"),
    "load-car-camera": keybind("camCtrlLoadCarCamera"),
  }),

  // Camera Controls' KEYPAD surface. Every mode is an SDK camera broadcast
  // (`getCommands().camera.*`) except Cycle Sub-Camera, which taps iRacing's
  // own Next / Previous Sub Camera bindings (#852) — see the header note.
  // `focus-select-car` opens a Stream Deck profile rather than talking to
  // iRacing, so it is deliberately absent (nothing to report).
  "camera-focus": entry("target", {
    "change-camera": api,
    "cycle-camera": api,
    "cycle-sub-camera": keybindBy("direction", {
      next: SUB_CAMERA_BINDING_KEYS.next,
      previous: SUB_CAMERA_BINDING_KEYS.previous,
    }),
    "cycle-car": api,
    "cycle-track-order": api,
    "cycle-driving": api,
    "focus-your-car": api,
    "focus-on-leader": api,
    "focus-on-incident": api,
    "focus-on-most-exciting": api,
    "switch-by-position": api,
    "switch-by-car-number": api,
    "set-camera-state": api,
  }),

  // The dial surface of Camera Controls (#803). Rotation cycles the camera or
  // the focused car and the press gestures center on the player's car / switch
  // camera — all iRacing SDK camera commands (`getCommands().camera.*`) except
  // Sub-Camera rotation, which taps iRacing's sub-camera bindings (#852). The
  // dial reuses the keypad's own cycle/focus dispatch, so both surfaces share
  // one mechanism per mode. _meta.modeSetting = "dial.mode".
  "camera-focus-dial": entry("dial.mode", {
    camera: api,
    // Rotation taps BOTH sub-camera bindings depending on direction (#852), so
    // either one unset warns — the `pair` form the other cycle dials use.
    "sub-camera": pair(SUB_CAMERA_BINDING_KEYS.next, SUB_CAMERA_BINDING_KEYS.previous),
    "car-number": api,
    "race-position": api,
    "track-order": api,
    driving: api,
    // Gesture-slot values (dial.pressAction / .longPressAction / .tapAction /
    // .longTouchAction) — each an SDK camera command. "none" is omitted (it
    // issues no command). Kept complete so the catalog documents every gesture.
    "focus-my-car": api,
    "change-camera": api,
    "focus-on-leader": api,
    "focus-on-incident": api,
    "focus-on-most-exciting": api,
  }),

  "cockpit-misc": entry("control", {
    "toggle-wipers": keybind("cockpitMiscToggleWipers"),
    "trigger-wipers": keybind("cockpitMiscTriggerWipers"),
    "ffb-max-force": keybindBy("direction", {
      increase: "cockpitMiscFfbForceIncrease",
      decrease: "cockpitMiscFfbForceDecrease",
    }),
    "report-latency": keybind("cockpitMiscReportLatency"),
    "dash-page-1": keybindBy("direction", {
      increase: "cockpitMiscDashPage1Increase",
      decrease: "cockpitMiscDashPage1Decrease",
    }),
    "dash-page-2": keybindBy("direction", {
      increase: "cockpitMiscDashPage2Increase",
      decrease: "cockpitMiscDashPage2Decrease",
    }),
    "in-lap-mode": keybind("cockpitMiscInLapMode"),
  }),

  // The dial surface of the Cockpit Misc action (#805). Rotation cycles a
  // dashboard page via BOTH the increase AND decrease keys (`pair` — the dial
  // has no `direction` setting, unlike the keypad map above); the press gesture
  // can run any of the keypad's one-shots (toggle/trigger wipers, in-lap mode,
  // report latency). `ffb-max-force` is intentionally absent as a rotation
  // setting (FFB rotation belongs to the Force Feedback dial).
  "cockpit-misc-dial": entry("dial.setting", {
    "dash-page-1": pair("cockpitMiscDashPage1Increase", "cockpitMiscDashPage1Decrease"),
    "dash-page-2": pair("cockpitMiscDashPage2Increase", "cockpitMiscDashPage2Decrease"),
    "toggle-wipers": keybind("cockpitMiscToggleWipers"),
    "trigger-wipers": keybind("cockpitMiscTriggerWipers"),
    "in-lap-mode": keybind("cockpitMiscInLapMode"),
    "report-latency": keybind("cockpitMiscReportLatency"),
  }),

  "force-feedback": entry("mode", {
    "auto-compute-ffb-force": keybind("forceFeedbackAutoCompute"),
    "ffb-force": keybindBy("direction", {
      increase: "cockpitMiscFfbForceIncrease",
      decrease: "cockpitMiscFfbForceDecrease",
    }),
    "wheel-lfe": keybindBy("direction", {
      increase: "forceFeedbackWheelLfeLouder",
      decrease: "forceFeedbackWheelLfeQuieter",
    }),
    "bass-shaker-lfe": keybindBy("direction", {
      increase: "forceFeedbackBassShakerLfeLouder",
      decrease: "forceFeedbackBassShakerLfeQuieter",
    }),
  }),

  // The dial surface of the Force Feedback action (#802). Rotation is keyed by
  // `dial.setting` (BOTH the increase and decrease keys required); the Auto FFB
  // press gesture taps the shared auto-compute binding. A separate entry from
  // the keypad map because the same setting values need different descriptors
  // per surface (keypad resolves one key via `direction`, dial rotation needs
  // the pair). FFB Force reuses the Cockpit Misc keys (#827). `auto-compute-ffb-force`
  // is keypad-only (no rotation), so it is absent here.
  "force-feedback-dial": entry("dial.setting", {
    "ffb-force": pair("cockpitMiscFfbForceIncrease", "cockpitMiscFfbForceDecrease"),
    "wheel-lfe": pair("forceFeedbackWheelLfeLouder", "forceFeedbackWheelLfeQuieter"),
    "bass-shaker-lfe": pair("forceFeedbackBassShakerLfeLouder", "forceFeedbackBassShakerLfeQuieter"),
    "auto-ffb": keybind("forceFeedbackAutoCompute"),
  }),

  chat: entry("mode", {
    "open-chat": api,
    reply: api,
    cancel: api,
    "send-message": api,
    macro: api,
    whisper: keybind("chatWhisper"),
    toggle: keybind("chatToggle"),
  }),

  "audio-controls": entry("category", {
    "push-to-talk": keybind("audioControlsPushToTalk"),
    "voice-chat": keybindBy("action", {
      "volume-up": "audioVoiceChatVolumeUp",
      "volume-down": "audioVoiceChatVolumeDown",
      mute: "audioVoiceChatMute",
    }),
    master: keybindBy("action", {
      "volume-up": "audioMasterVolumeUp",
      "volume-down": "audioMasterVolumeDown",
    }),
    // Plugin audio, not iRacing — no binding.
    "race-engineer": keybindFixed(),
    radar: keybindFixed(),
  }),

  // The dial surface of Audio Controls (#782): rotation is keyed by
  // `dial.category` (BOTH volume keys required for the keybind categories; the
  // internal categories drive plugin audio — no binding), press by
  // `dial.pressAction` — one shared map, the value sets don't collide (the
  // #759 shared-map pattern). A separate entry from the keypad map because
  // the same category values need different descriptors per surface (keypad
  // resolves one key via the `action` setting; dial rotation needs the pair).
  // The spotter category (#809) reuses the AI Spotter Controls bindings —
  // louder/quieter for rotation, silence for Mute / Unmute. Every keybind
  // descriptor here is DERIVED from the settings module's tables, so the PI
  // status line and the surface's dispatch can't disagree. The PI hides the
  // press status line for internal-category Mute / Unmute (plugin audio,
  // nothing to configure); "none" is omitted so its line renders nothing.
  "audio-controls-dial": entry("dial.category", {
    "voice-chat": dialRotation("voice-chat"),
    master: dialRotation("master"),
    spotter: dialRotation("spotter"),
    "race-engineer": keybindFixed(),
    radar: keybindFixed(),
    "push-to-talk": keybind("audioControlsPushToTalk"),
    "mute-unmute": keybindBy("dial.category", dialMuteBindingMap()),
  }),

  "toggle-ui-elements": entry("element", {
    "dash-box": keybind("toggleUiDashBox"),
    "speed-gear-pedals": keybind("toggleUiSpeedGearPedals"),
    "radio-display": keybind("toggleUiRadioDisplay"),
    "fps-network-display": keybind("toggleUiFpsNetworkDisplay"),
    "weather-radar": keybind("toggleUiWeatherRadar"),
    "virtual-mirror": keybind("toggleUiVirtualMirror"),
    "ui-edit-mode": keybind("toggleUiEditMode"),
    "driving-line": keybind("toggleUiDrivingLine"),
    "display-ref-car": keybind("toggleUiDisplayRefCar"),
    "replay-ui": api,
  }),

  "ai-spotter-controls": entry("control", {
    "damage-report": keybind(SPOTTER_GLOBAL_KEYS["damage-report"]),
    "weather-report": keybind(SPOTTER_GLOBAL_KEYS["weather-report"]),
    "toggle-report-laps": keybind(SPOTTER_GLOBAL_KEYS["toggle-report-laps"]),
    "announce-leader": keybind(SPOTTER_GLOBAL_KEYS["announce-leader"]),
    louder: keybind(SPOTTER_GLOBAL_KEYS.louder),
    quieter: keybind(SPOTTER_GLOBAL_KEYS.quieter),
    silence: keybind(SPOTTER_GLOBAL_KEYS.silence),
  }),

  // --- Setup actions (mode setting "setting"): view-* modes nudge-and-read via
  // both the increase AND decrease keys; adjust modes pick one by `direction`. ---

  "setup-aero": entry("setting", {
    "view-front-wing": pair("setupAeroFrontWingIncrease", "setupAeroFrontWingDecrease"),
    "view-rear-wing": pair("setupAeroRearWingIncrease", "setupAeroRearWingDecrease"),
    "front-wing": dir("setupAeroFrontWingIncrease", "setupAeroFrontWingDecrease"),
    "rear-wing": dir("setupAeroRearWingIncrease", "setupAeroRearWingDecrease"),
    "qualifying-tape": dir("setupAeroQualifyingTapeIncrease", "setupAeroQualifyingTapeDecrease"),
    "rf-brake-attached": keybind("setupAeroRfBrakeAttached"),
  }),

  // The dial surface of the merged Setup Aero action (#799). qualifying-tape
  // rotates too (its strip is label-only — iRacing exposes no tape value); the
  // press gesture can toggle the RF brake ducts.
  "setup-aero-dial": entry("dial.setting", {
    "front-wing": pair("setupAeroFrontWingIncrease", "setupAeroFrontWingDecrease"),
    "rear-wing": pair("setupAeroRearWingIncrease", "setupAeroRearWingDecrease"),
    "qualifying-tape": pair("setupAeroQualifyingTapeIncrease", "setupAeroQualifyingTapeDecrease"),
    "toggle-rf-brake": keybind("setupAeroRfBrakeAttached"),
  }),

  "setup-brakes": entry("setting", {
    "view-brake-bias": pair("setupBrakesBrakeBiasIncrease", "setupBrakesBrakeBiasDecrease"),
    "view-brake-bias-fine": pair("setupBrakesBrakeBiasFineIncrease", "setupBrakesBrakeBiasFineDecrease"),
    "view-peak-brake-bias": pair("setupBrakesPeakBrakeBiasIncrease", "setupBrakesPeakBrakeBiasDecrease"),
    "view-brake-misc": pair("setupBrakesBrakeMiscIncrease", "setupBrakesBrakeMiscDecrease"),
    "view-engine-braking": pair("setupBrakesEngineBrakingIncrease", "setupBrakesEngineBrakingDecrease"),
    "view-abs-adjust": pair("setupBrakesAbsAdjustIncrease", "setupBrakesAbsAdjustDecrease"),
    "abs-toggle": keybind("setupBrakesAbsToggle"),
    "abs-adjust": dir("setupBrakesAbsAdjustIncrease", "setupBrakesAbsAdjustDecrease"),
    "brake-bias": dir("setupBrakesBrakeBiasIncrease", "setupBrakesBrakeBiasDecrease"),
    "brake-bias-fine": dir("setupBrakesBrakeBiasFineIncrease", "setupBrakesBrakeBiasFineDecrease"),
    "peak-brake-bias": dir("setupBrakesPeakBrakeBiasIncrease", "setupBrakesPeakBrakeBiasDecrease"),
    "brake-misc": dir("setupBrakesBrakeMiscIncrease", "setupBrakesBrakeMiscDecrease"),
    "engine-braking": dir("setupBrakesEngineBrakingIncrease", "setupBrakesEngineBrakingDecrease"),
  }),

  // The dial surface of the merged Setup Brakes action (#775) — consumed only by
  // the dial section of setup-brakes.ejs. It can't share the keypad map above:
  // the same mode names carry different descriptors per surface (keypad
  // `brake-bias` is direction-keyed via `dir`, dial rotation requires BOTH keys
  // via `pair` since the dial has no `direction` setting). The ABS-toggle press
  // gesture is a single keybind. View modes and ABS Toggle as a rotation mode
  // are intentionally absent.
  "setup-brakes-dial": entry("dial.setting", {
    "brake-bias": pair("setupBrakesBrakeBiasIncrease", "setupBrakesBrakeBiasDecrease"),
    "brake-bias-fine": pair("setupBrakesBrakeBiasFineIncrease", "setupBrakesBrakeBiasFineDecrease"),
    "peak-brake-bias": pair("setupBrakesPeakBrakeBiasIncrease", "setupBrakesPeakBrakeBiasDecrease"),
    "brake-misc": pair("setupBrakesBrakeMiscIncrease", "setupBrakesBrakeMiscDecrease"),
    "engine-braking": pair("setupBrakesEngineBrakingIncrease", "setupBrakesEngineBrakingDecrease"),
    "abs-adjust": pair("setupBrakesAbsAdjustIncrease", "setupBrakesAbsAdjustDecrease"),
    "toggle-abs": keybind("setupBrakesAbsToggle"),
  }),

  "setup-chassis": entry("setting", {
    "view-diff-preload": pair("setupChassisDifferentialPreloadIncrease", "setupChassisDifferentialPreloadDecrease"),
    "view-diff-entry": pair("setupChassisDifferentialEntryIncrease", "setupChassisDifferentialEntryDecrease"),
    "view-diff-middle": pair("setupChassisDifferentialMiddleIncrease", "setupChassisDifferentialMiddleDecrease"),
    "view-diff-exit": pair("setupChassisDifferentialExitIncrease", "setupChassisDifferentialExitDecrease"),
    "view-anti-roll-front": pair("setupChassisFrontArbIncrease", "setupChassisFrontArbDecrease"),
    "view-anti-roll-rear": pair("setupChassisRearArbIncrease", "setupChassisRearArbDecrease"),
    "view-power-steering": pair("setupChassisPowerSteeringIncrease", "setupChassisPowerSteeringDecrease"),
    "view-weight-jacker-left": pair("setupChassisWeightJackerLeftIncrease", "setupChassisWeightJackerLeftDecrease"),
    "view-weight-jacker-right": pair("setupChassisWeightJackerRightIncrease", "setupChassisWeightJackerRightDecrease"),
    "view-lr-spring-offset": pair("setupChassisLrSpringIncrease", "setupChassisLrSpringDecrease"),
    "view-rr-spring-offset": pair("setupChassisRrSpringIncrease", "setupChassisRrSpringDecrease"),
    "differential-preload": dir("setupChassisDifferentialPreloadIncrease", "setupChassisDifferentialPreloadDecrease"),
    "differential-entry": dir("setupChassisDifferentialEntryIncrease", "setupChassisDifferentialEntryDecrease"),
    "differential-middle": dir("setupChassisDifferentialMiddleIncrease", "setupChassisDifferentialMiddleDecrease"),
    "differential-exit": dir("setupChassisDifferentialExitIncrease", "setupChassisDifferentialExitDecrease"),
    "front-arb": dir("setupChassisFrontArbIncrease", "setupChassisFrontArbDecrease"),
    "rear-arb": dir("setupChassisRearArbIncrease", "setupChassisRearArbDecrease"),
    "lr-spring": dir("setupChassisLrSpringIncrease", "setupChassisLrSpringDecrease"),
    "rr-spring": dir("setupChassisRrSpringIncrease", "setupChassisRrSpringDecrease"),
    "lf-shock": dir("setupChassisLfShockIncrease", "setupChassisLfShockDecrease"),
    "rf-shock": dir("setupChassisRfShockIncrease", "setupChassisRfShockDecrease"),
    "lr-shock": dir("setupChassisLrShockIncrease", "setupChassisLrShockDecrease"),
    "rr-shock": dir("setupChassisRrShockIncrease", "setupChassisRrShockDecrease"),
    "power-steering": dir("setupChassisPowerSteeringIncrease", "setupChassisPowerSteeringDecrease"),
  }),

  // The dial surface of the merged Setup Chassis action (#800). The LR/RR
  // springs show the pending next-pit-stop offset (#953); shocks rotate too but
  // their strips are label-only (iRacing exposes no telemetry for them).
  "setup-chassis-dial": entry("dial.setting", {
    "differential-preload": pair("setupChassisDifferentialPreloadIncrease", "setupChassisDifferentialPreloadDecrease"),
    "differential-entry": pair("setupChassisDifferentialEntryIncrease", "setupChassisDifferentialEntryDecrease"),
    "differential-middle": pair("setupChassisDifferentialMiddleIncrease", "setupChassisDifferentialMiddleDecrease"),
    "differential-exit": pair("setupChassisDifferentialExitIncrease", "setupChassisDifferentialExitDecrease"),
    "front-arb": pair("setupChassisFrontArbIncrease", "setupChassisFrontArbDecrease"),
    "rear-arb": pair("setupChassisRearArbIncrease", "setupChassisRearArbDecrease"),
    "lr-spring": pair("setupChassisLrSpringIncrease", "setupChassisLrSpringDecrease"),
    "rr-spring": pair("setupChassisRrSpringIncrease", "setupChassisRrSpringDecrease"),
    "lf-shock": pair("setupChassisLfShockIncrease", "setupChassisLfShockDecrease"),
    "rf-shock": pair("setupChassisRfShockIncrease", "setupChassisRfShockDecrease"),
    "lr-shock": pair("setupChassisLrShockIncrease", "setupChassisLrShockDecrease"),
    "rr-shock": pair("setupChassisRrShockIncrease", "setupChassisRrShockDecrease"),
    "power-steering": pair("setupChassisPowerSteeringIncrease", "setupChassisPowerSteeringDecrease"),
    // The #818 sequence needs the target box AND a prime box (Lap Timing is
    // the preferred prime) — declare both so the status line can't show a
    // green check while showBlackBox() would skip for want of a prime.
    "show-pit-stop-black-box": keybindKeys(["blackBoxLapTiming", "blackBoxPitStop"]),
    // Plugin-internal flip of dial.setting — no binding needed; declared so
    // the status line renders the explicit confirmation instead of nothing.
    "toggle-spring-side": keybindFixed(),
  }),

  "setup-engine": entry("setting", {
    "view-engine-power": pair("setupEngineEnginePowerIncrease", "setupEngineEnginePowerDecrease"),
    "view-throttle-shape": pair("setupEngineThrottleShapingIncrease", "setupEngineThrottleShapingDecrease"),
    "view-launch-rpm": pair("setupEngineLaunchRpmIncrease", "setupEngineLaunchRpmDecrease"),
    "engine-power": dir("setupEngineEnginePowerIncrease", "setupEngineEnginePowerDecrease"),
    "throttle-shaping": dir("setupEngineThrottleShapingIncrease", "setupEngineThrottleShapingDecrease"),
    "boost-level": dir("setupEngineBoostLevelIncrease", "setupEngineBoostLevelDecrease"),
    "launch-rpm": dir("setupEngineLaunchRpmIncrease", "setupEngineLaunchRpmDecrease"),
  }),

  // The dial surface of the merged Setup Engine action (#798). No press gesture;
  // boost-level rotates too (its strip is label-only — iRacing exposes no boost value).
  "setup-engine-dial": entry("dial.setting", {
    "engine-power": pair("setupEngineEnginePowerIncrease", "setupEngineEnginePowerDecrease"),
    "throttle-shaping": pair("setupEngineThrottleShapingIncrease", "setupEngineThrottleShapingDecrease"),
    "boost-level": pair("setupEngineBoostLevelIncrease", "setupEngineBoostLevelDecrease"),
    "launch-rpm": pair("setupEngineLaunchRpmIncrease", "setupEngineLaunchRpmDecrease"),
  }),

  "setup-fuel": entry("setting", {
    "view-fuel-mixture": pair("setupFuelFuelMixtureIncrease", "setupFuelFuelMixtureDecrease"),
    "view-fuel-cut-position": pair("setupFuelFuelCutPositionIncrease", "setupFuelFuelCutPositionDecrease"),
    "fuel-mixture": dir("setupFuelFuelMixtureIncrease", "setupFuelFuelMixtureDecrease"),
    "fuel-cut-position": dir("setupFuelFuelCutPositionIncrease", "setupFuelFuelCutPositionDecrease"),
    "disable-fuel-cut": keybind("setupFuelDisableFuelCut"),
    "low-fuel-accept": keybind("setupFuelLowFuelAccept"),
    "fcy-mode-toggle": keybind("setupFuelFcyModeToggle"),
  }),

  // The dial surface of the merged Setup Fuel action (#797). Rotation adjusts the
  // in-car fuel mixture / cut (distinct from the Fuel Service pit-fuel dial, #759);
  // the press gesture can toggle FCY mode.
  "setup-fuel-dial": entry("dial.setting", {
    "fuel-mixture": pair("setupFuelFuelMixtureIncrease", "setupFuelFuelMixtureDecrease"),
    "fuel-cut-position": pair("setupFuelFuelCutPositionIncrease", "setupFuelFuelCutPositionDecrease"),
    "toggle-fcy": keybind("setupFuelFcyModeToggle"),
  }),

  "setup-hybrid": entry("setting", {
    "view-mguk-deploy-mode": pair("setupHybridMgukDeployModeIncrease", "setupHybridMgukDeployModeDecrease"),
    "view-mguk-regen-gain": pair("setupHybridMgukRegenGainIncrease", "setupHybridMgukRegenGainDecrease"),
    "view-mguk-deploy-fixed": pair("setupHybridMgukFixedDeployIncrease", "setupHybridMgukFixedDeployDecrease"),
    "mguk-regen-gain": dir("setupHybridMgukRegenGainIncrease", "setupHybridMgukRegenGainDecrease"),
    "mguk-deploy-mode": dir("setupHybridMgukDeployModeIncrease", "setupHybridMgukDeployModeDecrease"),
    "mguk-fixed-deploy": dir("setupHybridMgukFixedDeployIncrease", "setupHybridMgukFixedDeployDecrease"),
    "hys-boost": keybind("setupHybridHysBoost"),
    "hys-regen": keybind("setupHybridHysRegen"),
    "hys-no-boost": keybind("setupHybridHysNoBoost"),
  }),

  // The dial surface of the merged Setup Hybrid action (#796). No press gesture
  // (Setup Hybrid has no natural toggle); View modes + HYS holds stay keypad-only.
  "setup-hybrid-dial": entry("dial.setting", {
    "mguk-deploy-mode": pair("setupHybridMgukDeployModeIncrease", "setupHybridMgukDeployModeDecrease"),
    "mguk-regen-gain": pair("setupHybridMgukRegenGainIncrease", "setupHybridMgukRegenGainDecrease"),
    "mguk-fixed-deploy": pair("setupHybridMgukFixedDeployIncrease", "setupHybridMgukFixedDeployDecrease"),
  }),

  "setup-traction": entry("setting", {
    "view-tc-slot-1": pair("setupTractionTcSlot1Increase", "setupTractionTcSlot1Decrease"),
    "view-tc-slot-2": pair("setupTractionTcSlot2Increase", "setupTractionTcSlot2Decrease"),
    "view-tc-slot-3": pair("setupTractionTcSlot3Increase", "setupTractionTcSlot3Decrease"),
    "view-tc-slot-4": pair("setupTractionTcSlot4Increase", "setupTractionTcSlot4Decrease"),
    "tc-toggle": keybind("setupTractionTcToggle"),
    "tc-slot-1": dir("setupTractionTcSlot1Increase", "setupTractionTcSlot1Decrease"),
    "tc-slot-2": dir("setupTractionTcSlot2Increase", "setupTractionTcSlot2Decrease"),
    "tc-slot-3": dir("setupTractionTcSlot3Increase", "setupTractionTcSlot3Decrease"),
    "tc-slot-4": dir("setupTractionTcSlot4Increase", "setupTractionTcSlot4Decrease"),
  }),

  // The dial surface of the merged Setup Traction action (#795) — consumed only
  // by the dial section of setup-traction.ejs. Separate from the keypad map: the
  // same mode names carry different descriptors per surface (keypad `tc-slot-N`
  // is direction-keyed via `dir`, dial rotation requires BOTH keys via `pair`).
  "setup-traction-dial": entry("dial.setting", {
    "tc-slot-1": pair("setupTractionTcSlot1Increase", "setupTractionTcSlot1Decrease"),
    "tc-slot-2": pair("setupTractionTcSlot2Increase", "setupTractionTcSlot2Decrease"),
    "tc-slot-3": pair("setupTractionTcSlot3Increase", "setupTractionTcSlot3Decrease"),
    "tc-slot-4": pair("setupTractionTcSlot4Increase", "setupTractionTcSlot4Decrease"),
    "toggle-tc": keybind("setupTractionTcToggle"),
  }),

  // --- API / chat actions (no binding required) ---

  "media-capture": entry("mode", {
    ...allApi([
      "start-stop-video",
      "video-timer",
      "toggle-video-capture",
      "take-screenshot",
      "reload-all-textures",
      "reload-car-textures",
    ]),
    "take-giant-screenshot": keybind("mediaCaptureGiantScreenshot"),
  }),

  "pit-quick-actions": entry("mode", allApi(["clear-all-checkboxes", "windshield-tearoff", "request-fast-repair"])),

  "replay-control": entry("mode", {
    ...allApi([
      "play-pause",
      "play-backward",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "slow-motion-rewind",
      "frame-forward",
      "frame-backward",
      "speed-increase",
      "speed-decrease",
      "set-speed",
      "speed-display",
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-beginning",
      "jump-to-live",
      "jump-to-my-car",
      "jump-to-fastest-lap",
      "next-car-number",
      "prev-car-number",
    ]),
    "next-car": keybind("replayControlNextCar"),
    "prev-car": keybind("replayControlPrevCar"),
  }),

  "replay-navigation": entry(
    "navigation",
    allApi([
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-start",
      "jump-to-end",
      "set-play-position",
      "search-session-time",
      "erase-tape",
    ]),
  ),

  "replay-speed": entry("direction", allApi(["increase", "decrease"])),

  "replay-transport": entry(
    "transport",
    allApi(["play", "pause", "stop", "fast-forward", "rewind", "slow-motion", "frame-forward", "frame-backward"]),
  ),

  "telemetry-control": entry("mode", {
    "toggle-logging": keybind("telemetryControlToggleLogging"),
    "mark-event": keybind("telemetryControlMarkEvent"),
    ...allApi(["start-recording", "stop-recording", "restart-recording"]),
  }),

  "race-admin": entry("mode", {
    ...allChat([
      "yellow",
      "black-flag",
      "dq-driver",
      "show-dqs-field",
      "show-dqs-driver",
      "clear-penalties",
      "clear-all",
      "wave-around",
      "eol",
      "pit-close",
      "pit-open",
      "pace-laps",
      "single-file-restart",
      "double-file-restart",
      "advance-session",
      "grid-set",
      "grid-start",
      "track-state",
      "grant-admin",
      "revoke-admin",
      "remove-driver",
      "enable-chat-all",
      "enable-chat-driver",
      "disable-chat-all",
      "disable-chat-driver",
      "message-all",
      "rc-message",
    ]),
    // Navigation only (#732) — stores the shared admin target and switches
    // profile; no iRacing command and nothing to configure. With a pending
    // focus intent (#790, set by Camera Controls' focus-select-car mode), the
    // press instead issues a `camera.switchNum` API call and stays on the grid.
    "select-car": keybindFixed(),
  }),
};
