---
name: youtube-channel-exporter
description: Export the publicly visible Videos and Shorts from one YouTube channel or profile URL into a Markdown report containing title, canonical video URL, view count, publish date, and Video/Short type, plus a plain one-URL-per-line block for Google NotebookLM. Use when the user provides a YouTube channel URL and asks to list, inventory, scrape, export, or save its public video metadata without using the YouTube Data API or downloading media.
---

# YouTube Channel Exporter

Export one public YouTube channel to `youtube.<channel>.md` in the current working directory. Use the bundled runner; do not reimplement the extraction in the conversation.

## Preconditions

- Keep one channel URL per run.
- Prefer anonymous public extraction. Use browser cookies only when the user explicitly agrees after an access error.
- Require `yt-dlp` and a supported JavaScript runtime. The runner discovers the local isolated runtime at `$HOME/.codex/skills/.runtime/yt-dlp` as well as `yt-dlp` on `PATH`.
- Do not download video, audio, thumbnails, subtitles, or comments.
- Treat the result as an inventory of publicly discoverable channel items. Private, deleted, and unlisted-only videos cannot be discovered from a public channel page.

Install or update the isolated `yt-dlp` runtime when needed:

```bash
"$HOME/.codex/skills/youtube-channel-exporter/scripts/setup_runtime"
```

Keep Deno 2.3+ or Node 22+ on `PATH`; the exporter detects either automatically.

## Command

Run from the workspace where the Markdown file should be written:

```bash
"$HOME/.codex/skills/youtube-channel-exporter/scripts/export_channel" \
  --profile-url "https://www.youtube.com/@example"
```

Useful options:

- `--mode accurate` (default): inventory the channel, then enrich every item without downloading media.
- `--mode fast`: use channel-card metadata only; dates may be approximate and counts may be rounded or missing.
- `--include-streams`: include the channel's Streams tab and classify those items as `Video`.
- `--max-items-per-tab N`: limit each requested tab for testing or small samples.
- `--max-items-total N`: export only the newest `N` items after combining Videos and Shorts.
- `--output-dir PATH`: write the report and cache in another directory.
- `--cookies-from-browser BROWSER`: opt in to browser cookies only after user approval.
- `--refresh`: ignore fresh cached metadata and fetch every item again.

Run `scripts/export_channel --help` for the complete current interface.

## Workflow

1. Validate and normalize the channel URL.
2. Inventory `/videos` and `/shorts` separately; add `/streams` only when requested.
3. Determine `Short` from membership in the Shorts tab. Never infer it from duration.
4. In accurate mode, enrich each canonical watch URL sequentially and cache successful item metadata for resumable runs.
5. Deduplicate by YouTube video ID, sort newest first, and write the Markdown report atomically.
6. Read the report status and problems before reporting success to the user.

## Output Contract

- Filename: `youtube.<channel-handle-or-id>.md`.
- Status:
  - `SUCCESS`: every requested tab completed and every accurate-mode item was enriched.
  - `PARTIAL`: usable rows were written, but at least one tab or item could not be fully verified.
  - `FAILED`: no requested tab could be inventoried.
- Table columns:
  - `#`
  - `视频标题`
  - `视频类型`
  - `播放数`
  - `发布时间`
  - `视频链接`
- Use `Video` or `Short` only for the public type column.
- Format known view counts as full integers with thousands separators.
- Format known publish dates as `YYYY-MM-DD`.
- Render unavailable values as `—`; never invent them.
- Put `## NotebookLM 视频链接` last. Under it, write only canonical watch URLs, one per line, without bullets, numbering, code fences, or commentary.

## Failure Handling

- Treat a genuinely absent channel tab as an empty successful tab, not a scraper failure.
- Mark the report `PARTIAL` if a requested tab errors, JSON cannot be parsed, or accurate enrichment fails for any item.
- Preserve the flat inventory row when accurate enrichment fails so the report remains useful.
- Start anonymous. If YouTube requests sign-in or bot confirmation, stop and show the exact problem; do not silently use personal cookies.
- Before concluding that extraction is broken, update the isolated `yt-dlp` runtime and retry once.
- Do not add Playwright, proxies, CAPTCHA solving, undocumented API clients, or PO-token providers unless the failure evidence specifically requires a separately approved fallback.
