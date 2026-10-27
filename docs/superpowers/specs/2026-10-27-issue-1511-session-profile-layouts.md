> **Issue:** [#1511](https://github.com/niklam/iracedeck/issues/1511) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Better bundled layouts for the Test, Practice, Qualifying and Race profiles

## The problem

Automatic switching by session kind (#1111) lands on the Test, Practice, Qualifying and Race profiles. Practice got a real layout in #1456, but Test, Qualifying and Race shipped as starting points, which the website described as "a starting point … to shape to your own liking". A driver who turns switching on gets a thin deck in exactly the sessions the feature exists for.

## Decisions

### 1. Improve the bundled profiles; add none and change no code

The four templates keep their names, files and manifest entries, and stay on the four target devices (SD, XL, Plus, Plus XL: 16 files). Only their contents change. Nothing else in the plugin reads a profile's layout, so no code, setting or test moves.

### 2. Each layout fits its session

Each layout is authored by the maintainer in the Stream Deck app and exported, per the workflow in `.claude/rules/profiles-and-devices.md`. Each one is built around what a driver does in that session:

- **Test** is alone on track: pit service, brake and traction adjustments, lap and delta readouts, black box selection. No chat keys.
- **Practice** is the Test layout plus chat macros and session info.
- **Qualifying** and **Race** put fuel and tire service up front, along with brake and traction adjustments, session info, chat macros and black box selection.

A larger deck carries more of the same rather than a different idea, so the four device variants of one template differ in reach, not in purpose.

### 3. Every Switch Profile marker names the profile it sits in

The host-profile marker (#762) is how the plugin learns which profile is showing. Back to previous and the switch-back when iRacing exits both depend on it. A layout started by copying another profile keeps the source's marker, and 10 of the 16 exports did. Practice Plus XL had that mistake on `master` already. Every marker is set to its own profile's device-suffixed name.

These were fixed by rewriting only the `hostProfile` value inside each bundle, not by another export. The rule that a bundle is never hand-edited exists because the app refuses to re-import a bundle whose profile or page UUIDs were reused or edited. This edit leaves every UUID, every other entry and every entry's metadata byte-identical, which was checked by blanking the `hostProfile` values and comparing each changed page with the export. The manual test is what confirms the app accepts the files.

### 4. Profiles that are already installed keep the user's version

An update never overwrites an installed profile (measured in #1111), and that stays: a bundled profile is the user's to edit once it is installed. So the new layouts reach only users who have not installed that profile yet. The changelog says so, so that nobody expects their deck to change on update. Forcing a reinstall or detecting an untouched install is not attempted.

## Out of scope

- The Default, Replay, Car Selector and Race Admin Per Car profiles.
- Devices that have no bundled profiles yet (Mini, Neo, Galleon).
- Getting the new layouts onto existing installs (decision 4).
- Pages with no marked Switch Profile key. The rule asks for one on every page that can be entered, and several pages, on master as well as here, have none. That gap is older than this change.

## Testing

- **Automated:** none of this is code. The existing `profiles.json` and manifest tests still pass, since no file name or registration changed.
- **Checked from the files:** each of the 16 bundles is registered with the device type its `Device.Model` matches, carries the suffix-free display name, and has every `hostProfile` set to its own name.
- **Manual:** link the plugin from the worktree on a Stream Deck. For each of the four profiles, uninstall any installed copy, switch to it from the Settings window, and confirm that the app installs it and shows the new layout. On one profile, use a Switch Profile key to Replay, then Back to previous, and confirm it returns to the profile it came from. With automatic switching on, start a session of each kind and confirm the matching profile appears.
