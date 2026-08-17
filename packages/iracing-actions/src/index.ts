/**
 * @iracedeck/iracing-actions
 *
 * Platform-agnostic iRaceDeck action classes.
 * Each action exports a UUID constant and a class extending ConnectionStateAwareAction.
 */

export { AI_SPOTTER_CONTROLS_UUID, AiSpotterControls } from "./actions/ai-spotter-controls/ai-spotter-controls.js";
export { AUDIO_CONTROLS_UUID, AudioControls } from "./actions/audio-controls/audio-controls.js";
export { BLACK_BOX_SELECTOR_UUID, BlackBoxSelector } from "./actions/black-box-selector/black-box-selector.js";
export {
  CAMERA_CONTROLS_UUID,
  CAMERA_FOCUS_UUID,
  CameraControls,
  CameraFocus,
} from "./actions/camera-controls/camera-controls.js";
export {
  CAMERA_EDITOR_ADJUSTMENTS_UUID,
  CameraEditorAdjustments,
} from "./actions/camera-editor-adjustments/camera-editor-adjustments.js";
export {
  CAMERA_EDITOR_CONTROLS_UUID,
  CameraEditorControls,
} from "./actions/camera-editor-controls/camera-editor-controls.js";
export { CAR_CONTROL_UUID, CarControl } from "./actions/car-control/car-control.js";
export { CHAT_UUID, Chat } from "./actions/chat/chat.js";
export { COCKPIT_MISC_UUID, CockpitMisc } from "./actions/cockpit-misc/cockpit-misc.js";
export { FORCE_FEEDBACK_UUID, ForceFeedback } from "./actions/force-feedback/force-feedback.js";
export { migrateLfeIntensityBindingKeys } from "./actions/force-feedback/migrate-lfe-intensity.js";
export { FUEL_SERVICE_UUID, FuelService } from "./actions/fuel-service/fuel-service.js";
export { LOOK_DIRECTION_UUID, LookDirection } from "./actions/look-direction/look-direction.js";
export { MEDIA_CAPTURE_UUID, MediaCapture } from "./actions/media-capture/media-capture.js";
export {
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
  PIT_CREW_UUID,
  PitCrew,
} from "./actions/pit-crew/pit-crew.js";
// Audio preview runner (#992): the Test buttons' sequences, shared by the Pit
// Crew action and the settings window's `audioPreview` command.
export {
  AUDIO_PREVIEW_KINDS,
  isAudioPreviewKind,
  runAudioPreview,
  type AudioPreviewKind,
} from "./audio/audio-previews.js";
export { PIT_QUICK_ACTIONS_UUID, PitQuickActions } from "./actions/pit-quick-actions/pit-quick-actions.js";
export { RACE_ADMIN_UUID, RaceAdmin } from "./actions/race-admin/race-admin.js";
export { REPLAY_CONTROL_UUID, ReplayControl } from "./actions/replay-control/replay-control.js";
export { REPLAY_NAVIGATION_UUID, ReplayNavigation } from "./actions/replay-navigation/replay-navigation.js";
export { REPLAY_SPEED_UUID, ReplaySpeed } from "./actions/replay-speed/replay-speed.js";
export { REPLAY_TRANSPORT_UUID, ReplayTransport } from "./actions/replay-transport/replay-transport.js";
export { SESSION_INFO_UUID, SessionInfo } from "./actions/session-info/session-info.js";
export { SETUP_AERO_UUID, SetupAero } from "./actions/setup-aero/setup-aero.js";
export { SETUP_BRAKES_UUID, SetupBrakes } from "./actions/setup-brakes/setup-brakes.js";
export {
  SETUP_CHASSIS_BINDING_KEY_RENAMES,
  SETUP_CHASSIS_UUID,
  SetupChassis,
} from "./actions/setup-chassis/setup-chassis.js";
export { SETUP_ENGINE_UUID, SetupEngine } from "./actions/setup-engine/setup-engine.js";
export { SETUP_FUEL_UUID, SetupFuel } from "./actions/setup-fuel/setup-fuel.js";
export { SETUP_HYBRID_UUID, SetupHybrid } from "./actions/setup-hybrid/setup-hybrid.js";
export { SETUP_TRACTION_UUID, SetupTraction } from "./actions/setup-traction/setup-traction.js";
export { SPLITS_DELTA_CYCLE_UUID, SplitsDeltaCycle } from "./actions/splits-delta-cycle/splits-delta-cycle.js";
export { SWITCH_PROFILE_UUID, SwitchProfile } from "./actions/switch-profile/switch-profile.js";
export { TELEMETRY_CONTROL_UUID, TelemetryControl } from "./actions/telemetry-control/telemetry-control.js";
export { TELEMETRY_DISPLAY_UUID, TelemetryDisplay } from "./actions/telemetry-display/telemetry-display.js";
export { TIRE_SERVICE_UUID, TireService } from "./actions/tire-service/tire-service.js";
export { TOGGLE_UI_ELEMENTS_UUID, ToggleUiElements } from "./actions/toggle-ui-elements/toggle-ui-elements.js";
export { VIEW_ADJUSTMENT_UUID, ViewAdjustment } from "./actions/view-adjustment/view-adjustment.js";
