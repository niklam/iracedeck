---
category: Improvements
weight: 50
---

The audio output device now stays open for as long as iRacing runs with the Race Engineer or the Radar on, instead of being opened for each burst of callouts and closed five seconds after the last one. A race could open it dozens of times, each one initialising the audio driver; now it opens once, when iRacing launches. With iRacing closed the device is still open only while a sound plays, so the PC can sleep. See [Settings](/docs/getting-started/settings/#race-engineer).
