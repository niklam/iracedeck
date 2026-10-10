---
category: Bug Fixes
weight: 50
---

**Session Info** keys now use much less CPU and memory in a race, most noticeably in a large field with a key on **iRating Gain/Loss**. Each key worked out its value on every telemetry update, about 60 times a second, even though it only refreshes ten times a second (on iRating Gain/Loss that meant re-running the whole estimate each time); it now does that work only when it refreshes. Incident and flag flashes still start the moment they happen. See [Session Info](/docs/actions/display-session/session-info/).
