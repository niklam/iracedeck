# Template Variables

Use `{{variable}}` placeholders in message text and key text fields to insert live iRacing data. Variables are resolved at runtime from telemetry and session information.

## Syntax

Wrap variable names in double curly braces: `{{group.field}}`

- Variables use dot notation: `{{self.position}}`, `{{track_ahead.name}}`
- Unresolved variables become empty strings (never displayed as raw `{{...}}`)
- Multiple variables can be used in the same string
- Plain text without `{{...}}` is passed through unchanged

## Examples

| Template | Resolved |
|----------|----------|
| `P{{self.position}} — {{self.first_name}}` | `P3 — John` |
| `{{track_ahead.first_name}}, let me pass!` | `Alex, let me pass!` |
| `Sorry {{track_behind.first_name}}!` | `Sorry Maria!` |
| `Incident on lap {{self.lap}} at {{track.short_name}}` | `Incident on lap 12 at Spa` |
| `{{session.laps_remaining}} laps to go` | `5 laps to go` |

## Variable Reference

### Self (`self.*`)

Information about the player's own car.

| Variable | Description | Example |
|----------|-------------|---------|
| `self.name` | Full driver name | `John Smith` |
| `self.first_name` | First name | `John` |
| `self.last_name` | Last name (everything after first space) | `Smith` |
| `self.abbrev_name` | Abbreviated name from iRacing | `J. Smith` |
| `self.car_number` | Car number | `42` |
| `self.position` | Overall race position | `3` |
| `self.class_position` | Class position | `2` |
| `self.lap` | Current lap number | `12` |
| `self.laps_completed` | Laps completed | `11` |
| `self.irating` | iRating | `3500` |
| `self.license` | License string | `A 4.99` |
| `self.incidents` | Incident count (self only) | `3` |

### Track Ahead (`track_ahead.*`)

The physically closest car **ahead on track**, based on track position. This is the car directly in front of you regardless of race position — a lapped car right ahead of you shows here, not under `race_ahead`.

Cars on pit road, the pace car, and spectators are excluded.

### Track Behind (`track_behind.*`)

The physically closest car **behind on track**. Same logic as `track_ahead` but in the opposite direction.

### Race Ahead (`race_ahead.*`)

The car **one position ahead in the standings** (your position minus 1). This is the car you need to pass to gain a position, regardless of where they are physically on track.

### Race Behind (`race_behind.*`)

The car **one position behind in the standings** (your position plus 1).

### Driver Fields

All four driver groups (`track_ahead`, `track_behind`, `race_ahead`, `race_behind`) share the same fields:

| Field | Description | Example |
|-------|-------------|---------|
| `.name` | Full driver name | `Alex Johnson` |
| `.first_name` | First name | `Alex` |
| `.last_name` | Last name | `Johnson` |
| `.abbrev_name` | Abbreviated name | `A. Johnson` |
| `.car_number` | Car number | `77` |
| `.position` | Overall race position | `5` |
| `.class_position` | Class position | `3` |
| `.lap` | Current lap number | `10` |
| `.laps_completed` | Laps completed | `9` |
| `.irating` | iRating | `2800` |
| `.license` | License string | `B 3.50` |

### Session (`session.*`)

| Variable | Description | Example |
|----------|-------------|---------|
| `session.type` | Session type | `Race` |
| `session.laps_remaining` | Laps remaining | `10` |
| `session.time_remaining` | Time remaining (MM:SS) | `61:01` |

### Track (`track.*`)

| Variable | Description | Example |
|----------|-------------|---------|
| `track.name` | Full track name | `Spa-Francorchamps` |
| `track.short_name` | Short track name | `Spa` |

## Track Position vs Race Position

Understanding the difference between `track_ahead`/`track_behind` and `race_ahead`/`race_behind`:

- **Track position** answers: "who is physically near me on track right now?"
- **Race position** answers: "who am I racing against in the standings?"

Example: You are P6. A P17 car being lapped is directly in front of you, while P5 is 10 seconds up the road.

| Variable | Driver | Why |
|----------|--------|-----|
| `track_ahead` | The P17 car | Physically closest car ahead on track |
| `race_ahead` | The P5 car | One position ahead in standings |

## Edge Cases

- **Leading the race**: `race_ahead` fields are empty
- **Last in race**: `race_behind` fields are empty
- **Leading on track**: `track_ahead` fields are empty (no car ahead physically)
- **Last on track**: `track_behind` fields are empty
- **No session data**: All fields return empty strings
- **No telemetry**: Position, lap, and incident fields return empty strings; name fields may still be available from session info
