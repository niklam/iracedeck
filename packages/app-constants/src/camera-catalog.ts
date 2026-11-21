/**
 * The camera catalog's published view and the standard camera groups (issue
 * #1653), in the `app-constants` leaf so the plugin side that publishes the
 * view (`deck-iracing`) and the Property Inspector bundle that reads it
 * (`pi-components`) name one shape without depending on one another.
 *
 * Design: docs/superpowers/specs/2026-11-08-issue-1653-custom-camera-groups.md.
 */

/**
 * Passthrough global holding the camera catalog as a Property Inspector sees
 * it, as JSON: a {@link CameraCatalogView}.
 *
 * The catalog itself lives in `cameras.json` beside the settings file; this
 * key is only how a Property Inspector (the Camera Controls picker and grids)
 * and the settings window's Camera groups card see it, together with which
 * groups the current session has.
 *
 * Run-scoped (see `RUN_SCOPED_SETTING_KEYS`): the file is the durable copy, so
 * this key never reaches `global-settings.json`. The plugin publishes it once
 * the catalog loads, whenever the catalog changes, whenever the current
 * session's track or group list changes, and with `current: null` on
 * disconnect — its re-assertion within the run.
 */
export const CAMERA_CATALOG_KEY = "_cameraCatalog";

/** One track the catalog has seen, keyed by the sim's `WeekendInfo.TrackID` (per layout). */
export interface CameraCatalogViewTrack {
  /** `WeekendInfo.TrackID`. */
  id: number;
  /** `WeekendInfo.TrackDisplayName`. */
  name: string;
  /** `WeekendInfo.TrackConfigName`; empty when the track has no configurations. */
  config: string;
}

/** One remembered camera group name. */
export interface CameraCatalogViewGroup {
  /** The canonical name (`normalizeGroupName` applied). */
  name: string;
  /** Indices into {@link CameraCatalogView.tracks} of the tracks whose LATEST group list holds this name. */
  tracks: number[];
  /** ISO time the name was last seen in a session. */
  lastSeen: string;
}

/** The current session's track and its camera groups. */
export interface CameraCatalogViewCurrent {
  /** `WeekendInfo.TrackID`. */
  trackId: number;
  /** The session's group names, canonical, in the sim's order (`GroupNum` ascending). */
  groups: string[];
}

/** The value of {@link CAMERA_CATALOG_KEY}, parsed. */
export interface CameraCatalogView {
  version: 1;
  tracks: CameraCatalogViewTrack[];
  groups: CameraCatalogViewGroup[];
  /** The current session, or null with no session. */
  current: CameraCatalogViewCurrent | null;
}

/** The headings the Change Camera picker groups the standard groups under, in order. */
export type StandardCameraGroupSection = "Car" | "Chase" | "Track" | "Aerial";

/** One of the 25 standard camera groups as the Change Camera picker offers it. */
export interface StandardCameraGroupOption {
  /** The stored `cameraGroup` number (`CHANGE_CAMERA_GROUPS` in iracing-actions). */
  value: number;
  /** The canonical group name, what `cameraGroupName` stores. */
  name: string;
  /** What the picker shows. */
  label: string;
  section: StandardCameraGroupSection;
}

/**
 * The 25 standard groups in the Change Camera picker's order and sections.
 *
 * A hand copy of iracing-actions' `CHANGE_CAMERA_GROUPS` with the picker's
 * labels and grouping, for the Property Inspector bundle, which cannot import
 * that package. `camera-focus-pi.test.ts` holds it to `CHANGE_CAMERA_GROUPS`
 * (every number and name, nothing missing or extra), as #958's test holds the
 * template's own copies.
 */
export const STANDARD_CAMERA_GROUP_OPTIONS: readonly StandardCameraGroupOption[] = [
  { value: 1, name: "Nose", label: "Nose", section: "Car" },
  { value: 2, name: "Gearbox", label: "Gearbox", section: "Car" },
  { value: 9, name: "Cockpit", label: "Cockpit", section: "Car" },
  { value: 3, name: "Roll Bar", label: "Roll Bar", section: "Car" },
  { value: 6, name: "Gyro", label: "Gyro", section: "Car" },
  { value: 4, name: "LF Susp", label: "Suspension - Left Front", section: "Car" },
  { value: 7, name: "RF Susp", label: "Suspension - Right Front", section: "Car" },
  { value: 5, name: "LR Susp", label: "Suspension - Left Rear", section: "Car" },
  { value: 8, name: "RR Susp", label: "Suspension - Right Rear", section: "Car" },
  { value: 12, name: "Chase", label: "Chase", section: "Chase" },
  { value: 13, name: "Far Chase", label: "Far Chase", section: "Chase" },
  { value: 14, name: "Rear Chase", label: "Rear Chase", section: "Chase" },
  { value: 17, name: "TV1", label: "TV1", section: "Track" },
  { value: 18, name: "TV2", label: "TV2", section: "Track" },
  { value: 19, name: "TV3", label: "TV3", section: "Track" },
  { value: 23, name: "TV4", label: "TV4", section: "Track" },
  { value: 21, name: "TV Static", label: "TV Static", section: "Track" },
  { value: 22, name: "TV Mixed", label: "TV Mixed", section: "Track" },
  { value: 20, name: "Scenic", label: "Scenic", section: "Track" },
  { value: 24, name: "Spotter", label: "Spotter", section: "Track" },
  { value: 25, name: "Spectator", label: "Spectator", section: "Track" },
  { value: 15, name: "Pit Lane", label: "Pit Lane", section: "Track" },
  { value: 16, name: "Pit Lane 2", label: "Pit Lane 2", section: "Track" },
  { value: 11, name: "Chopper", label: "Chopper", section: "Aerial" },
  { value: 10, name: "Blimp", label: "Blimp", section: "Aerial" },
];
