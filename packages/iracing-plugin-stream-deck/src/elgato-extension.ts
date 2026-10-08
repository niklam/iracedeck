/**
 * What only the Stream Deck host has (#1349): bundled profiles (#736), the
 * connected-deck list for the settings window's device picker, and the
 * device type the changelog URL carries (#680). Built by the shell, started
 * by the bootstrap; building it has no side effects.
 *
 * Every member is a closure over `sd` and `adapter`, never a method reading
 * `this`: the bootstrap hands `switchProfile` to the settings window unbound.
 */
import type StreamDeck from "@elgato/streamdeck";
import type { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { initProfileSwitcher } from "@iracedeck/deck-core";
import { type PluginExtension, STREAM_DECK_ACTIONS } from "@iracedeck/plugin-runtime";
import { updateGlobalSettings } from "@iracedeck/settings";

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
    },
    refreshDevices,
  };
}
