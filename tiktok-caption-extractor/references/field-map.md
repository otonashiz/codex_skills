# Field Map

Use structured page data first. Prefer exact fields over DOM scraping.

## Metadata

- Author: `author.uniqueId`, `author.unique_id`, then uploader-like fallbacks
- Author display name: `author.nickname`, `author.displayName`, `author.name`
- Publish time: `createTime`, `create_time`, `publishedAt`
- Duration: `video.duration`, `duration`, `videoDuration`
- Plays: `stats.playCount`, `stats.play_count`, `stats.viewCount`, `stats.views`
- Likes: `stats.diggCount`, `stats.likeCount`, `stats.likes`
- Shares: `stats.shareCount`, `stats.share_count`, `stats.shares`
- Comments: `stats.commentCount`, `stats.comment_count`, `stats.comments`
- Reposts: `stats.repostCount`, `stats.repost_count`
- Description: `desc`, `description`, `title`
- Hashtags: `textExtra`, `challenges`, `hashtags`, and inline `#tag` parsing

## Captions

Look for caption-like arrays or objects in structured data and response payloads:

- `subtitleInfos`
- `subtitleInfoList`
- `captions`
- `subtitles`
- `videoSubtitleList`
- `claSubtitleList`

Normalize each track to:

- URL
- language
- extension or format hint
- optional direct response body if already captured

Preserve the original-language caption whenever TikTok exposes multiple tracks. English translated captions can be useful for checking meaning, but the report's main transcript should remain the original extracted speech text.

Parse subtitle content in this order:

1. WebVTT
2. SRT
3. JSON segment payloads with text fields

After parsing, if the final transcript is neither English nor Chinese, append a `## English Translation` section to the generated Markdown report with a complete, natural English translation.
