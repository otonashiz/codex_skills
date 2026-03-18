# Risk Guardrails

Use the skill conservatively.

## Allowed

- Open one public TikTok creator profile URL at a time.
- Use a headed local browser session.
- Wait for the profile feed to settle before scrolling.
- Scroll the profile at a human-like pace.
- Read only data already rendered on the public profile page or normally loaded while browsing that profile.

## Not Allowed

- Do not automate login.
- Do not solve CAPTCHA or challenge flows.
- Do not rotate proxies.
- Do not use undocumented TikTok APIs directly.
- Do not open video detail pages as part of the default extraction path.
- Do not switch to cloud scraping services, browser plugins, or hosted actors as the default path.

## Stop Conditions

- Stop on login wall, challenge, forced modal that blocks progress, or page-level errors.
- Stop when repeated scrolling yields no new video links.
- Stop after reaching the requested `max-items`.

## Partial Runs

- Preserve all records already collected before the stop condition.
- Mark the report status as `PARTIAL` or `BLOCKED`.
- Write the blocker or failure reason into the Markdown header.
