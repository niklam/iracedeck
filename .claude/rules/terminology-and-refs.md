---
# Terminology & References

- **Property Inspector** - Stream Deck UI for action settings.
- **Key Icon** - The SVG shown on a Stream Deck button.
- **Dial** - Rotary dial on Stream Deck+ (the Elgato SDK and manifest call it an *encoder*).
- **Action ID** - Format `com.iracedeck.sd.{plugin}.{action-name}`.
- **Mode** - The user-facing name of an action's mode/sub-action selector, on BOTH the keypad and dial PI surfaces. The `<sdpi-item>` label MUST be exactly "Mode" — never "Setting", "Component", "Control", or "Adjustment" — and prose/docs refer to it as the Mode dropdown. (The bound settings key may still be `setting`/`dial.setting`; this rule is about the user-facing label.)

References

- iRacing SDK: https://forums.iracing.com/discussion/15068/official-iracing-sdk
- Stream Deck SDK: https://docs.elgato.com/sdk/
