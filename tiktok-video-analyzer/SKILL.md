---
name: tiktok-video-analyzer
description: Analyze one public TikTok video URL by extracting video metadata, platform-provided caption text, and visible top-level comment signals, then write a Markdown report with hot comments, audience questions, conversion signals, and practical insights. Use when Codex receives a TikTok video link and needs more than caption extraction, especially for comment analysis, audience intent understanding, or conversion-oriented insight.
---

# TikTok Video Analyzer

Use the bundled Playwright runner to open one TikTok video detail page in a local browser, extract publicly visible video metadata plus any platform caption track, collect visible top-level comments, and write an insight-oriented Markdown report into the current working directory.

## Preconditions

- Launch a local headed Chrome session by default. Treat this as browser automation, not a pure sandbox CLI task.
- Request browser-launch approval up front for the first real run in a restricted environment.
- Use one public TikTok video URL per run.
- Prefer anonymous browsing first, but allow normal browser cookies if TikTok serves richer page data that way.
- Allow a local proxy via environment variable when needed.
- Do not automate login, CAPTCHA solving, or hidden APIs.
- Do not run Whisper or any other ASR fallback in this skill.
- Treat comments as best-effort evidence. If caption extraction succeeds but comments are blocked or unavailable, write a partial report instead of failing the whole run.

## Install

Install the runner dependencies once:

```bash
cd "$HOME/.codex/skills/tiktok-video-analyzer/scripts"
npm install
```

Only if Chromium fallback is needed:

```bash
npx playwright install chromium
```

## Command

Run the wrapper script:

```bash
"$HOME/.codex/skills/tiktok-video-analyzer/scripts/analyze_video" \
  --video-url "https://www.tiktok.com/@fiona_in_guangzhou/video/7480362031934115102"
```

Optional flags:

- `--slow-mo MS`
- `--timeout-ms MS`
- `--headless`
- `--max-comments N`
- `--comment-scrolls N`

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
4. Collect page JSON from `__UNIVERSAL_DATA_FOR_REHYDRATION__`, `SIGI_STATE`, and `__NEXT_DATA__`, while also recording small JSON and caption-like network responses.
5. Build metadata from structured page data first, then use page metadata fallbacks only for fields already visible on the page.
6. Extract one platform caption track from structured data or captured responses. If no platform caption is available, fail with `该视频没有可提取的平台字幕`.
7. Collect visible top-level comments. Prefer structured data and captured responses, then use DOM fallback only for fields already visible on the page.
8. Rank hot comments, group common audience questions, classify conversion signals, and derive evidence-based insights.
9. Write the Markdown report into the current working directory.

## Output Contract

- Output directory: current working directory.
- Output filename: `tiktok.{author}.{description}.md`
- Markdown layout:
  - `# TikTok 视频分析`
  - `## 基本信息`
  - `## 视频描述`
  - `## Hashtags`
  - `## 口播文案`
  - `## 评论区概览`
  - `## 核心热评`
  - `## 用户最关心的问题`
  - `## 洞见总结`
  - `## 转化信号判断`
- Keep `## 口播文案` for platform-provided caption text only. Do not label it as a transcript.
- In `## 评论区概览`, include the comment-analysis status, sample size, and any blockers or collection problems.
- In `## 核心热评`, include representative top-level comments with evidence fields such as likes, replies, or pinned status when available.
- In `## 用户最关心的问题`, group questions by concrete themes instead of listing raw comments only.
- In `## 洞见总结`, prefer evidence-backed findings over generic marketing language.

## Failure Handling

- If TikTok redirects to login, challenge, or other blockers before caption extraction succeeds, fail clearly with the blocker reason.
- If metadata is available but no platform caption track is found, fail clearly with `该视频没有可提取的平台字幕`.
- If caption extraction succeeds but comments are blocked or unavailable, write a partial report that keeps the caption and metadata sections and explains the comment limitation.
- If TikTok changes the page structure, update `scripts/analyze_video.mjs` instead of inventing ad hoc selectors in the conversation.

## References

- Field mapping and output rules: `references/field-map.md`
- Comment scoring, question grouping, and conversion heuristics: `references/insight-rubric.md`
