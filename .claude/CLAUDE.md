# iRaceDeck — Project memory

Project-wide instructions and overview for iRaceDeck. See the `.claude/rules/` directory for focused, topic-specific rules (code style, testing, icons, Stream Deck actions, build & commit conventions, etc.).

Packages

- `@iracedeck/logger`
- `@iracedeck/iracing-native`
- `@iracedeck/iracing-sdk`
- `@iracedeck/stream-deck-shared`
- `@iracedeck/stream-deck-plugin`
- `@iracedeck/stream-deck-plugin-comms`
- `@iracedeck/stream-deck-plugin-pit`
- `@iracedeck/website`

High-level guidance

- Follow rule files in `.claude/rules/` for granular conventions.
- Keep rules focused: one topic per markdown file.
- Use `paths` frontmatter in rules when a rule applies only to certain files.

How to import or reference

You can import or reference specific rule files from other markdown using `@.claude/rules/<file>.md` if needed.

For more detailed, scoped project rules see the files in `.claude/rules/`.
