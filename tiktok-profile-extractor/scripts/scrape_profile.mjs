#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SLOW_MO_MS = 250;
const PROFILE_INITIAL_SETTLE_MS = 7000;
const PROFILE_POLL_INTERVAL_MS = 3000;
const PROFILE_INITIAL_POLL_ATTEMPTS = 12;
const PROFILE_STABLE_PASSES_REQUIRED = 2;
const SCROLL_PAUSE_MS = 4500;
const STAGNANT_SCROLL_LIMIT = 10;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

let stealthConfigured = false;

function buildBrowserLaunchOptions(args, extra = {}) {
  return {
    headless: false,
    slowMo: args.slowMo,
    locale: "en-US",
    viewport: { width: 1440, height: 960 },
    userAgent: DEFAULT_USER_AGENT,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,960",
    ],
    ...extra,
  };
}

async function pathExists(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromeExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.GOOGLE_CHROME_SHIM,
  ];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
  } else if (process.platform === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  } else if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    );
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function launchBrowserContext(userDataDir, args) {
  let chromeChannelError = null;
  let chromeExecutableError = null;

  try {
    return await chromium.launchPersistentContext(
      userDataDir,
      buildBrowserLaunchOptions(args, { channel: "chrome" }),
    );
  } catch (error) {
    chromeChannelError = error;
  }

  const chromeExecutablePath = await resolveChromeExecutablePath();
  if (chromeExecutablePath) {
    try {
      return await chromium.launchPersistentContext(
        userDataDir,
        buildBrowserLaunchOptions(args, { executablePath: chromeExecutablePath }),
      );
    } catch (error) {
      chromeExecutableError = error;
    }
  }

  try {
    return await chromium.launchPersistentContext(
      userDataDir,
      buildBrowserLaunchOptions(args),
    );
  } catch (fallbackError) {
    const details = [
      chromeChannelError ? `Chrome channel failed: ${chromeChannelError.message}` : "",
      chromeExecutableError
        ? `System Chrome executable failed: ${chromeExecutableError.message}`
        : "",
      `Playwright Chromium fallback failed: ${fallbackError.message}`,
    ]
      .filter(Boolean)
      .join(" | ");

    throw new Error(`Unable to launch a browser. ${details}`);
  }
}

function printHelp() {
  console.log(`Usage:
  scrape_profile --profile-url <url> [--max-items N] [--slow-mo MS] [--timeout-ms MS]

Options:
  --profile-url <url>   Required TikTok creator profile URL.
  --max-items <N>       Stop after collecting N video URLs. Default: ${DEFAULT_MAX_ITEMS}
  --slow-mo <MS>        Playwright slow motion delay. Default: ${DEFAULT_SLOW_MO_MS}
  --timeout-ms <MS>     Navigation timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}
  --help                Show this help text.
  --self-test           Run helper self-tests without launching a browser.

Output:
  Writes tiktok.{creator_id}.md into the current working directory.`);
}

function fail(message) {
  throw new Error(message);
}

function ensureStealthConfigured() {
  if (!stealthConfigured) {
    chromium.use(StealthPlugin());
    stealthConfigured = true;
  }
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function compactWhitespace(value) {
  return cleanText(value).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeProfileTitle(value) {
  return compactWhitespace(value).replace(/\s+created by .*$/i, "").trim();
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanWait(page, baseMs, jitterMs = 1200) {
  await page.waitForTimeout(baseMs + randomInt(0, jitterMs));
}

async function simulateUserPresence(page, step = 0) {
  const x = 320 + (step % 6) * 70 + randomInt(-25, 25);
  const y = 360 + (step % 5) * 55 + randomInt(-20, 20);
  await page.mouse.move(x, y, { steps: randomInt(8, 16) }).catch(() => {});
}

function escapeMarkdownCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return cleanText(value)
    .replace(/\n+/g, " <br> ")
    .replace(/[ \t]+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function normalizeNumberString(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.round(value));
  }

  const raw = cleanText(value).replace(/,/g, "");
  if (!raw) {
    return "";
  }

  const compactMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])$/i);
  if (compactMatch) {
    const amount = Number(compactMatch[1]);
    const unit = compactMatch[2].toUpperCase();
    const factor = unit === "K" ? 1e3 : unit === "M" ? 1e6 : 1e9;
    return String(Math.round(amount * factor));
  }

  const cnMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([万亿])$/);
  if (cnMatch) {
    const amount = Number(cnMatch[1]);
    const factor = cnMatch[2] === "万" ? 1e4 : 1e8;
    return String(Math.round(amount * factor));
  }

  if (/^[0-9]+$/.test(raw)) {
    return raw;
  }

  return raw;
}

function normalizeDuration(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const totalSeconds = Math.max(0, Math.round(value));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  const raw = cleanText(value);
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(":");
    if (parts.length === 2) {
      return `${parts[0].padStart(2, "0")}:${parts[1]}`;
    }
    return `${parts[0].padStart(2, "0")}:${parts[1]}:${parts[2]}`;
  }

  const textual = raw.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (textual && (textual[1] || textual[2] || textual[3])) {
    const hours = Number(textual[1] || 0);
    const minutes = Number(textual[2] || 0);
    const seconds = Number(textual[3] || 0);
    return normalizeDuration(hours * 3600 + minutes * 60 + seconds);
  }

  return raw;
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function normalizeDateValue(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    return formatUtcDate(new Date(millis));
  }

  const raw = cleanText(value);
  if (!raw) {
    return "";
  }

  if (/^\d{10,13}$/.test(raw)) {
    return normalizeDateValue(Number(raw));
  }

  const ymdMatch = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    return `${ymdMatch[1]}/${ymdMatch[2].padStart(2, "0")}/${ymdMatch[3].padStart(2, "0")}`;
  }

  const mdyMatch = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (mdyMatch) {
    return `${mdyMatch[3]}/${mdyMatch[1].padStart(2, "0")}/${mdyMatch[2].padStart(2, "0")}`;
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return formatUtcDate(new Date(parsed));
  }

  return raw;
}

function extractCreatorIdFromProfileUrl(rawUrl) {
  const normalized = ensureHttpsUrl(rawUrl);
  const url = new URL(normalized);
  const match = url.pathname.match(/\/@([^/?#]+)/);
  if (!match) {
    fail(`Could not derive a TikTok creator ID from profile URL: ${rawUrl}`);
  }
  return match[1];
}

function ensureHttpsUrl(rawUrl) {
  const input = cleanText(rawUrl);
  if (!input) {
    fail("Missing profile URL.");
  }
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  return `https://${input}`;
}

function normalizeVideoUrl(rawUrl, fallbackCreatorId = "") {
  if (!rawUrl) {
    return "";
  }

  const url = new URL(rawUrl, "https://www.tiktok.com");
  url.search = "";
  url.hash = "";
  const match = url.pathname.match(/\/@([^/?#]+)\/video\/(\d+)/);
  if (!match) {
    return url.toString();
  }
  const creatorId = match[1] || fallbackCreatorId;
  const videoId = match[2];
  return `https://www.tiktok.com/@${creatorId}/video/${videoId}`;
}

function extractVideoIdFromUrl(rawUrl) {
  const match = cleanText(rawUrl).match(/\/video\/(\d+)/);
  return match ? match[1] : "";
}

function dedupe(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function extractProfileVideoCandidatesFromText(text, fallbackCreatorId = "") {
  const source = cleanText(text);
  if (!source) {
    return [];
  }

  const pattern = /\/@([^/?#"'\s]+)\/video\/(\d+)/g;
  const matches = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const creatorId = match[1] || fallbackCreatorId;
    const videoId = match[2];
    const videoUrl = `https://www.tiktok.com/@${creatorId}/video/${videoId}`;
    matches.push({
      creatorId,
      videoId,
      videoUrl,
      hintTitle: "",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of matches) {
    if (seen.has(entry.videoUrl)) {
      continue;
    }
    seen.add(entry.videoUrl);
    deduped.push(entry);
  }

  return deduped;
}

function collectHashtagsFromText(text) {
  const matches = cleanText(text).match(/#[\p{L}\p{N}._-]+/gu);
  return dedupe(matches || []);
}

function collectHashtagsFromObjects(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return dedupe(
      value.flatMap((entry) => collectHashtagsFromObjects(entry)).filter(Boolean),
    );
  }

  if (typeof value === "string") {
    const hashtag = cleanText(value).replace(/^#?/, "#");
    return hashtag === "#" ? [] : [hashtag];
  }

  if (typeof value !== "object") {
    return [];
  }

  const directValues = [
    value.hashtagName,
    value.hashtag_name,
    value.tagName,
    value.tag_name,
    value.name,
  ]
    .map((entry) => cleanText(entry))
    .filter(Boolean)
    .map((entry) => (entry.startsWith("#") ? entry : `#${entry}`));

  const recursiveValues = [
    ...(value.textExtra || []),
    ...(value.challenges || []),
    ...(value.hashtags || []),
  ].flatMap((entry) => collectHashtagsFromObjects(entry));

  return dedupe([...directValues, ...recursiveValues]);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function deepWalk(root, visit, limit = 20000) {
  const stack = [root];
  const seen = new WeakSet();
  let iterations = 0;

  while (stack.length > 0 && iterations < limit) {
    iterations += 1;
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    visit(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    for (const child of Object.values(current)) {
      stack.push(child);
    }
  }
}

function looksLikeVideoEntity(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const id = value.id || value.awemeId || value.aweme_id || value.itemId;
  const hasStats = value.stats || value.statistics || value.statsV2;
  const hasAuthor = value.author || value.authorInfo || value.creator || value.authorInfoMap;
  const hasText =
    value.desc || value.description || value.title || value.textExtra || value.challenges;

  return Boolean(id) && Boolean(hasStats || hasAuthor || hasText);
}

function unwrapVideoEntity(value) {
  const candidates = [
    value,
    value?.itemStruct,
    value?.itemInfo?.itemStruct,
    value?.itemInfo,
    value?.videoData,
    value?.aweme_detail,
    value?.detail?.itemInfo?.itemStruct,
  ];

  return candidates.find((candidate) => looksLikeVideoEntity(candidate)) || null;
}

function normalizeCreatorHandle(value) {
  return cleanText(value).replace(/^@/, "");
}

function extractProfileBio(value) {
  return compactWhitespace(
    pickFirstNonEmpty(
      value?.signature,
      value?.bioDescription,
      value?.bio_description,
      value?.bio,
      value?.user?.signature,
      value?.user?.bioDescription,
      value?.user?.bio_description,
      value?.user?.bio,
      value?.profile?.signature,
      value?.profile?.bioDescription,
      value?.profile?.bio,
    ),
  );
}

function extractProfileFollowers(value) {
  return normalizeNumberString(
    pickFirstNonEmpty(
      value?.stats?.followerCount,
      value?.stats?.follower_count,
      value?.stats?.followers,
      value?.stats?.follower,
      value?.stats?.fans,
      value?.stats?.fansCount,
      value?.statistics?.followerCount,
      value?.statistics?.follower_count,
      value?.statistics?.followers,
      value?.statistics?.fans,
      value?.statsV2?.followerCount,
      value?.statsV2?.follower_count,
      value?.statsV2?.followers,
      value?.statsV2?.fans,
      value?.userInfo?.stats?.followerCount,
      value?.userInfo?.stats?.follower_count,
      value?.userInfo?.stats?.followers,
      value?.userInfo?.stats?.fans,
      value?.userStats?.followerCount,
      value?.userStats?.follower_count,
      value?.userStats?.followers,
      value?.userStats?.fans,
      value?.followerCount,
      value?.follower_count,
      value?.followers,
      value?.follower,
      value?.fans,
      value?.fansCount,
    ),
  );
}

function buildProfileMetaCandidate(value, fallbackCreatorId = "") {
  if (!value || typeof value !== "object") {
    return null;
  }

  const creatorId = normalizeCreatorHandle(
    pickFirstNonEmpty(
      value?.uniqueId,
      value?.unique_id,
      value?.user?.uniqueId,
      value?.user?.unique_id,
      value?.profile?.uniqueId,
      value?.profile?.unique_id,
      value?.author?.uniqueId,
      value?.author?.unique_id,
      value?.creator?.uniqueId,
      value?.creator?.unique_id,
      value?.userInfo?.user?.uniqueId,
      value?.userInfo?.user?.unique_id,
      fallbackCreatorId,
    ),
  );
  const bio = extractProfileBio(value);
  const followers = extractProfileFollowers(value);

  if (!bio && !followers) {
    return null;
  }

  return {
    creatorId,
    bio,
    followers,
  };
}

function scoreProfileMetaCandidate(candidate, targetCreatorId) {
  if (!candidate) {
    return -1;
  }

  let score = 0;
  const normalizedTarget = normalizeCreatorHandle(targetCreatorId);
  if (candidate.creatorId) {
    if (candidate.creatorId === normalizedTarget) {
      score += 50;
    } else {
      score -= 20;
    }
  }
  if (candidate.bio) {
    score += 10;
  }
  if (candidate.followers) {
    score += 10;
  }

  return score;
}

function mergeProfileMeta(...metas) {
  const merged = {
    bio: "",
    followers: "",
  };

  for (const meta of metas) {
    if (!meta) {
      continue;
    }

    merged.bio ||= compactWhitespace(meta.bio || "");
    merged.followers ||= normalizeNumberString(meta.followers || "");
  }

  return merged;
}

function extractProfileMetaFromRoots(roots, targetCreatorId) {
  let bestBio = { score: -1, value: "" };
  let bestFollowers = { score: -1, value: "" };

  for (const root of roots) {
    if (!root || typeof root !== "object") {
      continue;
    }

    deepWalk(root, (value) => {
      const candidate = buildProfileMetaCandidate(value);
      if (!candidate) {
        return;
      }

      const score = scoreProfileMetaCandidate(candidate, targetCreatorId);
      if (candidate.bio && score > bestBio.score) {
        bestBio = { score, value: candidate.bio };
      }
      if (candidate.followers && score > bestFollowers.score) {
        bestFollowers = { score, value: candidate.followers };
      }
    });
  }

  return {
    bio: bestBio.value,
    followers: bestFollowers.value,
  };
}

function buildRecordFromVideoEntity(entity, fallbackCreatorId, videoUrlHint = "") {
  const author = entity.author || entity.authorInfo || entity.creator || {};
  const stats = entity.stats || entity.statistics || entity.statsV2 || {};
  const creatorId = pickFirstNonEmpty(
    author.uniqueId,
    author.unique_id,
    author.authorId,
    author.id,
    fallbackCreatorId,
  ).replace(/^@/, "");
  const videoId = pickFirstNonEmpty(entity.id, entity.awemeId, entity.aweme_id, entity.itemId);
  const title = pickFirstNonEmpty(entity.desc, entity.description, entity.title);
  const videoUrl = normalizeVideoUrl(
    videoUrlHint || entity.videoUrl || entity.shareUrl || entity.canonicalUrl || "",
    creatorId,
  ) || (videoId && creatorId ? `https://www.tiktok.com/@${creatorId}/video/${videoId}` : "");

  return {
    videoId,
    title,
    creatorName: pickFirstNonEmpty(author.nickname, author.displayName, author.name),
    creatorId,
    publishTime: normalizeDateValue(
      pickFirstNonEmpty(entity.createTime, entity.create_time, entity.publishedAt),
    ),
    videoDuration: normalizeDuration(
      entity.video?.duration || entity.duration || entity.videoDuration || "",
    ),
    plays: normalizeNumberString(
      pickFirstNonEmpty(
        stats.playCount,
        stats.play_count,
        stats.play,
        stats.viewCount,
        stats.views,
      ),
    ),
    likeCount: normalizeNumberString(
      pickFirstNonEmpty(stats.diggCount, stats.likeCount, stats.likes, stats.digg_count),
    ),
    shareCount: normalizeNumberString(
      pickFirstNonEmpty(stats.shareCount, stats.shares, stats.share_count),
    ),
    commentCount: normalizeNumberString(
      pickFirstNonEmpty(stats.commentCount, stats.comments, stats.comment_count),
    ),
    collections: normalizeNumberString(
      pickFirstNonEmpty(stats.collectCount, stats.collect_count, stats.collectionCount),
    ),
    videoUrl,
    hashtags: dedupe([
      ...collectHashtagsFromObjects(entity.textExtra),
      ...collectHashtagsFromObjects(entity.challenges),
      ...collectHashtagsFromObjects(entity.hashtags),
      ...collectHashtagsFromText(title),
    ]),
  };
}

function scoreRecord(record, targetVideoId, targetVideoUrl) {
  let score = 0;
  if (record.videoId && targetVideoId && record.videoId === targetVideoId) {
    score += 100;
  }
  if (record.videoUrl && targetVideoUrl && record.videoUrl === targetVideoUrl) {
    score += 80;
  }

  const fields = [
    record.title,
    record.creatorName,
    record.creatorId,
    record.publishTime,
    record.videoDuration,
    record.plays,
    record.likeCount,
    record.shareCount,
    record.commentCount,
    record.collections,
  ];
  score += fields.filter(Boolean).length * 5;
  score += record.hashtags.length * 2;

  return score;
}

function mergeRecordParts(...records) {
  const merged = {
    title: "",
    creatorName: "",
    creatorId: "",
    publishTime: "",
    videoDuration: "",
    plays: "",
    likeCount: "",
    shareCount: "",
    commentCount: "",
    collections: "",
    videoUrl: "",
    hashtags: [],
    videoId: "",
  };

  for (const record of records) {
    if (!record) {
      continue;
    }

    merged.title ||= record.title || "";
    merged.creatorName ||= record.creatorName || "";
    merged.creatorId ||= record.creatorId || "";
    merged.publishTime ||= record.publishTime || "";
    merged.videoDuration ||= record.videoDuration || "";
    merged.plays ||= record.plays || "";
    merged.likeCount ||= record.likeCount || "";
    merged.shareCount ||= record.shareCount || "";
    merged.commentCount ||= record.commentCount || "";
    merged.collections ||= record.collections || "";
    merged.videoUrl ||= record.videoUrl || "";
    merged.videoId ||= record.videoId || "";
    merged.hashtags = dedupe([...(merged.hashtags || []), ...(record.hashtags || [])]);
  }

  return merged;
}

function extractRecordsFromRoots(roots, fallbackCreatorId) {
  const records = new Map();

  for (const root of roots) {
    if (!root || typeof root !== "object") {
      continue;
    }

    deepWalk(root, (value) => {
      const entity = unwrapVideoEntity(value);
      if (!entity) {
        return;
      }

      const record = buildRecordFromVideoEntity(entity, fallbackCreatorId);
      const key = record.videoId || record.videoUrl;
      if (!key) {
        return;
      }

      const existing = records.get(key);
      records.set(key, existing ? mergeRecordParts(existing, record) : record);
    });
  }

  return [...records.values()];
}

function extractRecordsFromPayloads(payloads, fallbackCreatorId) {
  const records = new Map();

  for (const payload of payloads) {
    const items = Array.isArray(payload?.itemList)
      ? payload.itemList
      : Array.isArray(payload?.data?.itemList)
        ? payload.data.itemList
        : [];

    for (const item of items) {
      const record = buildRecordFromVideoEntity(item, fallbackCreatorId);
      const key = record.videoId || record.videoUrl;
      if (!key) {
        continue;
      }

      const existing = records.get(key);
      records.set(key, existing ? mergeRecordParts(existing, record) : record);
    }
  }

  return [...records.values()];
}

function buildStructuredRoots(snapshot, payloads) {
  const roots = [];

  for (const text of Object.values(snapshot.scriptJson || {})) {
    try {
      roots.push(JSON.parse(text));
    } catch {
      // Ignore non-JSON script payloads.
    }
  }

  for (const text of snapshot.ldJson || []) {
    try {
      roots.push(JSON.parse(text));
    } catch {
      // Ignore invalid JSON-LD entries.
    }
  }

  for (const payload of payloads) {
    if (payload && typeof payload === "object") {
      roots.push(payload);
    }
  }

  return roots;
}

function buildProblemSummary(problems) {
  if (!problems || problems.length === 0) {
    return "None";
  }
  return problems.join(" | ");
}

function renderMarkdownReport(report) {
  const lines = [];
  lines.push("# TikTok Profile Export");
  lines.push("");
  lines.push(`- Source profile URL: ${escapeMarkdownCell(report.profileUrl)}`);
  lines.push(`- Creator ID: ${escapeMarkdownCell(report.creatorId)}`);
  lines.push(`- Bio: ${escapeMarkdownCell(report.bio)}`);
  lines.push(`- Followers: ${escapeMarkdownCell(report.followers)}`);
  lines.push(`- Scraped at: ${escapeMarkdownCell(report.scrapedAt)}`);
  lines.push(`- Status: ${escapeMarkdownCell(report.status)}`);
  lines.push(`- Video count: ${report.records.length}`);
  lines.push(`- Problems: ${escapeMarkdownCell(buildProblemSummary(report.problems))}`);
  lines.push("");
  lines.push(
    "| Video title | Creator name | Creator ID | Publish time | Video duration | Plays | Like count | Share count | Comment count | Collections | Video URL | Hashtags |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const record of report.records) {
    lines.push(
      `| ${escapeMarkdownCell(record.title)} | ${escapeMarkdownCell(record.creatorName)} | ${escapeMarkdownCell(record.creatorId)} | ${escapeMarkdownCell(record.publishTime)} | ${escapeMarkdownCell(record.videoDuration)} | ${escapeMarkdownCell(record.plays)} | ${escapeMarkdownCell(record.likeCount)} | ${escapeMarkdownCell(record.shareCount)} | ${escapeMarkdownCell(record.commentCount)} | ${escapeMarkdownCell(record.collections)} | ${escapeMarkdownCell(record.videoUrl)} | ${escapeMarkdownCell(record.hashtags.join(", "))} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    profileUrl: "",
    maxItems: DEFAULT_MAX_ITEMS,
    slowMo: DEFAULT_SLOW_MO_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (token === "--profile-url") {
      args.profileUrl = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--max-items") {
      args.maxItems = Number(argv[index + 1] || DEFAULT_MAX_ITEMS);
      index += 1;
      continue;
    }
    if (token === "--slow-mo") {
      args.slowMo = Number(argv[index + 1] || DEFAULT_SLOW_MO_MS);
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1] || DEFAULT_TIMEOUT_MS);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }

  return args;
}

async function maybeDismissDialogs(page) {
  const selectors = [
    '[data-e2e="modal-close-inner-button"]',
    'button[aria-label="Close"]',
    '[aria-label="Close"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 1000 }).catch(() => {});
    }
  }

  const buttonPatterns = [/not now/i, /maybe later/i, /close/i];
  for (const pattern of buttonPatterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 1000 }).catch(() => {});
    }
  }
}

async function detectBlocker(page) {
  const url = page.url();
  const diagnostics = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    return {
      bodyText: bodyText.slice(0, 4000).toLowerCase(),
    };
  });
  const bodyText = compactWhitespace(diagnostics.bodyText);

  if (url.includes("/login")) {
    return "Login wall redirected the page to /login.";
  }
  if (url.includes("/challenge")) {
    return "TikTok challenge page interrupted the run.";
  }
  if (bodyText.includes("log in to continue")) {
    return "Login wall asked for authentication to continue.";
  }
  if (bodyText.includes("sign up for tiktok")) {
    return "TikTok asked for sign-up before showing more content.";
  }
  if (bodyText.includes("drag the slider to fit the puzzle")) {
    return "TikTok challenge asked for slider verification.";
  }
  if (bodyText.includes("security verification")) {
    return "Security verification interrupted the page.";
  }
  if (bodyText.includes("maximum number of attempts reached")) {
    return "TikTok rate-limited or challenged the session.";
  }
  if (bodyText.includes("something went wrong")) {
    return "TikTok returned a page-level error.";
  }

  return "";
}

async function snapshotProfilePage(page, creatorId, payloads = []) {
  const snapshot = await page.evaluate((fallbackCreatorId) => {
    const pickText = (...selectors) => {
      for (const selector of selectors) {
        const text = document.querySelector(selector)?.textContent?.trim();
        if (text) {
          return text;
        }
      }
      return "";
    };
    const pickDataE2EText = (...patterns) => {
      const nodes = Array.from(document.querySelectorAll("[data-e2e]"));
      for (const node of nodes) {
        const key = (node.getAttribute("data-e2e") || "").toLowerCase();
        if (!key) {
          continue;
        }
        if (patterns.some((pattern) => key.includes(pattern))) {
          const text = node.textContent?.trim();
          if (text) {
            return text;
          }
        }
      }
      return "";
    };
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const links = anchors
      .map((anchor) => {
        const href = anchor.getAttribute("href") || "";
        const url = new URL(href, location.origin).toString();
        const match = url.match(/\/@([^/?#]+)\/video\/(\d+)/);
        const hintTitle =
          anchor.getAttribute("aria-label") ||
          anchor.querySelector("img")?.getAttribute("alt") ||
          anchor.textContent ||
          "";
        return {
          url,
          creatorId: match?.[1] || fallbackCreatorId || "",
          videoId: match?.[2] || "",
          hintTitle,
        };
      })
      .filter((entry) => entry.videoId);

    return {
      links,
      scrollHeight: document.body?.scrollHeight || 0,
      bodyText: (document.body?.innerText || "").slice(0, 4000),
      profileMeta: {
        bio:
          pickText('[data-e2e="user-bio"]', '[data-e2e="user-signature"]') ||
          pickDataE2EText("bio", "signature"),
        followers:
          pickText('[data-e2e="followers-count"]') ||
          pickDataE2EText("followers"),
      },
      scriptJson: {
        __UNIVERSAL_DATA_FOR_REHYDRATION__:
          document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "",
        SIGI_STATE: document.getElementById("SIGI_STATE")?.textContent || "",
        __NEXT_DATA__: document.getElementById("__NEXT_DATA__")?.textContent || "",
      },
    };
  }, creatorId);

  const scriptMatches = Object.values(snapshot.scriptJson || {}).flatMap((text) =>
    extractProfileVideoCandidatesFromText(text, creatorId),
  );
  const structuredRoots = buildStructuredRoots(
    { scriptJson: snapshot.scriptJson, ldJson: [] },
    payloads,
  );
  const structuredProfileMeta = extractProfileMetaFromRoots(structuredRoots, creatorId);
  const structuredRecords = [
    ...extractRecordsFromPayloads(payloads, creatorId),
    ...extractRecordsFromRoots(structuredRoots, creatorId),
  ];
  const structuredMatches = structuredRecords.map((record) => ({
    ...record,
    videoId: record.videoId || extractVideoIdFromUrl(record.videoUrl),
    videoUrl: normalizeVideoUrl(record.videoUrl, creatorId),
    hintTitle: sanitizeProfileTitle(record.title),
    seedRecord: record,
  }));
  const domMatches = snapshot.links.map((entry) => ({
    creatorId: entry.creatorId || creatorId,
    videoId: entry.videoId,
    videoUrl: normalizeVideoUrl(entry.url, creatorId),
    hintTitle: sanitizeProfileTitle(entry.hintTitle),
  }));

  return {
    links: [...structuredMatches, ...domMatches, ...scriptMatches],
    scrollHeight: snapshot.scrollHeight,
    bodyText: compactWhitespace(snapshot.bodyText),
    profileMeta: mergeProfileMeta(structuredProfileMeta, snapshot.profileMeta),
  };
}

function countProfileRecords(payloads, creatorId) {
  return extractRecordsFromPayloads(payloads, creatorId).length;
}

function countSeededCandidates(candidates) {
  return candidates.filter((candidate) => candidate?.seedRecord).length;
}

function hasEnoughStructuredData(candidates, payloads, creatorId, targetCount) {
  const required = Math.min(targetCount, candidates.length);
  if (required === 0) {
    return false;
  }

  const seededCount = countSeededCandidates(candidates);
  const payloadCount = countProfileRecords(payloads, creatorId);
  return seededCount >= required || payloadCount >= required;
}

function mergeCandidateEntry(seen, entry, creatorId) {
  const normalizedUrl = normalizeVideoUrl(entry.videoUrl || entry.url, creatorId);
  const key = entry.videoId || normalizedUrl;
  if (!key) {
    return;
  }

  if (!seen.has(key)) {
    seen.set(key, {
      videoId: entry.videoId || extractVideoIdFromUrl(normalizedUrl),
      videoUrl: normalizedUrl,
      hintTitle: sanitizeProfileTitle(entry.hintTitle || entry.title || ""),
      seedRecord: entry.seedRecord || null,
    });
    return;
  }

  const existing = seen.get(key);
  seen.set(key, {
    videoId: existing.videoId || entry.videoId || extractVideoIdFromUrl(normalizedUrl),
    videoUrl: existing.videoUrl || normalizedUrl,
    hintTitle: existing.hintTitle || sanitizeProfileTitle(entry.hintTitle || entry.title || ""),
    seedRecord: existing.seedRecord || entry.seedRecord || null,
  });
}

async function waitForProfileToWarm(page, creatorId, payloads = []) {
  let lastSnapshot = {
    links: [],
    scrollHeight: 0,
    bodyText: "",
  };
  let lastCount = 0;
  let stablePasses = 0;

  await humanWait(page, PROFILE_INITIAL_SETTLE_MS, 2000);

  for (let attempt = 0; attempt < PROFILE_INITIAL_POLL_ATTEMPTS; attempt += 1) {
    await maybeDismissDialogs(page);
    await simulateUserPresence(page, attempt);

    const blocker = await detectBlocker(page);
    if (blocker) {
      return {
        blocker,
        snapshot: lastSnapshot,
      };
    }

    lastSnapshot = await snapshotProfilePage(page, creatorId, payloads);
    const currentCount = Math.max(
      lastSnapshot.links.length,
      countProfileRecords(payloads, creatorId),
    );

    if (currentCount > 0) {
      if (
        currentCount === lastCount &&
        lastSnapshot.scrollHeight > 0 &&
        attempt > 0
      ) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }
    }

    lastCount = currentCount;

    if (currentCount > 0 && stablePasses >= PROFILE_STABLE_PASSES_REQUIRED) {
      return {
        blocker: "",
        snapshot: lastSnapshot,
      };
    }

    if (attempt < PROFILE_INITIAL_POLL_ATTEMPTS - 1) {
      await humanWait(page, PROFILE_POLL_INTERVAL_MS, 1500);
    }
  }

  return {
    blocker: "",
    snapshot: lastSnapshot,
  };
}

async function collectProfileCandidates(page, creatorId, maxItems, payloads = []) {
  const seen = new Map();
  let stagnantScrolls = 0;
  let lastHeight = 0;
  let stopReason = "";
  const maxScrolls = Math.max(20, maxItems * 3);

  for (let settleIndex = 0; settleIndex < PROFILE_STABLE_PASSES_REQUIRED; settleIndex += 1) {
    await maybeDismissDialogs(page);
    await simulateUserPresence(page, settleIndex);
    await humanWait(page, PROFILE_POLL_INTERVAL_MS, 1200);
    const snapshot = await snapshotProfilePage(page, creatorId, payloads);
    lastHeight = Math.max(lastHeight, snapshot.scrollHeight);
    for (const record of extractRecordsFromPayloads(payloads, creatorId)) {
      mergeCandidateEntry(
        seen,
        {
          videoId: record.videoId,
          videoUrl: record.videoUrl,
          hintTitle: record.title,
          seedRecord: record,
        },
        creatorId,
      );
    }
    for (const entry of snapshot.links) {
      mergeCandidateEntry(seen, entry, creatorId);
    }
    if (seen.size >= maxItems && hasEnoughStructuredData([...seen.values()], payloads, creatorId, maxItems)) {
      return {
        candidates: [...seen.values()].slice(0, maxItems),
        stopReason: `Reached max-items=${maxItems}.`,
        blocked: false,
      };
    }
  }

  for (let scrollIndex = 0; scrollIndex < maxScrolls; scrollIndex += 1) {
    await maybeDismissDialogs(page);
    await simulateUserPresence(page, scrollIndex);

    const blocker = await detectBlocker(page);
    if (blocker) {
      return {
        candidates: [...seen.values()],
        stopReason: blocker,
        blocked: true,
      };
    }

    const snapshot = await snapshotProfilePage(page, creatorId, payloads);

    const beforeCount = seen.size;
    for (const record of extractRecordsFromPayloads(payloads, creatorId)) {
      mergeCandidateEntry(
        seen,
        {
          videoId: record.videoId,
          videoUrl: record.videoUrl,
          hintTitle: record.title,
          seedRecord: record,
        },
        creatorId,
      );
    }
    for (const entry of snapshot.links) {
      mergeCandidateEntry(seen, entry, creatorId);
      if (seen.size >= maxItems && hasEnoughStructuredData([...seen.values()], payloads, creatorId, maxItems)) {
        stopReason = `Reached max-items=${maxItems}.`;
        break;
      }
    }

    if (seen.size >= maxItems && hasEnoughStructuredData([...seen.values()], payloads, creatorId, maxItems)) {
      break;
    }

    if (seen.size === beforeCount && snapshot.scrollHeight <= lastHeight) {
      stagnantScrolls += 1;
    } else {
      stagnantScrolls = 0;
    }

    if (stagnantScrolls >= STAGNANT_SCROLL_LIMIT) {
      stopReason = `Stopped after ${STAGNANT_SCROLL_LIMIT} scrolls without new videos.`;
      break;
    }

    lastHeight = Math.max(lastHeight, snapshot.scrollHeight);
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700));
    });
    await humanWait(page, SCROLL_PAUSE_MS, 1800);
  }

  return {
    candidates: [...seen.values()],
    stopReason,
    blocked: false,
  };
}

function buildJsonCollector() {
  const payloads = [];
  const profilePayloads = [];

  const onResponse = async (response) => {
    try {
      const headers = response.headers();
      const contentType = headers["content-type"] || headers["Content-Type"] || "";
      const url = response.url();
      if (!contentType.includes("json") && !url.includes("/api/")) {
        return;
      }

      const text = await response.text();
      const isProfileItemList = url.includes("/api/post/item_list/");
      if (!text || (!isProfileItemList && text.length > 2_000_000)) {
        return;
      }
      const parsed = JSON.parse(text);
      if (isProfileItemList) {
        profilePayloads.push(parsed);
        if (profilePayloads.length > 50) {
          profilePayloads.shift();
        }
      } else {
        payloads.push(parsed);
        if (payloads.length > 20) {
          payloads.shift();
        }
      }
    } catch {
      // Ignore non-JSON or inaccessible responses.
    }
  };

  return { payloads, profilePayloads, onResponse };
}


function buildProfileRecord(candidate, fallbackCreatorId) {
  const baseRecord = {
    title: sanitizeProfileTitle(candidate.hintTitle || ""),
    creatorName: "",
    creatorId: fallbackCreatorId,
    publishTime: "",
    videoDuration: "",
    plays: "",
    likeCount: "",
    shareCount: "",
    commentCount: "",
    collections: "",
    videoUrl: candidate.videoUrl,
    hashtags: collectHashtagsFromText(candidate.hintTitle || ""),
    videoId: candidate.videoId,
  };

  const record = mergeRecordParts(candidate.seedRecord || null, baseRecord);
  record.videoUrl = normalizeVideoUrl(record.videoUrl || candidate.videoUrl, record.creatorId || fallbackCreatorId);
  record.videoId ||= candidate.videoId || extractVideoIdFromUrl(record.videoUrl);
  record.creatorId ||= fallbackCreatorId;
  record.hashtags = dedupe(record.hashtags || []);
  return record;
}

function backfillCreatorFields(records, creatorId) {
  const resolvedCreatorId =
    creatorId || records.find((record) => record.creatorId)?.creatorId || "";
  const resolvedCreatorName =
    records.find((record) => record.creatorName)?.creatorName || "";

  return records.map((record) => ({
    ...record,
    creatorId: record.creatorId || resolvedCreatorId,
    creatorName: record.creatorName || resolvedCreatorName,
    videoUrl: normalizeVideoUrl(record.videoUrl, resolvedCreatorId),
  }));
}

async function writeMarkdownFile(report) {
  const outputPath = path.join(process.cwd(), `tiktok.${report.creatorId}.md`);
  await fs.writeFile(outputPath, renderMarkdownReport(report), "utf8");
  return outputPath;
}

async function runSelfTests() {
  assert.equal(
    extractCreatorIdFromProfileUrl("https://www.tiktok.com/@tech.panda.pro"),
    "tech.panda.pro",
  );
  assert.equal(normalizeNumberString("1.4M"), "1400000");
  assert.equal(normalizeNumberString("10,600"), "10600");
  assert.equal(normalizeDuration(41), "00:41");
  assert.equal(normalizeDateValue(1758844800), "2025/09/26");
  assert.equal(
    escapeMarkdownCell("hello | world\nsecond line"),
    "hello \\| world <br> second line",
  );

  const mockItem = {
    id: "7554241187679325471",
    desc: "Tesla's Biggest Worry #tesla #elonmusk",
    createTime: 1726617600,
    video: { duration: 80 },
    author: { uniqueId: "tech.panda.pro", nickname: "Hank" },
    stats: {
      playCount: 466400,
      diggCount: 69200,
      shareCount: 24800,
      commentCount: 3419,
      collectCount: 7849,
    },
    textExtra: [{ hashtagName: "tesla" }, { hashtagName: "elonmusk" }],
  };
  const record = buildRecordFromVideoEntity(
    mockItem,
    "tech.panda.pro",
    "https://www.tiktok.com/@tech.panda.pro/video/7554241187679325471",
  );
  assert.equal(record.creatorName, "Hank");
  assert.equal(record.creatorId, "tech.panda.pro");
  assert.equal(record.videoDuration, "01:20");
  assert.deepEqual(record.hashtags, ["#tesla", "#elonmusk"]);

  const markdown = renderMarkdownReport({
    profileUrl: "https://www.tiktok.com/@tech.panda.pro",
    creatorId: "tech.panda.pro",
    bio: "EV and AI commentary.",
    followers: "1400000",
    scrapedAt: "2026-03-09T00:00:00.000Z",
    status: "SUCCESS",
    problems: [],
    records: [record],
  });
  assert.match(markdown, /tiktok/);
  assert.match(markdown, /\| Video title \|/);

  console.log("Self-test passed.");
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.selfTest) {
    await runSelfTests();
    return;
  }

  if (!args.profileUrl) {
    printHelp();
    fail("Missing required --profile-url.");
  }

  const profileUrl = ensureHttpsUrl(args.profileUrl);
  const creatorId = extractCreatorIdFromProfileUrl(profileUrl);
  ensureStealthConfigured();
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tiktok-profile-extractor-"),
  );

  let context;
  let records = [];
  const problems = [];
  let status = "SUCCESS";
  let profileMeta = { bio: "", followers: "" };

  try {
    context = await launchBrowserContext(userDataDir, args);

    context.setDefaultTimeout(args.timeoutMs);
    context.setDefaultNavigationTimeout(args.timeoutMs);

    const profilePage = context.pages()[0] || (await context.newPage());
    const profileCollector = buildJsonCollector();
    profilePage.on("response", profileCollector.onResponse);
    await profilePage.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs,
    });
    const warmup = await waitForProfileToWarm(
      profilePage,
      creatorId,
      profileCollector.profilePayloads,
    );
    profileMeta = mergeProfileMeta(profileMeta, warmup.snapshot.profileMeta);
    if (warmup.blocker && warmup.snapshot.links.length === 0) {
      status = "BLOCKED";
      problems.push(warmup.blocker);
    } else {
      if (warmup.blocker) {
        problems.push(warmup.blocker);
      }
      const profileScan = await collectProfileCandidates(
        profilePage,
        creatorId,
        args.maxItems,
        profileCollector.profilePayloads,
      );

      if (profileScan.stopReason) {
        problems.push(profileScan.stopReason);
      }

      if (!profileMeta.bio || !profileMeta.followers) {
        const finalSnapshot = await snapshotProfilePage(
          profilePage,
          creatorId,
          profileCollector.profilePayloads,
        ).catch(() => null);
        profileMeta = mergeProfileMeta(profileMeta, finalSnapshot?.profileMeta);
      }

      if (profileScan.candidates.length === 0) {
        status = profileScan.blocked ? "BLOCKED" : "PARTIAL";
        if (!profileScan.stopReason) {
          problems.push("No visible video links were collected from the profile page.");
        }
      } else {
        const payloadRecords = extractRecordsFromPayloads(
          profileCollector.profilePayloads,
          creatorId,
        );
        const payloadRecordMap = new Map(
          payloadRecords.map((record) => [record.videoId || record.videoUrl, record]),
        );

        records = profileScan.candidates.slice(0, args.maxItems).map((candidate) =>
          buildProfileRecord(
            {
              ...candidate,
              seedRecord:
                payloadRecordMap.get(candidate.videoId) ||
                payloadRecordMap.get(candidate.videoUrl) ||
                candidate.seedRecord ||
                null,
            },
            creatorId,
          ),
        );

        if (status === "SUCCESS" && profileScan.blocked) {
          status = records.length > 0 ? "PARTIAL" : "BLOCKED";
        }
      }
    }
  } finally {
    records = backfillCreatorFields(records, creatorId);

    const report = {
      profileUrl,
      creatorId,
      bio: profileMeta.bio,
      followers: profileMeta.followers,
      scrapedAt: new Date().toISOString(),
      status,
      problems,
      records,
    };

    const outputPath = await writeMarkdownFile(report);
    console.log(`Wrote ${outputPath}`);
    console.log(`Status: ${status}`);
    if (problems.length > 0) {
      console.log(`Problems: ${buildProblemSummary(problems)}`);
    }

    if (context) {
      await context.close().catch(() => {});
    }
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
