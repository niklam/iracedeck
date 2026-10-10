---
category: Bug Fixes
weight: 50
---

**Camera Controls**' **Switch by Car Number** key can now switch to a car whose number has leading zeros, such as `07` or `007`. The **Car Number** field dropped the zeros, so a key set to `07` could only reach car `7`; it now keeps the number as you type it, and `07` and `7` are different cars. See [Camera Controls](/docs/actions/view-camera/camera-focus/#switch-by-car-number).
