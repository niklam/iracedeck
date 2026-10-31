/**
 * The settings phase's audio-device step (#1377): publish the audio device
 * list and apply the saved device selection.
 *
 * `audioOutputDevice` is persisted as the platform-stable `ma_device_id`
 * (hex-encoded) — empty string means System Default. The enumeration index
 * is volatile across replug / driver reset / OS audio-preference change, so
 * we re-resolve by id every session.
 *
 * Legacy values from pre-#427 builds (numeric index strings, the literal
 * "-1", malformed entries) are treated as unknown and silently fall back
 * to System Default. The project is pre-v1 with a single user; no
 * migration code is needed.
 *
 * Building it has no side effects; it reaches the audio service through
 * `getAudio()` at each call.
 */
import { getAudio } from "@iracedeck/audio-service";
import { updateGlobalSettings } from "@iracedeck/settings";

export interface AudioDeviceSync {
  /** Publish `_audioDeviceList` unless it is identical to the last one pushed. */
  pushIfChanged(): void;
  /** On the first settings arrival only, seed the device list (see the body). */
  seedOnFirstArrival(): void;
  /** Select the saved `audioOutputDevice` when it differs from the one last applied. */
  applySaved(saved: unknown): void;
}

export function createAudioDeviceSync(): AudioDeviceSync {
  let initialDevicePushDone = false;
  // Starts as `""` (System Default) because `getAudio().init()` leaves the
  // remembered selection at System Default without creating an engine/device
  // (#849) — without this seed, the first arrival of `audioOutputDevice = ""`
  // would look like a transition and fire a redundant `setAudioDevice(-1)`.
  let currentAudioDeviceId: string = "";
  // Cache the last pushed payload so identical re-enumerations (the common
  // case on repeated PI re-opens with no hardware change) don't churn the
  // sdpi-components data source and force a full dropdown re-render.
  let lastPushedDeviceListJson = "";

  function pushIfChanged(): void {
    const devices = getAudio().getAudioDevices();
    const json = JSON.stringify(devices);

    if (json === lastPushedDeviceListJson) return;

    lastPushedDeviceListJson = json;
    updateGlobalSettings({ _audioDeviceList: json });
  }

  return {
    pushIfChanged,
    seedOnFirstArrival() {
      // First time settings arrive, seed the device list so the PI sees the
      // initial enumeration without needing to be opened first. After this
      // the PI-appear hook drives refreshes — `initialDevicePushDone` is just
      // a one-shot gate, not a "never refresh" latch.
      if (initialDevicePushDone) return;

      initialDevicePushDone = true;
      pushIfChanged();
    },
    applySaved(saved) {
      // Apply audio output device (on startup and when changed from PI)
      const deviceId = typeof saved === "string" ? saved : "";

      if (deviceId === currentAudioDeviceId) return;

      currentAudioDeviceId = deviceId;

      if (deviceId === "") {
        getAudio().setAudioDevice(-1);
      } else {
        const ok = getAudio().setAudioDeviceById(deviceId);

        // Stale or unknown id (legacy index, unplugged device): fall back to
        // System Default. We do NOT rewrite the persisted setting — the user
        // may replug their device next session and we want it to re-bind
        // automatically when the id reappears in the enumeration.
        if (!ok) {
          getAudio().setAudioDevice(-1);
        }
      }
    },
  };
}
