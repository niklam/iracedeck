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
 * camera-cycle, camera-focus) are intentionally absent: they issue no iRacing
 * command, so they get no status line and no icon warning.
 */
import {
  type ActionCommMap,
  type CommDescriptor,
  keybind,
  keybindBy,
  keybindFixed,
  keybindKeys,
} from "@iracedeck/deck-core";

const api: CommDescriptor = { method: "api" };
const chat: CommDescriptor = { method: "chat" };

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

/**
 * Build the increase/decrease pair descriptor for a setup `view-*` mode, which
 * nudges-and-reads via the adjustment's increase AND decrease keys (both
 * required — warn if either is unset).
 */
function viewPair(prefix: string, mode: string): CommDescriptor {
  return keybindKeys([`${prefix}${mode}Increase`, `${prefix}${mode}Decrease`]);
}

export const COMMS_CATALOG: Record<string, ActionCommEntry> = {
  "fuel-service": entry("mode", {
    "toggle-fuel-fill": api,
    "add-fuel": chat,
    "reduce-fuel": chat,
    "set-fuel-amount": chat,
    "clear-fuel": api,
    "toggle-autofuel": keybind("fuelServiceToggleAutofuel"),
    "lap-margin-increase": keybind("fuelServiceLapMarginIncrease"),
    "lap-margin-decrease": keybind("fuelServiceLapMarginDecrease"),
  }),

  "tire-service": entry("mode", {
    "change-all-tires": chat,
    "clear-tires": api,
    "change-compound": api,
    "toggle-tires": chat,
  }),

  "black-box-selector": entry("mode", {
    direct: keybindBy("blackBox", {
      "lap-timing": "blackBoxLapTiming",
      standings: "blackBoxStandings",
      relative: "blackBoxRelative",
      fuel: "blackBoxFuel",
      tires: "blackBoxTires",
      "tire-info": "blackBoxTireInfo",
      "pit-stop": "blackBoxPitStop",
      "in-car": "blackBoxInCar",
      mirror: "blackBoxMirror",
      radio: "blackBoxRadio",
      weather: "blackBoxWeather",
    }),
    next: keybind("blackBoxCycleNext"),
    previous: keybind("blackBoxCyclePrevious"),
  }),

  "splits-delta-cycle": entry("mode", {
    cycle: keybindBy("direction", { next: "splitsDeltaNext", previous: "splitsDeltaPrevious" }),
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
    // Hardcoded Escape — no user binding.
    escape: keybindFixed(),
  }),

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

  "camera-editor-adjustments": entry("adjustment", {
    latitude: keybindBy("direction", {
      increase: "cameraEditorLatitudeIncrease",
      decrease: "cameraEditorLatitudeDecrease",
    }),
    roll: keybindBy("direction", { increase: "cameraEditorRollIncrease", decrease: "cameraEditorRollDecrease" }),
    height: keybindBy("direction", { increase: "cameraEditorHeightIncrease", decrease: "cameraEditorHeightDecrease" }),
  }),

  "camera-editor-controls": entry("control", {
    "open-camera-tool": keybind("cameraEditorOpenCameraTool"),
    "reset-camera": keybind("cameraEditorResetCamera"),
    "exit-car": keybind("cameraEditorExitCar"),
    "reset-to-pits": keybind("cameraEditorResetToPits"),
    tow: keybind("cameraEditorTow"),
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
    "wheel-lfe-intensity": keybindBy("direction", {
      increase: "forceFeedbackWheelLfeIntensityIncrease",
      decrease: "forceFeedbackWheelLfeIntensityDecrease",
    }),
    "haptic-lfe-intensity": keybindBy("direction", {
      increase: "forceFeedbackHapticLfeIntensityIncrease",
      decrease: "forceFeedbackHapticLfeIntensityDecrease",
    }),
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
};

/** `viewPair` is exported for the setup-* catalog entries added in a follow-up. */
export { viewPair };
