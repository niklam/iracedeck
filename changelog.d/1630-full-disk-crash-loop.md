---
category: Bug Fixes
weight: 60
---

On Stream Deck, the plugin no longer crashes when it can't write to its log, for example because the disk is full, and no longer crashes again every time Stream Deck restarts it. It keeps running without those log lines, and once writing works again the log says how many were lost and why.
