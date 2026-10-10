---
category: Bug Fixes
weight: 50
---

**Camera Controls**' **Switch by Car Number** key can now switch to a car whose number has leading zeros, such as `07` or `007`. The key ignored the zeros, so one set to `07` could only reach car `7`; `07` and `7` are now different cars, and a key already set to a number with leading zeros now switches to that car. See [Camera Controls](/docs/actions/view-camera/camera-focus/#switch-by-car-number).
