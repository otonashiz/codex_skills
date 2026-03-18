---
name: tiktok-caption-extractor
description: Extract TikTok video metadata and platform-provided caption/transcript tracks from one public TikTok video URL into a Markdown report. Use when Codex receives a TikTok video link and needs to produce the same Markdown layout as the legacy TikTok analyzer, but with browser-based Playwright extraction instead of Whisper. If the video has no platform transcript/caption track, fail clearly instead of inventing text.
---

# TikTok 视频分析器

Use the bundled Playwright runner to open one TikTok video detail page in a local headed browser, extract publicly visible video metadata plus any platform subtitle track, and write a Markdown report into the current working directory.

## Preconditions

- This skill launches a local headed Chrome session. Treat it as a browser automation task, not a pure sandbox CLI task.
- For the first real extraction in a fresh thread or restricted runtime, request browser-launch approval up front.
- Use one TikTok video URL per run.
- Prefer anonymous browsing first, but allow normal browser cookies if TikTok serves richer page data that way.
- Allow a local proxy via environment variable when needed.
- Do not run Whisper or any other ASR fallback in this skill.

## Install

Install the runner dependencies once:

```bash
cd "$HOME/.codex/skills/tiktok-caption-extractor/scripts"
npm install
```

Only if Chromium fallback is needed:

```bash
npx playwright install chromium
```

## Command

Run the wrapper script:

```bash
"$HOME/.codex/skills/tiktok-caption-extractor/scripts/extract_video" \
  --video-url "https://www.tiktok.com/@fiona_in_guangzhou/video/7480362031934115102"
```

Optional flags:

- `--slow-mo MS`
- `--timeout-ms MS`
- `--headless`

Optional environment variables:

- `TIKTOK_ANALYZER_PROXY`
- `https_proxy`
- `http_proxy`
- `all_proxy`

Use `--help` on the wrapper for the latest usage text.

## Workflow

1. Validate the video URL and derive `video_id` and creator handle from the public URL.
2. Launch a local Chrome session with Playwright and light stealth settings.
3. Open the TikTok video detail page, wait for the page to stabilize, dismiss obvious modals, and detect blocker states early.
4. Collect page JSON from `__UNIVERSAL_DATA_FOR_REHYDRATION__`, `SIGI_STATE`, and `__NEXT_DATA__`, while also recording small JSON and subtitle-like network responses.
5. Build metadata from structured page data first, then use page metadata fallbacks only for fields already visible on the page.
6. Extract platform subtitle track URLs or direct subtitle payloads from structured data and captured responses.
7. If no platform subtitle is available, fail with `该视频没有可提取的平台字幕`.
8. Write the Markdown report into the current working directory.

## Output Contract

- Output directory: current working directory.
- Output filename: `tiktok.{author}.{description}.md`
- Markdown layout must match the legacy analyzer:
  - `# TikTok 视频分析`
  - `## 基本信息`
  - `## 视频描述`
  - `## Hashtags`
  - `## 口播文案（语音转录）`

## Failure Handling

- If TikTok redirects to login, challenge, or other blockers before extraction succeeds, fail clearly with the blocker reason.
- If metadata is available but no platform subtitle track is found, fail clearly with `该视频没有可提取的平台字幕`.
- If TikTok changes the page structure, update `scripts/extract_video.mjs` instead of inventing ad hoc selectors in the conversation.

## References

- Field mapping and output rules: `references/field-map.md`
