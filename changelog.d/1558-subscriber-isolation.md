---
category: Maintenance
weight: 40
---

A bug in one part of the plugin that reads live telemetry can no longer stop the other parts from updating or crash the plugin: the rest carry on, and the error is written to the log once rather than on every frame.
