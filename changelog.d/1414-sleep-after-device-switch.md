---
category: Bug Fixes
weight: 55
---

The PC can go to sleep again after the Windows default output device was changed while one of the plugin's sounds was playing. With SteelSeries Sonar the plugin could leave an audio stream open afterwards, which kept Windows awake until the deck host was restarted, and every such change used up a little more memory.
