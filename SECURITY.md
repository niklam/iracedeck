# Security Policy

## Supported Versions

Only the latest release receives security fixes. There is no backporting to older versions.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/iracedeck/iracedeck/security/advisories/new). You'll receive an acknowledgment within 48 hours and a follow-up with next steps within a week.

## Scope

iRaceDeck is a plugin for the Elgato Stream Deck, Mirabox and Ulanzi Deck host software, running locally on a Windows PC. The security surface is small, but reports are welcome for:

- Vulnerabilities in the native C++ addons (memory safety, buffer overflows): `iracing-native`, which reads the iRacing SDK and sends keyboard input, and `audio-native`, the audio mixer behind the Race Engineer and Radar
- The settings window's local server: an HTTP and WebSocket server on `127.0.0.1`, guarded by a launch token, an `Origin` check and a session cookie. Anything that lets a web page, or anything else that is not the settings window, get past that guard, read or change settings, or reach files outside the folder it serves
- Voice-pack downloads and installs: the catalog fetched from iracedeck.com, the archive download and its hash check, extraction of the archive (path traversal, zip bombs, forged install records), and the install and removal of pack folders, including a pack installed by hand
- The update check behind the What's New tab, which fetches the published changelog from iracedeck.com and renders it in the settings window: anything that gets markup or script from it into the window
- Dependency supply chain issues
- Anything that could allow unintended code execution beyond keyboard simulation
- Path traversal or file access issues

## Out of Scope

- Bugs in iRacing itself
- Bugs in the deck host software: Elgato Stream Deck, the Mirabox hosts (HotSpot StreamDock, VSD Craft) and UlanziStudio
- Social engineering
- Denial of service against local resources (the plugin already runs locally with full user permissions)
