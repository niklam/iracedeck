---
category: Features
weight: 50
---

Template expressions have a new `empty()` function for showing a fallback when a value is missing: `{{= empty(race_ahead.position) ? '--' : 'P' + race_ahead.position }}` shows `--` while nobody is ahead of you, where the expression used to go blank. It counts a missing variable and empty text as empty, but not `0`. See [Template Variables](/docs/features/template-variables/#functions).
