# TikTok Profile Extractor Dev Log

## Purpose

This file is a technical record for the skill implementation. It is not part of the normal skill invocation path and should not be referenced by default during routine runs.

## Current Stable Baseline

- Skill: `tiktok-profile-extractor`
- Execution model: local headed Playwright browser session
- Scope: one public TikTok creator profile per run
- Output: `tiktok.{creator_id}.md` in the current workspace
- Current successful behavior:
  - waits for the profile page to warm up
  - scrolls the profile feed until it stabilizes
  - extracts structured video metadata from profile-page `item_list` responses
  - does not enter video detail pages

## Root Cause We Actually Hit

The main blank-field regression was not caused by:

- insufficient wait time
- missing top-of-page videos in TikTok `item_list`
- detail-page parsing
- creator-specific profile layouts

The actual cause was in the JSON collector.

At the time, `buildJsonCollector()` applied a generic size gate before keeping the parsed response:

```js
if (!text || text.length > 2_000_000) {
  return;
}
```

That rule dropped the first large `/api/post/item_list/` response for some profiles. Those first payloads contained the newest videos at the top of the profile. Later paginated `item_list` responses were smaller, so later videos still had complete structured fields.

This created the observed symptom:

- top section of the report had title and URL only
- later section of the report had publish time, duration, plays, and engagement metrics

## Minimal Fix That Was Validated

The current validated fix is intentionally narrow:

- `/api/post/item_list/` is exempt from the `2_000_000` response text limit
- all other JSON responses still keep the generic size cap

Conceptually:

```js
const isProfileItemList = url.includes("/api/post/item_list/");
if (!text || (!isProfileItemList && text.length > 2_000_000)) {
  return;
}
```

Why this fix was chosen:

- minimal blast radius
- preserves the existing successful flow
- directly fixes the proven root cause
- does not change browsing behavior or increase navigation risk

## What The Current Architecture Still Looks Like

Today the collector still works in two stages:

1. Keep raw `/api/post/item_list/` payloads in `profilePayloads`
2. At the end of the run, convert `profilePayloads` into normalized records and merge them into final report rows

That design is functional, but it has a weakness:

- it depends on raw payloads surviving collection intact until the end of the run

If any future filter, truncation rule, buffer cap, or parsing edge case affects those raw payloads, structured fields can disappear again even though the browser actually received the data.

## Recommended Long-Term Improvement

### Summary

Do not treat `/api/post/item_list/` primarily as raw payload storage.

Instead:

- normalize each `item_list` response immediately when it arrives
- merge each video into a persistent in-memory index keyed by `videoId`
- use that normalized index as the main source of truth during final report construction

### Proposed Data Flow

Current flow:

1. network response arrives
2. parse JSON
3. store raw payload
4. later extract records from stored payloads
5. build final rows

Proposed long-term flow:

1. network response arrives
2. parse JSON
3. if response is `/api/post/item_list/`, extract `itemList` immediately
4. convert each item into a normalized record with `buildRecordFromVideoEntity()`
5. merge into `profileRecordMap`
6. build final rows directly from `profileRecordMap`

### Target Shape

Suggested collector state:

```js
{
  payloads: [],
  profilePayloads: [], // optional small debug sample only
  profileRecordMap: new Map(),
  onResponse
}
```

Suggested merge key order:

- primary key: `videoId`
- secondary fallback: normalized `videoUrl`

### Where It Would Change

Main code areas:

- `buildJsonCollector()`
  - current job: collect raw payloads
  - future job: collect raw payloads only as secondary debug material, but normalize `item_list` responses immediately

- `extractRecordsFromPayloads()`
  - current job: main conversion step
  - future job: secondary compatibility fallback only

- final report assembly in `run()`
  - current job: derive `payloadRecordMap` from `profilePayloads`
  - future job: derive it directly from `profileRecordMap`

## Why The Long-Term Version Is Better

- it reduces dependence on raw payload retention
- it makes memory growth more predictable
- it naturally deduplicates repeated videos across first-page and later pagination responses
- it simplifies debugging of field gaps
- it lets the collector fail smaller: losing one raw payload no longer means losing the whole batch of final structured rows

## Risks Of The Long-Term Version

### 1. Earlier merge logic becomes more important

Because records are merged as soon as responses arrive, `mergeRecordParts()` becomes more central. If merge precedence is wrong, early weak data could overwrite later better data.

Mitigation:

- keep merge semantics "fill empty fields first"
- prefer existing non-empty values unless a stronger source is explicitly recognized

### 2. Less raw payload available for postmortem debugging

If raw `profilePayloads` are fully removed, forensic debugging becomes harder.

Mitigation:

- keep the last 2 to 5 raw `item_list` payloads as a debug sample
- do not keep the full raw history

### 3. Collector responsibility becomes slightly heavier

The collector would no longer be a passive buffer. It would parse, normalize, and merge.

Mitigation:

- keep the normalization code thin and reuse existing helpers:
  - `buildRecordFromVideoEntity()`
  - `mergeRecordParts()`
  - `normalizeVideoUrl()`

### 4. Hidden assumptions become more visible

This change will expose whether there are item variants that do not normalize cleanly yet.

Mitigation:

- keep `extractRecordsFromPayloads()` as a compatibility fallback during migration
- test against both previously successful and previously problematic creators

## Recommended Migration Sequence

Do not hard-switch in one step.

Recommended order:

1. Keep the current minimal fix in place
2. Add `profileRecordMap` to `buildJsonCollector()`
3. Populate `profileRecordMap` immediately from every `/api/post/item_list/` response
4. In final row assembly, prefer `profileRecordMap`
5. Fall back to `extractRecordsFromPayloads(profilePayloads, ...)` only when necessary
6. After validation, downgrade `profilePayloads` to a small debug buffer

## What Should Not Change

The long-term improvement should not change these behaviors:

- do not open video detail pages
- do not introduce login automation
- do not introduce plugins, MCP, proxies, or cloud scrapers
- do not change output filename or output format
- do not change the current slow warmup and scrolling approach unless a separate issue requires it

## Validation Strategy For The Long-Term Change

Use both stable-success and previously-problematic creators.

Minimum regression set:

- profiles that already extract fully
- profiles that previously had a blank prefix
- a profile with partial residual edge cases such as missing duration only

Validation checks:

- top rows no longer lose structured fields
- later rows remain correct
- video order remains profile order
- no duplicate videos are introduced
- memory usage stays bounded during long profiles

## Current Recommendation

Keep the current minimal fix as the production baseline.

Treat the long-term collector normalization plan as a quality and maintainability upgrade, not an urgent bug fix. It is worth implementing when we want stronger resilience against future collector regressions, but it is not required for the skill to remain usable today.
