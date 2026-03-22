---
name: tiktok-profile-extractor
description: Extract publicly visible video metadata from a TikTok creator profile URL into a Markdown report named `tiktok.{creator_id}.md` in the current workspace using a local Playwright browser session. Use when Codex is given a TikTok creator profile link and needs to wait for the profile feed to load, scroll the profile, collect the profile item list, handle partial or blocked runs, and write one Markdown table without using cloud scrapers, plugins, proxies, or undocumented APIs.
---

# TikTok Profile Extractor

Use the bundled Playwright runner to collect publicly visible video metadata from one TikTok creator profile and write `tiktok.{creator_id}.md` in the current workspace.

## Preconditions

- This skill launches a local headed Chrome session. Treat it as a browser automation task, not a pure sandboxed CLI task.
- For the first real scrape in a fresh thread or restricted runtime, request browser-launch approval up front instead of intentionally trying a sandbox-only run first.
- Prefer anonymous access.
- Do not automate login, CAPTCHA solving, proxy rotation, or hidden APIs.
- Keep one creator profile URL per run.
- Write output into the current working directory, not the skill directory.
- Install the runner dependencies once:

```bash
cd "$HOME/.codex/skills/tiktok-profile-extractor/scripts"
npm install

# Only if Chromium fallback is needed:
npx playwright install chromium
```

## Command

Run the wrapper script:

```bash
"$HOME/.codex/skills/tiktok-profile-extractor/scripts/scrape_profile" \
  --profile-url "https://www.tiktok.com/@tech.panda.pro"
```

Execution note:

- If the environment distinguishes sandboxed commands from approved local browser runs, use the approved browser run path for the first real scrape command.

Optional flags:

- `--max-items N`
- `--slow-mo MS`
- `--timeout-ms MS`

Use `--help` on the script for the latest usage text.

## Workflow

1. Validate the profile URL and derive `creator_id` from the public handle.
2. Open the profile in a headed browser, wait for the feed and profile item list to stabilize, then scroll until no new video cards appear, `max_items` is reached, or a blocker is detected.
3. Collect unique video URLs in profile order and map them to the structured `itemList` payload captured from the profile page.
4. Build rows from the profile payload first, with light DOM fallback only for fields already visible on the profile page.
5. Write or overwrite `tiktok.{creator_id}.md` in the current workspace.
6. Read the report header first if the status is `PARTIAL` or `BLOCKED`.

## Output Contract

- Output path: current working directory.
- Output filename: `tiktok.{creator_id}.md`.
- Report header fields:
  - Source profile URL
  - Creator ID
  - Bio
  - Followers
  - Scraped at
  - Status
  - Video count
  - Problems
- Table columns:
  - `Video title`
  - `Creator name`
  - `Creator ID`
  - `Publish time`
  - `Video duration`
  - `Plays`
  - `Like count`
  - `Share count`
  - `Comment count`
  - `Collections`
  - `Video URL`
  - `Hashtags`
- Keep `Hashtags` in one cell separated by `, `.
- Overwrite an existing file with the same name.

## Failure Handling

- If a login wall, challenge, forced modal, or page exception appears after partial progress, stop and write the partial rows plus the blocker reason in the header.
- If no video URLs or profile payload records are collected before a blocker, still write the Markdown file with zero rows and `BLOCKED`.
- If TikTok changes the page structure, update `scripts/scrape_profile.mjs` instead of inventing ad hoc selectors in the conversation.

## References

- Field and format rules: `references/field-map.md`
- Risk boundary and blocker handling: `references/risk-guardrails.md`
