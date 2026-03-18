# Field Map

Use these output columns exactly and in this order:

1. `Video title`
2. `Creator name`
3. `Creator ID`
4. `Publish time`
5. `Video duration`
6. `Plays`
7. `Like count`
8. `Share count`
9. `Comment count`
10. `Collections`
11. `Video URL`
12. `Hashtags`

## Value Rules

- Write one video per row.
- Keep `Creator ID` as the public TikTok handle without the leading `@`.
- Prefer structured page data or observed JSON payloads before DOM selectors.
- Leave a field blank when it cannot be read confidently.
- Normalize dates to `YYYY/MM/DD` when possible.
- Normalize durations to `MM:SS` or `HH:MM:SS`.
- Normalize compact counts like `1.4M`, `42K`, or `10,600` into plain integer strings.
- Keep `Hashtags` in a single cell joined by `, `.

## Markdown Safety

- Escape pipe characters as `\|`.
- Replace embedded newlines with `<br>`.
- Do not split one video across multiple Markdown rows.

## Filename Rule

- Always write to `tiktok.{creator_id}.md`.
- Use the `creator_id` parsed from the input profile URL as the filename key.
- Overwrite any existing file with the same name in the current workspace.
