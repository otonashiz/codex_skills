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

Parse caption content in this order:

1. WebVTT
2. SRT
3. JSON segment payloads with text fields

## Comments

Prefer top-level comment objects from structured data or captured JSON responses. Common fields include:

- Comment id: `cid`, `commentId`, `comment_id`, `id`
- Comment text: `text`, `commentText`, `content`, `replyCommentText`
- Author handle: `user.uniqueId`, `user.unique_id`
- Author name: `user.nickname`, `user.displayName`, `user.name`
- Like count: `diggCount`, `digg_count`, `likeCount`, `stats.diggCount`
- Reply count: `replyCommentTotal`, `reply_comment_total`, `replyCount`
- Published time: `createTime`, `create_time`, `time`, `commentTime`
- Pinned state: `isPinned`, `pinned`, `sticky`, `top`

When structured data is incomplete, use DOM fallback only for:

- visible comment text
- visible author handle or name
- visible like / reply labels
- obvious pinned labels

Keep only top-level comments in the report. Do not expand reply threads in this skill.
