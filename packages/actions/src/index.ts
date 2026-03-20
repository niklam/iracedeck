/**
 * @iracedeck/actions
 *
 * Platform-agnostic iRaceDeck action classes.
 * Each action exports a UUID constant and a class extending ConnectionStateAwareAction.
 */

export { AI_SPOTTER_CONTROLS_UUID, AiSpotterControls } from "./actions/ai-spotter-controls.js";
export { AUDIO_CONTROLS_UUID, AudioControls } from "./actions/audio-controls.js";
export { BLACK_BOX_SELECTOR_UUID, BlackBoxSelector } from "./actions/black-box-selector.js";
export { CAMERA_CYCLE_UUID, CameraCycle } from "./actions/camera-cycle.js";
export { CAMERA_EDITOR_ADJUSTMENTS_UUID, CameraEditorAdjustments } from "./actions/camera-editor-adjustments.js";
export { CAMERA_EDITOR_CONTROLS_UUID, CameraEditorControls } from "./actions/camera-editor-controls.js";
export { CAMERA_FOCUS_UUID, CameraFocus } from "./actions/camera-focus.js";
export { CAR_CONTROL_UUID, CarControl } from "./actions/car-control.js";
export { CHAT_UUID, Chat } from "./actions/chat.js";
export { COCKPIT_MISC_UUID, CockpitMisc } from "./actions/cockpit-misc.js";
export { FUEL_SERVICE_UUID, FuelService } from "./actions/fuel-service.js";
export { LOOK_DIRECTION_UUID, LookDirection } from "./actions/look-direction.js";
export { MEDIA_CAPTURE_UUID, MediaCapture } from "./actions/media-capture.js";
export { PIT_QUICK_ACTIONS_UUID, PitQuickActions } from "./actions/pit-quick-actions.js";
export { RACE_ADMIN_UUID, RaceAdmin } from "./actions/race-admin.js";
export { REPLAY_CONTROL_UUID, ReplayControl } from "./actions/replay-control.js";
export { REPLAY_NAVIGATION_UUID, ReplayNavigation } from "./actions/replay-navigation.js";
export { REPLAY_SPEED_UUID, ReplaySpeed } from "./actions/replay-speed.js";
export { REPLAY_TRANSPORT_UUID, ReplayTransport } from "./actions/replay-transport.js";
export { SESSION_INFO_UUID, SessionInfo } from "./actions/session-info.js";
export { SETUP_AERO_UUID, SetupAero } from "./actions/setup-aero.js";
export { SETUP_BRAKES_UUID, SetupBrakes } from "./actions/setup-brakes.js";
export { SETUP_CHASSIS_UUID, SetupChassis } from "./actions/setup-chassis.js";
export { SETUP_ENGINE_UUID, SetupEngine } from "./actions/setup-engine.js";
export { SETUP_FUEL_UUID, SetupFuel } from "./actions/setup-fuel.js";
export { SETUP_HYBRID_UUID, SetupHybrid } from "./actions/setup-hybrid.js";
export { SETUP_TRACTION_UUID, SetupTraction } from "./actions/setup-traction.js";
export { SPLITS_DELTA_CYCLE_UUID, SplitsDeltaCycle } from "./actions/splits-delta-cycle.js";
export { TELEMETRY_CONTROL_UUID, TelemetryControl } from "./actions/telemetry-control.js";
export { TELEMETRY_DISPLAY_UUID, TelemetryDisplay } from "./actions/telemetry-display.js";
export { TIRE_SERVICE_UUID, TireService } from "./actions/tire-service.js";
export { TOGGLE_UI_ELEMENTS_UUID, ToggleUiElements } from "./actions/toggle-ui-elements.js";
export { VIEW_ADJUSTMENT_UUID, ViewAdjustment } from "./actions/view-adjustment.js";
