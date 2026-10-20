/**
 * What only the Stream Deck host has (#1349): bundled profiles (#736), the
 * automatic profile switch by session kind (#1111), the connected-deck list
 * for the settings window's device picker, and the device type the changelog
 * URL carries (#680). Built by the shell, started by the bootstrap; building
 * it has no side effects.
 *
 * Every member is a closure over `sd` and `adapter`, never a method reading
 * `this`: the bootstrap hands `switchProfile` to the settings window unbound.
 */
import type StreamDeck from "@elgato/streamdeck";
import type { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { getCurrentProfile, getFeatureFlag, initProfileSwitcher, requestProfileSwitch } from "@iracedeck/deck-core";
import { getController, onIRacingTerminated } from "@iracedeck/deck-iracing";
import { availableProfilesForDevice } from "@iracedeck/iracing-actions";
import { type PluginExtension, STREAM_DECK_ACTIONS } from "@iracedeck/plugin-runtime";
import { getGlobalSettings, updateGlobalSettings } from "@iracedeck/settings";
import { getSessionKind, getSessionType } from "@iracedeck/sim-events-iracing";

import { createSessionProfileReactor } from "./session-profile-reactor.js";

/** The SDK controller subscription id of the session-kind profile reactor (#1111). */
export const SESSION_PROFILE_SUBSCRIPTION_ID = "session-profile-reactor";

export function createElgatoExtension(sd: typeof StreamDeck, adapter: ElgatoPlatformAdapter): PluginExtension {
  // Publish the connected decks for the settings window's profile device picker,
  // the same way `_audioDeviceList` is published for the audio device picker:
  // a passthrough global setting, deduped by content, refreshed on every device
  // change and whenever the window opens.
  let lastPushedDeckDevicesJson = "";

  const refreshDevices = (): void => {
    const devices = [...sd.devices].filter((d) => d.isConnected).map((d) => ({ id: d.id, name: d.name, type: d.type }));
    const json = JSON.stringify(devices);

    if (json === lastPushedDeckDevicesJson) return;

    lastPushedDeckDevicesJson = json;
    updateGlobalSettings({ _deckDevices: json });
  };

  return {
    extraActions: STREAM_DECK_ACTIONS,
    getConnectedDeviceType: () => [...sd.devices].find((d) => d.isConnected)?.type,
    // Unlike a PI, the window has no implicit device: it names one. Same
    // dispatch as the PI's accordion buttons (suffix per #753, history per #762).
    switchProfile: (deviceId, profile, page) => adapter.switchToBundledProfile(deviceId, profile, page),
    start: () => {
      // Wire profile switching (Elgato-only) for the Switch Profile action and the
      // "Stream Deck Profiles" settings buttons (#736)
      initProfileSwitcher(
        (deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page),
        adapter.createLogger("ProfileSwitcher"),
      );
      sd.devices.onDeviceDidConnect(() => refreshDevices());
      sd.devices.onDeviceDidDisconnect(() => refreshDevices());

      // Switch the decks to the profile mapped to the session's kind (#1111).
      // By now initCore has built the SDK controller and initSim the translator
      // that subscribed to it first, so each tick reads the kind the translator
      // has just updated; the global settings were initialised just before this
      // phase started the extension, and are read live at every tick. The switch
      // goes through `requestProfileSwitch` with the manifest name the reactor
      // resolved against profiles.json, so it lands on the per-device history
      // the Switch Profile action's Back to previous walks (#762).
      if (getFeatureFlag("profiles") === true) {
        createSessionProfileReactor({
          getSessionKind,
          getRawSessionType: getSessionType,
          subscribeTicks: (onTick) => {
            const controller = getController();

            controller.subscribe(SESSION_PROFILE_SUBSCRIPTION_ID, () => onTick());

            return () => controller.unsubscribe(SESSION_PROFILE_SUBSCRIPTION_ID);
          },
          onSimTerminated: onIRacingTerminated,
          getSettings: getGlobalSettings,
          listDecks: () => [...sd.devices].filter((d) => d.isConnected).map((d) => ({ id: d.id, type: d.type })),
          availableProfiles: availableProfilesForDevice,
          getCurrentProfile,
          switchProfile: (deviceId, profile, page) => requestProfileSwitch(deviceId, profile, page),
          logger: adapter.createLogger("SessionProfile"),
        }).start();
      }
    },
    refreshDevices,
  };
}
