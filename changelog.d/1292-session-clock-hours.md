---
category: Bug Fixes
weight: 50
---

The `{{session.time_remaining}}` template variable now shows hours once an hour or more is left: two hours read `2:00:00` where they used to read `120:00`, the same as Session Info's Time / Laps Remaining key. Below an hour it is unchanged. See [Template Variables](/docs/features/template-variables/#session).
