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
import { availableProfilesForDevice } from "@iracedeck/iracing-actions";
import { type PluginExtension, STREAM_DECK_ACTIONS } from "@iracedeck/plugin-runtime";
import { getGlobalSettings, updateGlobalSettings } from "@iracedeck/settings";

import { createSessionProfileReactor } from "./session-profile-reactor.js";

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
    start: ({ sim }) => {
      // Wire profile switching (Elgato-only) for the Switch Profile action and the
      // "Stream Deck Profiles" settings buttons (#736)
      initProfileSwitcher(
        (deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page),
        adapter.createLogger("ProfileSwitcher"),
      );
      sd.devices.onDeviceDidConnect(() => refreshDevices());
      sd.devices.onDeviceDidDisconnect(() => refreshDevices());

      // Switch the decks to the profile mapped to the session's kind (#1111).
      // The sim arrives through the context (#1500), so this shell imports no
      // sim package. `sim.onTick` calls back after the sim has handled each
      // update — that is its contract, not the order of controller subscribers
      // — so each tick reads the kind just updated; the global settings were
      // initialised before this phase started the extension, and are read live
      // at every tick. The members are wrapped, not passed bare, so a `HostSim`
      // written with methods keeps its `this`. The switch
      // goes through `requestProfileSwitch` with the manifest name the reactor
      // resolved against profiles.json, so it lands on the per-device history
      // the Switch Profile action's Back to previous walks (#762). Gated the way
      // the settings window gates its Profiles pane (`!== false`), so the card
      // is never shown for a switch that cannot run.
      if (getFeatureFlag("profiles") !== false) {
        createSessionProfileReactor({
          getSessionKind: () => sim.getSessionKind(),
          getRawSessionType: () => sim.getRawSessionType(),
          subscribeTicks: (onTick) => sim.onTick(onTick),
          onSimTerminated: (listener) => sim.onSimTerminated(listener),
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
