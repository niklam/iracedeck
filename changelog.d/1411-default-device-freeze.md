---
category: Bug Fixes
weight: 70
---

The plugin no longer freezes when the Windows default output device changes while one of its sounds is playing or has just played. Naming the plugin's entry in the Volume Mixer could lock up against Windows moving the audio to the new device, after which no key responded until the deck host was restarted.
