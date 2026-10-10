# Second read: learnings

Read at the start of every run. One line per entry, with the PR it came from. See `SKILL.md` for what belongs here.

## Misses — look for these

- A workflow step that calls the network with no timeout: a stalled endpoint holds the job to the runner's limit (#1121).
- A workflow whose token permissions are granted to every job when only one needs to write (#1121).
- A flag set when something is created and assumed to still hold on the path that updates an existing one; check each path sets it (#1121, `--latest=false` on a release).
- A check that passes on a substring of the source: commented-out text, or an earlier occurrence, satisfies it (#1360).
- A rule that protects the field from one odd value but not the player's own car holding that same value (#1174, a stray pace line).
- A workflow file run from one ref against a tree checked out from another: every value hard-coded in the file must match the checked-out tree (#1121 and #1178, the pnpm pin on the voice-pack publish path).

## Non-findings — do not raise these

- A pattern every sibling follows is a decision: `dial: DialSettings.catch(() => DialSettings.parse({}))` on dual-surface actions, `import z from "zod"`, floating major-version tags on GitHub Actions (#853, #854, #817, #683).
- A defect in code the diff moved or renamed but did not write. Mention it once as an aside at most (#346, #347).
- Runtime validation of files this repo's own build generates, such as a plugin's `bin/config.json` (#316).
- API stability, migration guards or changelog entries for private workspace packages: nothing outside this repository consumes them (#677).
- A new Race Engineer callout defaulting to on: that is the maintainer's standing decision (#534).
