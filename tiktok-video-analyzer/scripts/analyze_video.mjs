#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SLOW_MO_MS = 200;
const DEFAULT_WAIT_AFTER_NAV_MS = 7000;
const DEFAULT_MAX_COMMENTS = 80;
const DEFAULT_COMMENT_SCROLLS = 8;
const POLL_INTERVAL_MS = 2500;
const COMMENT_POLL_INTERVAL_MS = 2200;
const COMMENT_TAB_WAIT_MS = 25000;
const COMMENT_TAB_POLL_MS = 2000;
const MAX_POLL_ATTEMPTS = 8;
const MAX_FILENAME_LEN = 50;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const TEXT_KEYS = ["text", "content", "utterance", "sentence", "value", "transcript"];
const START_KEYS = ["start", "start_time", "startTime", "from", "begin", "startMs"];
const END_KEYS = ["end", "end_time", "endTime", "to", "endMs"];
const CAPTION_ARRAY_KEYS = [
  "subtitleInfos",
  "subtitleInfoList",
  "captions",
  "subtitles",
  "videoSubtitleList",
  "claSubtitleList",
];
const PREFERRED_LANGUAGE_PREFIXES = ["en", "zh", "ja", "ko"];
const QUESTION_PATTERNS = [
  /[?？]/,
  /\b(how|what|where|why|when|which|who|can|does|do|is)\b/i,
  /(怎么|怎样|如何|多少钱|多少|哪里|哪儿|在哪|能不能|可不可以|有没有|是否|需不需要)/,
];
const COMMENT_DISABLED_PATTERNS = [
  "comments are turned off",
  "comments are disabled",
  "comments disabled",
  "评论已关闭",
  "评论区已关闭",
  "commenting has been turned off",
];
const INTENT_RULES = [
  {
    tag: "purchase",
    patterns: [
      /(怎么买|怎么购买|哪里买|哪里购买|下单|购买链接|buy link|where .* buy|how .* buy)/i,
    ],
  },
  {
    tag: "price",
    patterns: [/(多少钱|价格|费用|收费|how much|price|cost)/i],
  },
  {
    tag: "contact",
    patterns: [/(联系方式|怎么联系|私信|dm me|contact|whatsapp|wechat|vx)/i],
  },
  {
    tag: "location",
    patterns: [/(地址|位置|在哪|哪里|where is|location|how .* get there)/i],
  },
  {
    tag: "how_to",
    patterns: [/(怎么做|怎么去|怎么弄|流程|步骤|攻略|how to|steps|process)/i],
  },
  {
    tag: "eligibility",
    patterns: [/(适合|资格|条件|requirements|eligible|who can)/i],
  },
  {
    tag: "timeline",
    patterns: [/(多久|时间|多久能|how long|timeline|wait time)/i],
  },
  {
    tag: "trust",
    patterns: [/(靠谱吗|真的假的|安全|risk|safe|legit|scam|trust)/i],
  },
];
const TOPIC_RULES = [
  { tag: "price", patterns: [/(多少钱|价格|费用|收费|how much|price|cost)/i] },
  { tag: "location", patterns: [/(地址|位置|在哪里|在哪|哪里|where|location|route)/i] },
  { tag: "process", patterns: [/(流程|步骤|怎么做|怎么办|怎么去|how to|process|step)/i] },
  { tag: "contact", patterns: [/(联系方式|私信|dm|contact|wechat|whatsapp|vx)/i] },
  { tag: "trust", patterns: [/(靠谱不|靠谱吗|真假|安全|safe|legit|real|scam)/i] },
  { tag: "eligibility", patterns: [/(条件|资格|适合|requirements|eligible|who can)/i] },
  { tag: "timeline", patterns: [/(多久|什么时候|时间|how long|when|timeline)/i] },
  { tag: "purchase", patterns: [/(怎么买|购买|下单|buy|order|book|reserve)/i] },
];

let stealthConfigured = false;

function printHelp() {
  console.log(`Usage:
  analyze_video --video-url <url> [--slow-mo MS] [--timeout-ms MS] [--headless] [--max-comments N] [--comment-scrolls N]

Options:
  --video-url <url>       Required TikTok video URL.
  --slow-mo <MS>          Playwright slow motion delay. Default: ${DEFAULT_SLOW_MO_MS}
  --timeout-ms <MS>       Navigation timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}
  --headless              Run Chromium headlessly instead of headed Chrome.
  --max-comments <N>      Stop after collecting N top-level comments. Default: ${DEFAULT_MAX_COMMENTS}
  --comment-scrolls <N>   Maximum comment-area scroll passes. Default: ${DEFAULT_COMMENT_SCROLLS}
  --self-test             Run helper self-tests without launching a browser.
  --help                  Show this help text.

Environment:
  TIKTOK_ANALYZER_PROXY / https_proxy / http_proxy / all_proxy

Output:
  Writes tiktok.{author}.{description}.md into the current working directory.`);
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

function dedupeHashtags(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
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

function ensureHttpsUrl(rawUrl) {
  const input = cleanText(rawUrl);
  if (!input) {
    fail("Missing video URL.");
  }
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  return `https://${input}`;
}

function extractVideoInfoFromUrl(rawUrl) {
  const url = new URL(ensureHttpsUrl(rawUrl));
  const match = url.pathname.match(/\/@([^/?#]+)\/video\/(\d+)/);
  if (!match) {
    fail(`Could not derive TikTok video info from URL: ${rawUrl}`);
  }
  return {
    creatorId: match[1],
    videoId: match[2],
    canonicalUrl: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
  };
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
  return `https://www.tiktok.com/@${match[1] || fallbackCreatorId}/video/${match[2]}`;
}

function extractHashtags(text) {
  return dedupe(cleanText(text).match(/#[\p{L}\p{N}._-]+/gu) || []);
}

function collectHashtagsFromObjects(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return dedupe(value.flatMap((entry) => collectHashtagsFromObjects(entry)));
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

function sanitizeFilename(name) {
  const sanitized = cleanText(name).replace(/[\\/:*?"<>|\n\r]/g, "").replace(/[. ]+$/g, "");
  return sanitized || "untitled";
}

function normalizeNumberString(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.round(value));
  }
  const raw = cleanText(value).replace(/,/g, "");
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
  return raw;
}

function formatNumber(value) {
  const normalized = normalizeNumberString(value);
  if (!normalized) {
    return "N/A";
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized).toLocaleString("en-US");
  }
  return normalized;
}

function normalizeDuration(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const totalSeconds = Math.max(0, Math.round(value));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  const raw = cleanText(value);
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(":");
    if (parts.length === 2) {
      return `${Number(parts[0])}:${parts[1]}`;
    }
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = parts[2];
    return `${hours * 60 + minutes}:${seconds}`;
  }
  return raw;
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
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
  if (/^\d{10,13}$/.test(raw)) {
    return normalizeDateValue(Number(raw));
  }
  const ymdMatch = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, "0")}-${ymdMatch[3].padStart(2, "0")}`;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return formatUtcDate(new Date(parsed));
  }
  return raw;
}

function normalizeLanguage(value) {
  const text = cleanText(value).toLowerCase();
  return text || "und";
}

function normalizeHandle(value) {
  return cleanText(value).replace(/^@/, "");
}

function deepWalk(root, visit, limit = 30000) {
  const stack = [{ value: root, parentKey: "" }];
  const seen = new WeakSet();
  let iterations = 0;

  while (stack.length > 0 && iterations < limit) {
    iterations += 1;
    const current = stack.pop();
    const { value, parentKey } = current;
    if (!value || typeof value !== "object") {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    visit(value, parentKey);

    if (Array.isArray(value)) {
      for (const child of value) {
        stack.push({ value: child, parentKey });
      }
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      stack.push({ value: child, parentKey: key });
    }
  }
}

function looksLikeVideoEntity(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const id = value.id || value.awemeId || value.aweme_id || value.itemId;
  const hasStats = value.stats || value.statistics || value.statsV2;
  const hasAuthor = value.author || value.authorInfo || value.creator;
  const hasText =
    value.desc || value.description || value.title || value.textExtra || value.challenges;
  return Boolean(id && (hasStats || hasAuthor || hasText));
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

function buildMetadataFromVideoEntity(entity, fallbackCreatorId = "") {
  const author = entity.author || entity.authorInfo || entity.creator || {};
  const stats = entity.stats || entity.statistics || entity.statsV2 || {};
  const creatorId = normalizeHandle(
    pickFirstNonEmpty(
      author.uniqueId,
      author.unique_id,
      author.authorId,
      author.id,
      fallbackCreatorId,
    ),
  );
  const description = pickFirstNonEmpty(entity.desc, entity.description, entity.title);

  return {
    author: creatorId ? `@${creatorId}` : "",
    authorName: pickFirstNonEmpty(author.nickname, author.displayName, author.name),
    creatorId,
    publishDate: normalizeDateValue(
      pickFirstNonEmpty(entity.createTime, entity.create_time, entity.publishedAt),
    ),
    duration: normalizeDuration(
      entity.video?.duration || entity.duration || entity.videoDuration || "",
    ),
    plays: normalizeNumberString(
      pickFirstNonEmpty(stats.playCount, stats.play_count, stats.viewCount, stats.views),
    ),
    likes: normalizeNumberString(
      pickFirstNonEmpty(stats.diggCount, stats.likeCount, stats.likes),
    ),
    comments: normalizeNumberString(
      pickFirstNonEmpty(stats.commentCount, stats.comment_count, stats.comments),
    ),
    reposts: normalizeNumberString(
      pickFirstNonEmpty(stats.repostCount, stats.repost_count, stats.shareCount, stats.shares),
    ),
    description,
    hashtags: dedupeHashtags([
      ...collectHashtagsFromObjects(entity.textExtra),
      ...collectHashtagsFromObjects(entity.challenges),
      ...collectHashtagsFromObjects(entity.hashtags),
      ...extractHashtags(description),
    ]),
    videoId: pickFirstNonEmpty(entity.id, entity.awemeId, entity.aweme_id, entity.itemId),
    videoUrl: normalizeVideoUrl(
      entity.videoUrl || entity.shareUrl || entity.canonicalUrl || "",
      creatorId || fallbackCreatorId,
    ),
  };
}

function mergeMetadata(...metas) {
  const merged = {
    author: "",
    authorName: "",
    creatorId: "",
    publishDate: "",
    duration: "",
    plays: "",
    likes: "",
    comments: "",
    reposts: "",
    description: "",
    hashtags: [],
    videoId: "",
    videoUrl: "",
  };

  for (const meta of metas) {
    if (!meta) {
      continue;
    }
    merged.author ||= meta.author || "";
    merged.authorName ||= meta.authorName || "";
    merged.creatorId ||= meta.creatorId || "";
    merged.publishDate ||= meta.publishDate || "";
    merged.duration ||= meta.duration || "";
    merged.plays ||= meta.plays || "";
    merged.likes ||= meta.likes || "";
    merged.comments ||= meta.comments || "";
    merged.reposts ||= meta.reposts || "";
    merged.description ||= meta.description || "";
    merged.videoId ||= meta.videoId || "";
    merged.videoUrl ||= meta.videoUrl || "";
    merged.hashtags = dedupeHashtags([...(merged.hashtags || []), ...(meta.hashtags || [])]);
  }

  return merged;
}

function scoreMetadata(meta, targetVideoId, targetVideoUrl) {
  let score = 0;
  if (meta.videoId && meta.videoId === targetVideoId) {
    score += 100;
  }
  if (meta.videoUrl && meta.videoUrl === targetVideoUrl) {
    score += 80;
  }
  score += [
    meta.author,
    meta.publishDate,
    meta.duration,
    meta.plays,
    meta.likes,
    meta.comments,
    meta.description,
  ].filter(Boolean).length * 5;
  return score;
}

function buildPageFallback(snapshot, targetInfo) {
  const creatorId = normalizeHandle(
    pickFirstNonEmpty(snapshot.pageCreatorId, targetInfo.creatorId),
  );
  const description = pickFirstNonEmpty(snapshot.metaDescription, snapshot.pageTitle)
    .replace(/\s*on TikTok\s*$/i, "")
    .trim();

  return {
    author: creatorId ? `@${creatorId}` : "",
    authorName: snapshot.pageAuthorName,
    creatorId,
    publishDate: "",
    duration: "",
    plays: "",
    likes: "",
    comments: "",
    reposts: "",
    description,
    hashtags: dedupeHashtags(extractHashtags(description)),
    videoId: targetInfo.videoId,
    videoUrl: targetInfo.canonicalUrl,
  };
}

function extractMetadataFromRoots(roots, targetInfo) {
  const candidates = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") {
      continue;
    }
    deepWalk(root, (value) => {
      const entity = unwrapVideoEntity(value);
      if (!entity) {
        return;
      }
      const meta = buildMetadataFromVideoEntity(entity, targetInfo.creatorId);
      if (meta.videoId || meta.videoUrl) {
        candidates.push(meta);
      }
    });
  }
  return candidates;
}

function maybeCaptionUrl(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }
  if (/^\/\//.test(text)) {
    return `https:${text}`;
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return "";
}

function inferExt(url, contentType = "") {
  const normalizedUrl = cleanText(url).toLowerCase();
  const normalizedType = cleanText(contentType).toLowerCase();
  if (normalizedType.includes("vtt") || normalizedUrl.includes(".vtt")) {
    return "vtt";
  }
  if (normalizedUrl.includes(".srt")) {
    return "srt";
  }
  if (normalizedType.includes("json") || normalizedUrl.includes(".json")) {
    return "json";
  }
  return "";
}

function normalizeTrack(rawTrack, source = "", parentKey = "") {
  if (!rawTrack || typeof rawTrack !== "object") {
    return null;
  }
  const url = maybeCaptionUrl(
    rawTrack.url ||
      rawTrack.Url ||
      rawTrack.subtitleUrl ||
      rawTrack.subtitle_url ||
      rawTrack.webvtt_url ||
      rawTrack.captionUrl ||
      rawTrack.src,
  );
  const body = cleanText(rawTrack.body || rawTrack.text);
  if (!url && !body) {
    return null;
  }
  const language = normalizeLanguage(
    rawTrack.languageCodeName ||
      rawTrack.languageCode ||
      rawTrack.lang ||
      rawTrack.locale ||
      rawTrack.LanguageCodeName ||
      rawTrack.name,
  );
  return {
    url,
    body,
    language,
    ext: cleanText(rawTrack.ext || rawTrack.format || rawTrack.mimeType) || inferExt(url),
    source,
    parentKey,
  };
}

function extractTracksFromRoots(roots) {
  const tracks = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") {
      continue;
    }
    deepWalk(root, (value, parentKey) => {
      if (!value || typeof value !== "object") {
        return;
      }
      for (const key of CAPTION_ARRAY_KEYS) {
        const maybeTracks = value[key];
        if (!Array.isArray(maybeTracks)) {
          continue;
        }
        for (const entry of maybeTracks) {
          const track = normalizeTrack(entry, "structured-data", key);
          if (track) {
            tracks.push(track);
          }
        }
      }
      if (/caption|subtitle|transcript/i.test(parentKey) && !Array.isArray(value)) {
        const track = normalizeTrack(value, "structured-data", parentKey);
        if (track) {
          tracks.push(track);
        }
      }
    });
  }
  return dedupeTracks(tracks);
}

function dedupeTracks(tracks) {
  const seen = new Set();
  const deduped = [];
  for (const track of tracks) {
    const key = `${track.url || ""}|${track.language}|${track.ext}|${track.body ? "body" : ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(track);
  }
  return deduped;
}

function buildStructuredRoots(snapshot, payloads) {
  const roots = [];
  for (const text of Object.values(snapshot.scriptJson || {})) {
    try {
      roots.push(JSON.parse(text));
    } catch {
      // Ignore invalid JSON.
    }
  }
  for (const payload of payloads) {
    if (payload && typeof payload === "object") {
      roots.push(payload);
    }
  }
  return roots;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanWait(page, baseMs, jitterMs = 1200) {
  await page.waitForTimeout(baseMs + randomInt(0, jitterMs));
}

async function simulateUserPresence(page, step = 0) {
  const x = 300 + (step % 6) * 70 + randomInt(-25, 25);
  const y = 320 + (step % 5) * 60 + randomInt(-20, 20);
  await page.mouse.move(x, y, { steps: randomInt(6, 14) }).catch(() => {});
}

function resolveProxy() {
  return (
    process.env.TIKTOK_ANALYZER_PROXY ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    ""
  );
}

function buildBrowserLaunchOptions(args, extra = {}) {
  const proxyServer = resolveProxy();
  return {
    headless: args.headless,
    slowMo: args.slowMo,
    locale: "en-US",
    viewport: { width: 1440, height: 960 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,960"],
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
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
    return await chromium.launchPersistentContext(userDataDir, buildBrowserLaunchOptions(args));
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

async function ensureCommentsTabOpen(page) {
  const deadline = Date.now() + COMMENT_TAB_WAIT_MS;

  while (Date.now() < deadline) {
    const candidates = [
      page.locator("button#comments").first(),
      page.locator('button[id="comments"]').first(),
      page.getByRole("button", { name: /^comments$/i }).first(),
      page.getByRole("button", { name: /评论/ }).first(),
    ];

    for (const locator of candidates) {
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const commentsReady = await page
        .waitForFunction(
          () => {
            const selectors = [
              '[data-e2e="comment-level-1"]',
              '[data-e2e="comment-username-1"]',
              '[class*="DivCommentListContainer"]',
              '[class*="DivCommentObjectWrapper"]',
              '[class*="DivCommentMain"]',
            ];
            return selectors.some((selector) => document.querySelector(selector));
          },
          { timeout: 6000 },
        )
        .then(() => true)
        .catch(() => false);

      if (!commentsReady) {
        await page.waitForTimeout(1000);
      }
      return true;
    }

    await maybeDismissDialogs(page);
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.35, 240));
    }).catch(() => {});
    await page.waitForTimeout(COMMENT_TAB_POLL_MS);
  }

  return false;
}

function isTransientEvaluationError(error) {
  const message = cleanText(error?.message || error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Frame was detached")
  );
}

async function evaluateWithRetry(page, pageFunction, arg, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (page.isClosed()) {
      throw new Error("Browser page closed before extraction completed.");
    }
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      return await page.evaluate(pageFunction, arg);
    } catch (error) {
      if (!isTransientEvaluationError(error) || attempt === attempts - 1) {
        throw error;
      }
      lastError = error;
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500 * (attempt + 1));
    }
  }
  throw lastError || new Error("Page evaluation failed.");
}

async function detectBlocker(page) {
  const url = page.url();
  const diagnostics = await evaluateWithRetry(page, () => {
    const bodyText = document.body?.innerText || "";
    return { bodyText: bodyText.slice(0, 5000).toLowerCase() };
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
  if (bodyText.includes("drag the slider to fit the puzzle")) {
    return "TikTok challenge asked for slider verification.";
  }
  if (bodyText.includes("security verification")) {
    return "Security verification interrupted the page.";
  }
  if (bodyText.includes("something went wrong")) {
    return "TikTok returned a page-level error.";
  }
  return "";
}

function buildResponseCollector() {
  const jsonPayloads = [];
  const subtitleResponses = [];

  const onResponse = async (response) => {
    try {
      const headers = response.headers();
      const contentType = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
      const url = response.url();
      if (contentType.includes("json") || url.includes("/api/")) {
        const text = await response.text();
        if (!text || text.length > 2_000_000) {
          return;
        }
        const parsed = JSON.parse(text);
        jsonPayloads.push(parsed);
        if (jsonPayloads.length > 60) {
          jsonPayloads.shift();
        }
        return;
      }

      if (
        contentType.includes("vtt") ||
        contentType.includes("srt") ||
        /caption|subtitle|transcript/i.test(url)
      ) {
        const text = await response.text();
        if (!text || text.length > 600_000) {
          return;
        }
        subtitleResponses.push({
          url,
          contentType,
          body: text,
        });
        if (subtitleResponses.length > 20) {
          subtitleResponses.shift();
        }
      }
    } catch {
      // Ignore inaccessible responses.
    }
  };

  return { jsonPayloads, subtitleResponses, onResponse };
}

function cleanDomCommentText(text) {
  return compactWhitespace(
    cleanText(text)
      .replace(/\b(pinned|reply|replies|like|likes)\b/gi, " ")
      .replace(/\s+/g, " "),
  );
}

async function snapshotVideoPage(page, targetInfo, maxComments = DEFAULT_MAX_COMMENTS) {
  return evaluateWithRetry(
    page,
    ({ info, limit }) => {
      const meta = (name, attr = "property") =>
        document.querySelector(`meta[${attr}="${name}"]`)?.getAttribute("content") || "";
      const title = document.title || "";
      const authorHandleMatch = location.pathname.match(/\/@([^/?#]+)\/video\/(\d+)/);
      const normalizeInlineText = (value) =>
        String(value || "")
          .replace(/\b(pinned|reply|replies|like|likes)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

      const textOf = (root, selectors) => {
        for (const selector of selectors) {
          const text = root.querySelector(selector)?.textContent?.trim();
          if (text) {
            return text;
          }
        }
        return "";
      };

      const getCommentRoots = () => {
        const selectors = [
          '[class*="DivCommentObjectWrapper"]',
          '[class*="DivCommentListContainer"] > div',
          '[data-e2e="comment-list-item"]',
        ];
        const roots = [];
        const seen = new Set();
        for (const selector of selectors) {
          for (const node of document.querySelectorAll(selector)) {
            if (!(node instanceof HTMLElement)) {
              continue;
            }
            if (seen.has(node)) {
              continue;
            }
            seen.add(node);
            roots.push(node);
          }
        }
        return roots.slice(0, limit * 3);
      };

      const domComments = getCommentRoots()
        .map((root) => {
          const authorLink = root.querySelector('a[href*="/@"]');
          const authorHref = authorLink?.getAttribute("href") || "";
          const authorFromHref = authorHref.match(/@([^/?#]+)/)?.[1] || "";
          const authorName =
            textOf(root, [
              '[data-e2e="comment-username-1"]',
              '[data-e2e*="comment-user"]',
              '[data-e2e*="comment-username"]',
              'a[href*="/@"]',
            ]) || authorFromHref;
          const text =
            textOf(root, [
              '[data-e2e="comment-level-1"]',
              '[data-e2e="comment-text"]',
              '[data-e2e*="comment-content"]',
              '[data-e2e*="comment-text"]',
            ]) || "";
          const likeText = textOf(root, [
            '[data-e2e*="like-count"]',
            'button[aria-label*="like"]',
            "strong",
          ]);
          const replyText = textOf(root, [
            '[data-e2e*="reply-count"]',
            '[data-e2e="comment-reply-1"]',
            '[data-e2e*="reply"]',
          ]);
          const timeText = textOf(root, [
            "time",
            '[data-e2e*="time"]',
            '[class*="DivCommentSubContentWrapper"]',
          ]);
          const rawText = normalizeInlineText(text);
          return {
            commentId:
              root.getAttribute("data-comment-id") ||
              root.getAttribute("data-e2e") ||
              `${normalizeInlineText(authorName)}|${rawText.slice(0, 80)}`,
            authorName: normalizeInlineText(authorName),
            authorId: authorFromHref,
            text: rawText,
            likeCount: likeText,
            replyCount: replyText,
            publishedTime: normalizeInlineText(timeText),
            isPinned: /pinned/i.test(root.textContent || ""),
          };
        })
        .filter((entry) => entry.text);

      return {
        pageTitle: title,
        metaDescription: meta("og:description") || meta("description", "name"),
        pageCreatorId: authorHandleMatch?.[1] || info.creatorId || "",
        pageAuthorName: meta("og:title").replace(/\s*on TikTok\s*$/i, "").trim(),
        bodyText: (document.body?.innerText || "").slice(0, 8000),
        domComments,
        scriptJson: {
          __UNIVERSAL_DATA_FOR_REHYDRATION__:
            document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "",
          SIGI_STATE: document.getElementById("SIGI_STATE")?.textContent || "",
          __NEXT_DATA__: document.getElementById("__NEXT_DATA__")?.textContent || "",
        },
      };
    },
    { info: targetInfo, limit: maxComments },
  );
}

async function waitForVideoPageData(page, targetInfo, collector, args) {
  let lastSnapshot = await snapshotVideoPage(page, targetInfo, args.maxComments);
  await humanWait(page, DEFAULT_WAIT_AFTER_NAV_MS, 2000);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await maybeDismissDialogs(page);
    await simulateUserPresence(page, attempt);

    const blocker = await detectBlocker(page);
    if (blocker) {
      return { blocker, snapshot: lastSnapshot };
    }

    lastSnapshot = await snapshotVideoPage(page, targetInfo, args.maxComments);
    const roots = buildStructuredRoots(lastSnapshot, collector.jsonPayloads);
    const metadataCandidates = extractMetadataFromRoots(roots, targetInfo);
    const tracks = extractTracksFromRoots(roots);
    const capturedTracks = collector.subtitleResponses.map((entry) => ({
      url: entry.url,
      body: entry.body,
      ext: inferExt(entry.url, entry.contentType),
      language: "und",
      source: "network-response",
      parentKey: "response",
    }));

    if (metadataCandidates.length > 0 && (tracks.length > 0 || capturedTracks.length > 0)) {
      return { blocker: "", snapshot: lastSnapshot };
    }

    if (attempt < MAX_POLL_ATTEMPTS - 1) {
      await humanWait(page, POLL_INTERVAL_MS, 1200);
    }
  }

  return { blocker: "", snapshot: lastSnapshot };
}

function chooseBestMetadata(snapshot, collector, targetInfo) {
  const roots = buildStructuredRoots(snapshot, collector.jsonPayloads);
  const candidates = extractMetadataFromRoots(roots, targetInfo);
  const fallback = buildPageFallback(snapshot, targetInfo);
  const bestCandidate = candidates
    .sort(
      (left, right) =>
        scoreMetadata(right, targetInfo.videoId, targetInfo.canonicalUrl) -
        scoreMetadata(left, targetInfo.videoId, targetInfo.canonicalUrl),
    )[0];
  const merged = mergeMetadata(bestCandidate, fallback, {
    videoId: targetInfo.videoId,
    videoUrl: targetInfo.canonicalUrl,
  });
  merged.author ||= merged.creatorId ? `@${merged.creatorId}` : "";
  merged.hashtags = dedupeHashtags(merged.hashtags || []);
  return merged;
}

function chooseTrack(snapshot, collector) {
  const roots = buildStructuredRoots(snapshot, collector.jsonPayloads);
  const structuredTracks = extractTracksFromRoots(roots);
  const responseTracks = collector.subtitleResponses.map((entry) => ({
    url: entry.url,
    body: entry.body,
    ext: inferExt(entry.url, entry.contentType),
    language: "und",
    source: "network-response",
    parentKey: "response",
  }));
  const tracks = dedupeTracks([...structuredTracks, ...responseTracks]);
  if (tracks.length === 0) {
    return null;
  }

  tracks.sort((left, right) => {
    const leftLangRank = PREFERRED_LANGUAGE_PREFIXES.findIndex((prefix) =>
      left.language.startsWith(prefix),
    );
    const rightLangRank = PREFERRED_LANGUAGE_PREFIXES.findIndex((prefix) =>
      right.language.startsWith(prefix),
    );
    const leftRank = leftLangRank === -1 ? PREFERRED_LANGUAGE_PREFIXES.length : leftLangRank;
    const rightRank = rightLangRank === -1 ? PREFERRED_LANGUAGE_PREFIXES.length : rightLangRank;
    const extRank = (track) => ({ vtt: 0, srt: 1, json: 2 }[inferExt(track.url, track.ext)] ?? 9);
    return leftRank - rightRank || extRank(left) - extRank(right);
  });

  return tracks[0];
}

async function fetchTrackBody(context, track) {
  if (track.body) {
    return { body: track.body, contentType: track.ext };
  }
  if (!track.url) {
    return { body: "", contentType: "" };
  }
  const response = await context.request.get(track.url, {
    failOnStatusCode: false,
    timeout: DEFAULT_TIMEOUT_MS,
  });
  if (!response.ok()) {
    throw new Error(`字幕下载失败: HTTP ${response.status()}`);
  }
  const headers = response.headers();
  return {
    body: await response.text(),
    contentType: headers["content-type"] || "",
  };
}

function parseTimestamp(value) {
  const raw = cleanText(value).replace(",", ".");
  const parts = raw.split(":");
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Number(minutes) * 60 + Number(seconds);
  }
  return Number.NaN;
}

function normalizeSegments(rawSegments) {
  const seen = new Set();
  const segments = [];
  for (const segment of rawSegments) {
    const text = compactWhitespace(segment.text);
    if (!text) {
      continue;
    }
    const key = `${segment.start ?? ""}|${segment.end ?? ""}|${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    segments.push({
      start: segment.start ?? null,
      end: segment.end ?? null,
      text,
    });
  }
  return segments;
}

function parseVtt(content) {
  const segments = [];
  const blocks = cleanText(content).split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2 || lines[0].toUpperCase().startsWith("WEBVTT")) {
      continue;
    }
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    if (!lines[timingIndex] || !lines[timingIndex].includes("-->")) {
      continue;
    }
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((entry) => entry.trim());
    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) {
      continue;
    }
    segments.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text });
  }
  return normalizeSegments(segments);
}

function parseSrt(content) {
  const segments = [];
  const blocks = cleanText(content).split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      continue;
    }
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    if (!lines[timingIndex] || !lines[timingIndex].includes("-->")) {
      continue;
    }
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((entry) => entry.trim());
    const text = lines.slice(timingIndex + 1).join(" ").trim();
    if (!text) {
      continue;
    }
    segments.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text });
  }
  return normalizeSegments(segments);
}

function parseGenericJsonSegments(value) {
  const segments = [];
  deepWalk(value, (node) => {
    if (Array.isArray(node) || !node || typeof node !== "object") {
      return;
    }
    let text = "";
    for (const key of TEXT_KEYS) {
      if (typeof node[key] === "string" && cleanText(node[key])) {
        text = cleanText(node[key]);
        break;
      }
    }
    if (!text) {
      return;
    }
    const rawStart = START_KEYS.map((key) => node[key]).find((entry) => entry !== undefined);
    const rawEnd = END_KEYS.map((key) => node[key]).find((entry) => entry !== undefined);
    const start =
      rawStart === undefined ? null : Number(rawStart) / (String(rawStart).length > 6 ? 1000 : 1);
    const end =
      rawEnd === undefined ? null : Number(rawEnd) / (String(rawEnd).length > 6 ? 1000 : 1);
    segments.push({ start, end, text });
  });
  return normalizeSegments(segments);
}

function parseJsonTranscript(content) {
  const payload = JSON.parse(content);
  for (const key of ["utterances", "segments", "captions", "body", "results", "events"]) {
    if (payload && payload[key]) {
      const segments = parseGenericJsonSegments(payload[key]);
      if (segments.length > 0) {
        return segments;
      }
    }
  }
  const segments = parseGenericJsonSegments(payload);
  if (segments.length > 0) {
    return segments;
  }
  throw new Error("字幕解析失败: 未能从 JSON 中提取文本片段");
}

async function extractTranscript(context, track) {
  const fetched = await fetchTrackBody(context, track);
  const body = fetched.body;
  const contentType = cleanText(fetched.contentType).toLowerCase();
  const ext = inferExt(track.url, contentType) || cleanText(track.ext).toLowerCase();

  let segments = [];
  if (ext === "vtt" || body.trim().startsWith("WEBVTT")) {
    segments = parseVtt(body);
  } else if (ext === "srt") {
    segments = parseSrt(body);
  } else {
    segments = parseJsonTranscript(body);
  }

  const transcript = segments.map((segment) => segment.text).join(" ").trim();
  if (!transcript) {
    fail("该视频没有可提取的平台字幕");
  }
  return transcript;
}

function looksLikeCommentEntity(value, parentKey = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const text = pickFirstNonEmpty(
    value.text,
    value.commentText,
    value.content,
    value.desc,
    value.replyCommentText,
    value.comment,
  );
  const user = value.user || value.author || value.userInfo || value.user_info || {};
  const hasUser =
    user.uniqueId ||
    user.unique_id ||
    user.nickname ||
    user.displayName ||
    user.name ||
    value.userName ||
    value.username;
  const hasStats =
    value.diggCount !== undefined ||
    value.digg_count !== undefined ||
    value.likeCount !== undefined ||
    value.replyCount !== undefined ||
    value.reply_comment_total !== undefined ||
    value.replyCommentTotal !== undefined;
  const hasId = value.cid || value.commentId || value.comment_id || value.id;
  const commentishParent = /comment/i.test(parentKey);
  const looksLikeVideo = looksLikeVideoEntity(value);
  return Boolean(
    !looksLikeVideo &&
      text &&
      (hasUser || hasStats) &&
      (hasId || hasStats || commentishParent),
  );
}

function detectQuestion(text) {
  const source = cleanText(text);
  return QUESTION_PATTERNS.some((pattern) => pattern.test(source));
}

function matchTags(text, rules) {
  const source = cleanText(text);
  return dedupe(
    rules.filter((rule) => rule.patterns.some((pattern) => pattern.test(source))).map((rule) => rule.tag),
  );
}

function detectIntentTags(text) {
  return matchTags(text, INTENT_RULES);
}

function detectTopicTags(text) {
  return matchTags(text, TOPIC_RULES);
}

function normalizeCountFromMixedText(value) {
  const raw = cleanText(value);
  if (!raw) {
    return "";
  }
  if (/^(reply|replies|回复)$/i.test(raw)) {
    return "";
  }
  const direct = normalizeNumberString(raw);
  if (direct && /^\d+$/.test(direct)) {
    return direct;
  }
  const match = raw.match(/([0-9]+(?:[.,][0-9]+)?\s*[KMB万亿]?)/i);
  return match ? normalizeNumberString(match[1]) : "";
}

function buildCommentFromEntity(entity) {
  const user =
    entity.user ||
    entity.author ||
    entity.userInfo?.user ||
    entity.userInfo ||
    entity.user_info?.user ||
    entity.user_info ||
    {};
  const text = compactWhitespace(
    pickFirstNonEmpty(
      entity.text,
      entity.commentText,
      entity.content,
      entity.desc,
      entity.replyCommentText,
      entity.comment,
    ),
  );
  if (!text) {
    return null;
  }

  const authorId = normalizeHandle(
    pickFirstNonEmpty(
      user.uniqueId,
      user.unique_id,
      user.secUid,
      user.sec_uid,
      entity.userName,
      entity.username,
    ),
  );
  const authorName = pickFirstNonEmpty(
    user.nickname,
    user.displayName,
    user.name,
    entity.userName,
    entity.username,
    authorId,
  );
  const likeCount = normalizeNumberString(
    pickFirstNonEmpty(
      entity.diggCount,
      entity.digg_count,
      entity.likeCount,
      entity.likes,
      entity.stats?.diggCount,
      entity.stats?.likeCount,
    ),
  );
  const replyCount = normalizeNumberString(
    pickFirstNonEmpty(
      entity.replyCommentTotal,
      entity.reply_comment_total,
      entity.replyCount,
      entity.reply_count,
      entity.replyTotal,
    ),
  );
  const publishedTime = normalizeDateValue(
    pickFirstNonEmpty(
      entity.createTime,
      entity.create_time,
      entity.time,
      entity.commentTime,
      entity.comment_time,
      entity.publishedAt,
    ),
  );
  const commentId = pickFirstNonEmpty(entity.cid, entity.commentId, entity.comment_id, entity.id);

  return {
    commentId,
    authorName: compactWhitespace(authorName),
    authorId,
    text,
    likeCount,
    replyCount,
    publishedTime,
    isPinned: Boolean(
      entity.isPinned ||
        entity.pinned ||
        entity.pin ||
        entity.sticky ||
        entity.top ||
        entity.label?.toLowerCase?.() === "pinned",
    ),
    isQuestion: detectQuestion(text),
    intentTags: detectIntentTags(text),
    topicTags: detectTopicTags(text),
  };
}

function buildCommentFromDom(entry) {
  const text = compactWhitespace(entry.text);
  if (!text) {
    return null;
  }
  if (!entry.authorName && !entry.authorId) {
    return null;
  }
  return {
    commentId: cleanText(entry.commentId),
    authorName: compactWhitespace(entry.authorName),
    authorId: normalizeHandle(entry.authorId),
    text,
    likeCount: normalizeCountFromMixedText(entry.likeCount),
    replyCount: normalizeCountFromMixedText(entry.replyCount),
    publishedTime: normalizeDateValue(entry.publishedTime),
    isPinned: Boolean(entry.isPinned),
    isQuestion: detectQuestion(text),
    intentTags: detectIntentTags(text),
    topicTags: detectTopicTags(text),
  };
}

function commentAuthorKey(comment) {
  return (
    normalizeHandle(comment.authorId) ||
    normalizeHandle(comment.authorName) ||
    cleanText(comment.authorName).toLowerCase()
  );
}

function hasStableCommentId(comment) {
  const id = cleanText(comment.commentId);
  return Boolean(id) && /^\d{6,}$/.test(id);
}

function commentKey(comment) {
  const authorKey = commentAuthorKey(comment);
  const textKey = cleanText(comment.text).toLowerCase();
  if (authorKey && textKey) {
    return `${authorKey}|${textKey}`;
  }
  if (hasStableCommentId(comment)) {
    return cleanText(comment.commentId);
  }
  return textKey;
}

function mergeCountValue(left, right) {
  const leftValue = normalizeNumberString(left);
  const rightValue = normalizeNumberString(right);
  if (!leftValue) {
    return rightValue;
  }
  if (!rightValue) {
    return leftValue;
  }
  return Number(leftValue) >= Number(rightValue) ? leftValue : rightValue;
}

function mergeComments(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    commentId: left.commentId || right.commentId || "",
    authorName: left.authorName || right.authorName || "",
    authorId: left.authorId || right.authorId || "",
    text: left.text || right.text || "",
    likeCount: mergeCountValue(left.likeCount, right.likeCount),
    replyCount: mergeCountValue(left.replyCount, right.replyCount),
    publishedTime: left.publishedTime || right.publishedTime || "",
    isPinned: Boolean(left.isPinned || right.isPinned),
    isQuestion: Boolean(left.isQuestion || right.isQuestion),
    intentTags: dedupe([...(left.intentTags || []), ...(right.intentTags || [])]),
    topicTags: dedupe([...(left.topicTags || []), ...(right.topicTags || [])]),
  };
}

function extractCommentsFromRoots(roots) {
  const comments = new Map();
  for (const root of roots) {
    if (!root || typeof root !== "object") {
      continue;
    }
    deepWalk(root, (value, parentKey) => {
      if (!looksLikeCommentEntity(value, parentKey)) {
        return;
      }
      const comment = buildCommentFromEntity(value);
      if (!comment) {
        return;
      }
      const key = commentKey(comment);
      comments.set(key, mergeComments(comments.get(key), comment));
    });
  }
  return [...comments.values()];
}

function extractCommentsFromSnapshot(snapshot, collector) {
  const roots = buildStructuredRoots(snapshot, collector.jsonPayloads);
  const structured = extractCommentsFromRoots(roots);
  const dom = (snapshot.domComments || []).map((entry) => buildCommentFromDom(entry)).filter(Boolean);
  const merged = new Map();
  for (const comment of [...structured, ...dom]) {
    const key = commentKey(comment);
    merged.set(key, mergeComments(merged.get(key), comment));
  }
  return [...merged.values()];
}

function isLowSignalComment(text) {
  const source = cleanText(text);
  if (!source) {
    return true;
  }
  const stripped = source.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.!?,，。！？]/gu, "");
  return stripped.length < 3;
}

function scoreComment(comment) {
  const likeCount = Number(normalizeNumberString(comment.likeCount) || 0);
  const replyCount = Number(normalizeNumberString(comment.replyCount) || 0);
  let score = 0;
  if (comment.isPinned) {
    score += 100;
  }
  score += Math.min(likeCount, 10000) / 40;
  score += Math.min(replyCount, 1000) / 8;
  if (comment.isQuestion) {
    score += 8;
  }
  score += (comment.intentTags || []).length * 5;
  score += (comment.topicTags || []).length * 3;
  if (comment.text.length >= 24) {
    score += 6;
  }
  if (isLowSignalComment(comment.text)) {
    score -= 20;
  }
  return score;
}

function sortCommentsForDisplay(comments) {
  return [...comments].sort((left, right) => {
    return (
      scoreComment(right) - scoreComment(left) ||
      Number(normalizeNumberString(right.likeCount) || 0) -
        Number(normalizeNumberString(left.likeCount) || 0) ||
      Number(normalizeNumberString(right.replyCount) || 0) -
        Number(normalizeNumberString(left.replyCount) || 0) ||
      right.text.length - left.text.length
    );
  });
}

function findCommentProblems(snapshot) {
  const body = cleanText(snapshot.bodyText).toLowerCase();
  if (!body) {
    return "";
  }
  if (COMMENT_DISABLED_PATTERNS.some((pattern) => body.includes(pattern))) {
    return "Comments are unavailable or turned off on the page.";
  }
  return "";
}

async function scrollComments(page) {
  await page.evaluate(() => {
    const selectors = [
      '[data-e2e="comment-list"]',
      '[data-e2e*="comment-list"]',
      '[class*="CommentListContainer"]',
      '[class*="DivCommentListContainer"]',
      '[class*="CommentContainer"]',
    ];
    const candidates = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        candidates.push(node);
      }
    }
    const scrollable = candidates
      .filter((node) => node.scrollHeight > node.clientHeight + 100)
      .sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
    if (scrollable) {
      scrollable.scrollBy(0, Math.max(scrollable.clientHeight * 0.9, 600));
      return;
    }
    window.scrollBy(0, Math.max(window.innerHeight * 0.8, 700));
  });
}

function summarizeQuestionThemes(comments) {
  const groups = new Map();
  const seenExamples = new Set();
  for (const comment of comments.filter((entry) => entry.isQuestion)) {
    const tags = comment.topicTags.length > 0 ? comment.topicTags : comment.intentTags;
    const groupTags = tags.length > 0 ? tags.slice(0, 2) : ["general"];
    for (const tag of groupTags) {
      const group = groups.get(tag) || { topic: tag, count: 0, examples: [] };
      group.count += 1;
      const exampleKey = `${tag}|${commentAuthorKey(comment)}|${cleanText(comment.text).toLowerCase()}`;
      if (group.examples.length < 3 && !seenExamples.has(exampleKey)) {
        group.examples.push(comment);
        seenExamples.add(exampleKey);
      }
      groups.set(tag, group);
    }
  }
  return [...groups.values()].sort((left, right) => right.count - left.count).slice(0, 5);
}

function buildConversionSignal(comments) {
  let strong = 0;
  let medium = 0;
  let negative = 0;
  const evidence = [];

  for (const comment of comments) {
    const text = cleanText(comment.text).toLowerCase();
    const tags = new Set(comment.intentTags || []);
    const hasStrongIntent =
      tags.has("purchase") || tags.has("contact") || tags.has("price") || tags.has("location");
    const hasMediumIntent = hasStrongIntent || tags.has("how_to") || tags.has("timeline");
    const hasNegativeIntent =
      tags.has("trust") || /(太贵|不靠谱|骗局|scam|too expensive|fake|not safe)/i.test(text);

    if (hasStrongIntent) {
      strong += 1;
      if (evidence.length < 4) {
        evidence.push(comment);
      }
    } else if (hasMediumIntent) {
      medium += 1;
      if (evidence.length < 4) {
        evidence.push(comment);
      }
    }

    if (hasNegativeIntent) {
      negative += 1;
    }
  }

  let level = "弱";
  if (strong >= 3 || (strong >= 1 && medium >= 4)) {
    level = "强";
  } else if (strong >= 1 || medium >= 3) {
    level = "中";
  }

  const reasons = [];
  if (strong > 0) {
    reasons.push(`出现 ${strong} 条带有价格、联系方式、地点或购买动作的强意图评论。`);
  }
  if (medium > 0) {
    reasons.push(`出现 ${medium} 条围绕流程、时间或操作方式的行动前问题。`);
  }
  if (negative > 0) {
    reasons.push(`同时存在 ${negative} 条与信任或风险相关的疑虑评论。`);
  }
  if (reasons.length === 0) {
    reasons.push("评论区以围观、情绪表达或泛兴趣互动为主，缺少明确转化动作。");
  }

  return {
    level,
    strongCount: strong,
    mediumCount: medium,
    negativeCount: negative,
    reasons,
    evidence,
  };
}

function buildInsightBullets(metadata, comments, questionThemes, conversionSignal) {
  const bullets = [];
  if (comments.length < 5) {
    bullets.push("评论样本较少，洞见以当前可见评论为准，不做强结论。");
  }
  if (questionThemes.length > 0) {
    const topThemes = questionThemes
      .slice(0, 2)
      .map((entry) => `${entry.topic}（${entry.count}）`)
      .join("、");
    bullets.push(`用户提问主要集中在 ${topThemes}，说明评论区更关注可执行信息而不是单纯围观。`);
  } else {
    bullets.push("当前可见评论里明确问题较少，互动更偏情绪表达、赞叹或轻量反馈。");
  }
  if (conversionSignal.level === "强") {
    bullets.push("评论区已经出现较明确的咨询或购买前动作，视频具备较强的转化导向信号。");
  } else if (conversionSignal.level === "中") {
    bullets.push("评论区存在不少行动前问题，说明用户有兴趣，但仍在补齐价格、流程或联系方式等信息。");
  } else {
    bullets.push("这条视频当前更像兴趣触发或种草内容，评论区还没有形成明显的成交前动作。");
  }
  if (metadata.hashtags.length > 0) {
    bullets.push(`视频标签集中在 ${metadata.hashtags.slice(0, 4).join(" ")}，评论问题可以优先围绕这些主题补充解释。`);
  }
  return dedupe(bullets).slice(0, 4);
}

function buildCommentSummary(metadata, comments, problems, status) {
  const sortedComments = sortCommentsForDisplay(comments);
  const hotComments = sortedComments.slice(0, 5);
  const questionThemes = summarizeQuestionThemes(sortedComments);
  const conversionSignal = buildConversionSignal(sortedComments);
  const insightBullets = buildInsightBullets(
    metadata,
    sortedComments,
    questionThemes,
    conversionSignal,
  );
  return {
    status,
    sampleCount: comments.length,
    hotComments,
    questionThemes,
    conversionSignal,
    insightBullets,
    problems,
  };
}

async function collectCommentEvidence(page, targetInfo, collector, args, metadata) {
  const seen = new Map();
  const problems = [];
  let lastCount = 0;
  let stagnantPasses = 0;
  let blocker = "";

  await maybeDismissDialogs(page);
  const commentTabOpened = await ensureCommentsTabOpen(page);
  if (!commentTabOpened) {
    problems.push("Comments tab did not appear before the wait limit.");
  }
  let lastSnapshot = await snapshotVideoPage(page, targetInfo, args.maxComments);

  await humanWait(page, COMMENT_POLL_INTERVAL_MS, 800);

  for (let attempt = 0; attempt < args.commentScrolls; attempt += 1) {
    await maybeDismissDialogs(page);
    if (seen.size === 0) {
      await ensureCommentsTabOpen(page);
    }
    await simulateUserPresence(page, attempt);

    blocker = await detectBlocker(page);
    if (blocker) {
      break;
    }

    lastSnapshot = await snapshotVideoPage(page, targetInfo, args.maxComments);
    const comments = extractCommentsFromSnapshot(lastSnapshot, collector);
    for (const comment of comments) {
      const key = commentKey(comment);
      seen.set(key, mergeComments(seen.get(key), comment));
    }

    if (seen.size >= args.maxComments) {
      problems.push(`Reached max-comments=${args.maxComments}.`);
      break;
    }

    if (seen.size === lastCount) {
      stagnantPasses += 1;
    } else {
      stagnantPasses = 0;
    }
    lastCount = seen.size;

    if (stagnantPasses >= 2 && seen.size > 0) {
      break;
    }

    await scrollComments(page).catch(() => {});
    await humanWait(page, COMMENT_POLL_INTERVAL_MS, 1000);
  }

  const disabledReason = findCommentProblems(lastSnapshot);
  if (disabledReason) {
    problems.push(disabledReason);
  }
  if (blocker) {
    problems.push(blocker);
  }

  const comments = sortCommentsForDisplay([...seen.values()]).slice(0, args.maxComments);
  const normalizedCommentCount = Number(normalizeNumberString(metadata.comments) || 0);

  let status = "SUCCESS";
  if (comments.length === 0) {
    if (blocker) {
      status = "BLOCKED";
    } else if (normalizedCommentCount > 0) {
      status = "PARTIAL";
      problems.push("No visible top-level comments were collected from the page.");
    } else {
      status = "SUCCESS";
    }
  } else if (blocker) {
    status = "PARTIAL";
  }

  return {
    status,
    comments,
    problems: dedupe(problems),
    summary: buildCommentSummary(metadata, comments, dedupe(problems), status),
  };
}

function formatCommentLine(comment) {
  const parts = [];
  if (comment.isPinned) {
    parts.push("置顶");
  }
  if (comment.likeCount) {
    parts.push(`赞 ${formatNumber(comment.likeCount)}`);
  }
  if (comment.replyCount) {
    parts.push(`回复 ${formatNumber(comment.replyCount)}`);
  }
  if (comment.authorName || comment.authorId) {
    parts.push(`@${comment.authorId || comment.authorName}`);
  }
  const prefix = parts.length > 0 ? `[${parts.join(" | ")}] ` : "";
  return `- ${prefix}${compactWhitespace(comment.text)}`;
}

function buildMarkdown(report) {
  const { metadata, caption, commentEvidence, status } = report;
  const lines = [
    "# TikTok 视频分析",
    "",
    "## 基本信息",
    `- 报告状态: ${status}`,
    `- 作者: ${metadata.author || metadata.authorName || "未知"}`,
    `- 发布时间: ${metadata.publishDate || "N/A"}`,
    `- 视频时长: ${metadata.duration || "N/A"}`,
    `- 播放量: ${formatNumber(metadata.plays)}`,
    `- 点赞数: ${formatNumber(metadata.likes)}`,
    `- 评论数: ${formatNumber(metadata.comments)}`,
    `- 转发数: ${formatNumber(metadata.reposts)}`,
    `- 视频链接: ${metadata.videoUrl || "N/A"}`,
    "",
    "## 视频描述",
    metadata.description || "（无描述）",
    "",
  ];

  if (metadata.hashtags && metadata.hashtags.length > 0) {
    lines.push("## Hashtags");
    lines.push(metadata.hashtags.join(" "));
    lines.push("");
  }

  lines.push("## 口播文案");
  lines.push(caption || "（无口播文案）");
  lines.push("");
  lines.push("## 评论区概览");
  lines.push(`- 评论分析状态: ${commentEvidence.status}`);
  lines.push(`- 样本评论数: ${commentEvidence.summary.sampleCount}`);
  if (commentEvidence.summary.questionThemes.length > 0) {
    lines.push(
      `- 核心问题主题: ${commentEvidence.summary.questionThemes
        .map((entry) => `${entry.topic} (${entry.count})`)
        .join(", ")}`,
    );
  } else {
    lines.push("- 核心问题主题: 暂无明确聚类");
  }
  lines.push(
    `- 问题或限制: ${
      commentEvidence.problems.length > 0 ? commentEvidence.problems.join(" | ") : "None"
    }`,
  );
  lines.push("");
  lines.push("## 核心热评");
  if (commentEvidence.summary.hotComments.length > 0) {
    for (const comment of commentEvidence.summary.hotComments) {
      lines.push(formatCommentLine(comment));
    }
  } else {
    lines.push("- 暂无可展示的热评。");
  }
  lines.push("");
  lines.push("## 用户最关心的问题");
  if (commentEvidence.summary.questionThemes.length > 0) {
    for (const theme of commentEvidence.summary.questionThemes) {
      const examples = theme.examples
        .slice(0, 2)
        .map((entry) => compactWhitespace(entry.text))
        .join(" | ");
      lines.push(`- ${theme.topic}: ${theme.count} 条问题。代表评论: ${examples}`);
    }
  } else {
    lines.push("- 当前可见评论中没有足够多的明确问题。");
  }
  lines.push("");
  lines.push("## 洞见总结");
  for (const bullet of commentEvidence.summary.insightBullets) {
    lines.push(`- ${bullet}`);
  }
  lines.push("");
  lines.push("## 转化信号判断");
  lines.push(`- 转化信号等级: ${commentEvidence.summary.conversionSignal.level}`);
  for (const reason of commentEvidence.summary.conversionSignal.reasons) {
    lines.push(`- ${reason}`);
  }
  if (commentEvidence.summary.conversionSignal.evidence.length > 0) {
    lines.push("- 代表性信号评论:");
    for (const comment of commentEvidence.summary.conversionSignal.evidence.slice(0, 3)) {
      lines.push(formatCommentLine(comment));
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function buildFilename(metadata) {
  const author = sanitizeFilename(metadata.creatorId || metadata.authorName || "unknown");
  let description = sanitizeFilename((metadata.description || "untitled").split("\n")[0]);
  if (description.length > MAX_FILENAME_LEN) {
    description = description.slice(0, MAX_FILENAME_LEN);
  }
  return `tiktok.${author}.${description}.md`;
}

async function writeMarkdown(report) {
  const outputDir = process.cwd();
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, buildFilename(report.metadata));
  const markdown = buildMarkdown(report);
  await fs.writeFile(outputPath, markdown, "utf8");
  return { outputPath, markdown };
}

function parseArgs(argv) {
  const args = {
    videoUrl: "",
    slowMo: DEFAULT_SLOW_MO_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headless: false,
    maxComments: DEFAULT_MAX_COMMENTS,
    commentScrolls: DEFAULT_COMMENT_SCROLLS,
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
    if (token === "--headless") {
      args.headless = true;
      continue;
    }
    if (token === "--video-url") {
      args.videoUrl = argv[index + 1] || "";
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
    if (token === "--max-comments") {
      args.maxComments = Number(argv[index + 1] || DEFAULT_MAX_COMMENTS);
      index += 1;
      continue;
    }
    if (token === "--comment-scrolls") {
      args.commentScrolls = Number(argv[index + 1] || DEFAULT_COMMENT_SCROLLS);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }

  return args;
}

async function runSelfTests() {
  assert.equal(extractVideoInfoFromUrl("https://www.tiktok.com/@foo/video/123").videoId, "123");
  assert.equal(
    normalizeVideoUrl("https://www.tiktok.com/@foo/video/123?x=1"),
    "https://www.tiktok.com/@foo/video/123",
  );
  assert.equal(normalizeNumberString("1.4M"), "1400000");
  assert.equal(normalizeDuration(41), "0:41");
  assert.equal(normalizeDateValue(1758844800), "2025-09-26");
  assert.deepEqual(extractHashtags("hello #guangzhou #travel"), ["#guangzhou", "#travel"]);
  assert.equal(detectQuestion("How much is this?"), true);
  assert.deepEqual(detectIntentTags("多少钱，怎么买？"), ["purchase", "price"]);
  assert.deepEqual(detectTopicTags("在哪里，怎么去？"), ["location", "process"]);

  const vtt =
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nWorld";
  assert.equal(parseVtt(vtt).length, 2);
  const jsonTranscript = JSON.stringify({
    utterances: [
      { start: 0, end: 1.2, text: "hello" },
      { start: 1.2, end: 2.4, text: "world" },
    ],
  });
  assert.equal(parseJsonTranscript(jsonTranscript).length, 2);

  const merged = mergeComments(
    {
      commentId: "1",
      authorName: "Alice",
      authorId: "alice",
      text: "多少钱？",
      likeCount: "",
      replyCount: "2",
      publishedTime: "",
      isPinned: false,
      isQuestion: true,
      intentTags: ["price"],
      topicTags: ["price"],
    },
    {
      commentId: "1",
      authorName: "",
      authorId: "",
      text: "多少钱？",
      likeCount: "15",
      replyCount: "",
      publishedTime: "2026-03-24",
      isPinned: true,
      isQuestion: true,
      intentTags: ["purchase"],
      topicTags: [],
    },
  );
  assert.equal(merged.likeCount, "15");
  assert.equal(merged.isPinned, true);
  assert.deepEqual(merged.intentTags, ["price", "purchase"]);

  const summary = buildCommentSummary(
    {
      hashtags: ["#china", "#travel"],
    },
    [
      {
        commentId: "1",
        authorName: "Alice",
        authorId: "alice",
        text: "多少钱？怎么联系你？",
        likeCount: "100",
        replyCount: "5",
        publishedTime: "2026-03-24",
        isPinned: false,
        isQuestion: true,
        intentTags: ["price", "contact"],
        topicTags: ["price", "contact"],
      },
      {
        commentId: "2",
        authorName: "Bob",
        authorId: "bob",
        text: "在哪里，可以怎么去？",
        likeCount: "50",
        replyCount: "3",
        publishedTime: "2026-03-24",
        isPinned: false,
        isQuestion: true,
        intentTags: ["location", "how_to"],
        topicTags: ["location", "process"],
      },
    ],
    [],
    "SUCCESS",
  );
  assert.equal(summary.hotComments.length, 2);
  assert.equal(summary.questionThemes[0].topic, "price");

  const markdown = buildMarkdown({
    status: "SUCCESS",
    metadata: {
      author: "@foo",
      authorName: "Foo",
      creatorId: "foo",
      publishDate: "2026-03-24",
      duration: "0:41",
      plays: "1000",
      likes: "150",
      comments: "23",
      reposts: "12",
      description: "hello world",
      hashtags: ["#china"],
      videoUrl: "https://www.tiktok.com/@foo/video/123",
    },
    caption: "caption text",
    commentEvidence: {
      status: "SUCCESS",
      problems: [],
      summary,
    },
  });
  assert.match(markdown, /## 口播文案/);
  assert.match(markdown, /## 转化信号判断/);
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
  if (!args.videoUrl) {
    printHelp();
    fail("Missing required --video-url.");
  }

  ensureStealthConfigured();
  const targetInfo = extractVideoInfoFromUrl(args.videoUrl);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiktok-video-analyzer-"));

  let context;
  try {
    context = await launchBrowserContext(userDataDir, args);
    context.setDefaultTimeout(args.timeoutMs);
    context.setDefaultNavigationTimeout(args.timeoutMs);

    const page = context.pages()[0] || (await context.newPage());
    const collector = buildResponseCollector();
    page.on("response", collector.onResponse);

    await page.goto(targetInfo.canonicalUrl, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs,
    });

    const warmup = await waitForVideoPageData(page, targetInfo, collector, args);
    if (warmup.blocker) {
      fail(warmup.blocker);
    }

    const metadata = chooseBestMetadata(warmup.snapshot, collector, targetInfo);
    console.log("📋 正在提取视频元数据...");
    console.log(`   作者: ${metadata.creatorId || metadata.authorName || "未知"}`);
    console.log(`   描述: ${(metadata.description || "").slice(0, 80)}...`);

    const track = chooseTrack(warmup.snapshot, collector);
    if (!track) {
      fail("该视频没有可提取的平台字幕");
    }

    console.log("📝 正在提取平台口播文案...");
    const caption = await extractTranscript(context, track);
    console.log(`   口播文案提取完成，共 ${caption.length} 字`);

    console.log("💬 正在采集评论区证据...");
    const commentEvidence = await collectCommentEvidence(
      page,
      targetInfo,
      collector,
      args,
      metadata,
    );
    console.log(
      `   评论状态: ${commentEvidence.status}，样本评论数 ${commentEvidence.summary.sampleCount}`,
    );

    const reportStatus =
      commentEvidence.status === "BLOCKED" ? "PARTIAL" : commentEvidence.status;
    const report = {
      status: reportStatus,
      metadata: {
        ...metadata,
        videoUrl: targetInfo.canonicalUrl,
      },
      caption,
      commentEvidence,
    };

    const { outputPath, markdown } = await writeMarkdown(report);

    console.log(`\n✅ 分析完成！报告已保存到: ${outputPath}`);
    console.log("---");
    console.log(markdown);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error(`\n❌ ${error.message || error}`);
  process.exitCode = 1;
});
