/**
 * A second mock session (#1653): the default mock session at another track,
 * with a camera file shaped like a broadcaster package loaded — custom group
 * names (`DynamicTV`, `Grid_Pole`, `SpeedCam`, `Drone`) among some of the
 * standard ones, and the `Pit Lane2` spelling one capture reports (#958). It
 * is how the camera catalog and Camera Controls are tested against custom
 * groups.
 *
 * Built from {@link MOCK_SESSION_INFO_YAML} by replacing its track identity
 * and its whole `CameraInfo` block, so every other section stays the default
 * mock's. Each replacement must match exactly once; if the default mock is
 * reshaped so one no longer does, loading this module throws, rather than
 * silently yielding a copy of the default.
 *
 * Select it with `new IRacingNativeMock(undefined, { sessionInfoYaml:
 * MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS })`, or switch a running mock to it
 * with `setSessionInfoYaml`, which is what loading a camera file mid-session
 * looks like to the SDK.
 */
import { MOCK_SESSION_INFO_YAML } from "./session-info.js";

/** The variant's `WeekendInfo.TrackID`; the default mock's is 13. */
export const MOCK_CUSTOM_CAMERAS_TRACK_ID = 501;

/** The variant's camera group names in the sim's order (`GroupNum` 1, 2, …), as the YAML spells them. */
export const MOCK_CUSTOM_CAMERA_GROUP_NAMES: readonly string[] = [
  "Nose",
  "Cockpit",
  "Chase",
  "Far Chase",
  "TV1",
  "TV2",
  "Pit Lane",
  "Pit Lane2",
  "DynamicTV",
  "Grid_Pole",
  "SpeedCam",
  "Drone",
  "Chopper",
  "Blimp",
];

/** The groups a broadcaster package adds; every other one is a standard name. */
const BROADCASTER_GROUPS: ReadonlySet<string> = new Set(["DynamicTV", "Grid_Pole", "SpeedCam", "Drone"]);

/** One group's YAML, with `cameras` cameras named after it. */
function groupYaml(groupNum: number, name: string, cameras: number): string {
  const lines = [` - GroupNum: ${groupNum}`, `   GroupName: ${name}`, "   Cameras:"];

  for (let camera = 1; camera <= cameras; camera++) {
    lines.push(`   - CameraNum: ${camera}`, `     CameraName: ${name.replace(/\s+/g, "")}_${camera}`);
  }

  return lines.join("\n");
}

const CUSTOM_CAMERA_INFO = [
  "CameraInfo:",
  " Groups:",
  // The broadcaster groups hold several cameras each; the standard ones one.
  ...MOCK_CUSTOM_CAMERA_GROUP_NAMES.map((name, i) => groupYaml(i + 1, name, BROADCASTER_GROUPS.has(name) ? 3 : 1)),
  "",
  "",
].join("\n");

/** `text` with the one match of `pattern` replaced; throws when it matches anything but once. */
function replaceOnce(text: string, pattern: RegExp, replacement: string): string {
  const matches = text.match(
    new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
  );

  if (matches?.length !== 1) {
    throw new Error(`Mock session variant: ${String(pattern)} matched ${matches?.length ?? 0} times, expected once`);
  }

  return text.replace(pattern, () => replacement);
}

/** The variant's session info YAML. */
export const MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS = [
  [/^ TrackName: .*$/m, " TrackName: mockbroadcast full"],
  [/^ TrackID: .*$/m, ` TrackID: ${MOCK_CUSTOM_CAMERAS_TRACK_ID}`],
  [/^ TrackDisplayName: .*$/m, " TrackDisplayName: Mock Broadcast Circuit"],
  [/^ TrackDisplayShortName: .*$/m, " TrackDisplayShortName: Mock Broadcast"],
  [/^ TrackConfigName: .*$/m, " TrackConfigName: Full Course"],
  [/^CameraInfo:\n[\s\S]*?(?=^RadioInfo:)/m, CUSTOM_CAMERA_INFO],
].reduce(
  (yaml, [pattern, replacement]) => replaceOnce(yaml, pattern as RegExp, replacement as string),
  MOCK_SESSION_INFO_YAML,
);
