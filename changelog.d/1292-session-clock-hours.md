---
category: Bug Fixes
weight: 50
---

The `{{session.time_remaining}}` template variable now shows hours once an hour or more is left, as Session Info's Time / Laps Remaining key does: two hours read `2:00:00` where the variable used to read `120:00`, and nothing changes below an hour. An expression that compares or cuts up that text sees the new form too; for math, use `telemetry.SessionTimeRemain`. See [Template Variables](/docs/features/template-variables/#session).
