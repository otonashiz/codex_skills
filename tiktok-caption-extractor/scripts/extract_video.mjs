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
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SLOW_MO_MS = 200;
const DEFAULT_WAIT_AFTER_NAV_MS = 7000;
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_ATTEMPTS = 8;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const MAX_FILENAME_LEN = 50;
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

let stealthConfigured = false;

function printHelp() {
  console.log(`Usage:
  extract_video --video-url <url> [--slow-mo MS] [--timeout-ms MS] [--headless]

Options:
  --video-url <url>     Required TikTok video URL.
  --slow-mo <MS>        Playwright slow motion delay. Default: ${DEFAULT_SLOW_MO_MS}
  --timeout-ms <MS>     Navigation timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}
  --headless            Run Chromium headlessly instead of headed Chrome.
  --self-test           Run helper self-tests without launching a browser.
  --help                Show this help text.

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
  const hasText = value.desc || value.description || value.title || value.textExtra || value.challenges;
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
  const creatorId = pickFirstNonEmpty(
    author.uniqueId,
    author.unique_id,
    author.authorId,
    author.id,
    fallbackCreatorId,
  ).replace(/^@/, "");
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
  const creatorId = pickFirstNonEmpty(snapshot.pageCreatorId, targetInfo.creatorId).replace(/^@/, "");
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
      rawTrack.src
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
      rawTrack.name
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
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,960",
    ],
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
    return await chromium.launchPersistentContext(
      userDataDir,
      buildBrowserLaunchOptions(args),
    );
  } catch (fallbackError) {
    const details = [
      chromeChannelError ? `Chrome channel failed: ${chromeChannelError.message}` : "",
      chromeExecutableError ? `System Chrome executable failed: ${chromeExecutableError.message}` : "",
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
    return { bodyText: bodyText.slice(0, 4000).toLowerCase() };
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
        if (jsonPayloads.length > 40) {
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

async function snapshotVideoPage(page, targetInfo) {
  return evaluateWithRetry(page, (info) => {
    const meta = (name, attr = "property") =>
      document.querySelector(`meta[${attr}="${name}"]`)?.getAttribute("content") || "";
    const title = document.title || "";
    const authorHandleMatch = location.pathname.match(/\/@([^/?#]+)\/video\/(\d+)/);
    return {
      pageTitle: title,
      metaDescription: meta("og:description") || meta("description", "name"),
      pageCreatorId: authorHandleMatch?.[1] || info.creatorId || "",
      pageAuthorName: meta("og:title").replace(/\s*on TikTok\s*$/i, "").trim(),
      scriptJson: {
        __UNIVERSAL_DATA_FOR_REHYDRATION__:
          document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "",
        SIGI_STATE: document.getElementById("SIGI_STATE")?.textContent || "",
        __NEXT_DATA__: document.getElementById("__NEXT_DATA__")?.textContent || "",
      },
    };
  }, targetInfo);
}

async function waitForVideoPageData(page, targetInfo, collector) {
  let lastSnapshot = await snapshotVideoPage(page, targetInfo);
  await humanWait(page, DEFAULT_WAIT_AFTER_NAV_MS, 2000);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await maybeDismissDialogs(page);
    await simulateUserPresence(page, attempt);

    const blocker = await detectBlocker(page);
    if (blocker) {
      return { blocker, snapshot: lastSnapshot };
    }

    lastSnapshot = await snapshotVideoPage(page, targetInfo);
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
    const start = rawStart === undefined ? null : Number(rawStart) / (String(rawStart).length > 6 ? 1000 : 1);
    const end = rawEnd === undefined ? null : Number(rawEnd) / (String(rawEnd).length > 6 ? 1000 : 1);
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

function buildMarkdown(metadata, transcript) {
  const lines = [
    "# TikTok 视频分析",
    "",
    "## 基本信息",
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

  lines.push("## 口播文案（语音转录）");
  lines.push(transcript || "（无语音内容）");
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

async function writeMarkdown(metadata, transcript) {
  const outputDir = process.cwd();
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, buildFilename(metadata));
  const markdown = buildMarkdown(metadata, transcript);
  await fs.writeFile(outputPath, markdown, "utf8");
  return { outputPath, markdown };
}

function parseArgs(argv) {
  const args = {
    videoUrl: "",
    slowMo: DEFAULT_SLOW_MO_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headless: false,
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
    fail(`Unknown argument: ${token}`);
  }

  return args;
}

async function runSelfTests() {
  assert.equal(extractVideoInfoFromUrl("https://www.tiktok.com/@foo/video/123").videoId, "123");
  assert.equal(normalizeVideoUrl("https://www.tiktok.com/@foo/video/123?x=1"), "https://www.tiktok.com/@foo/video/123");
  assert.equal(normalizeNumberString("1.4M"), "1400000");
  assert.equal(normalizeDuration(41), "0:41");
  assert.equal(normalizeDateValue(1758844800), "2025-09-26");
  assert.deepEqual(extractHashtags("hello #guangzhou #travel"), ["#guangzhou", "#travel"]);

  const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nWorld`;
  assert.equal(parseVtt(vtt).length, 2);
  const jsonTranscript = JSON.stringify({
    utterances: [
      { start: 0, end: 1.2, text: "hello" },
      { start: 1.2, end: 2.4, text: "world" },
    ],
  });
  assert.equal(parseJsonTranscript(jsonTranscript).length, 2);
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
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiktok-analyzer-"));

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

    const warmup = await waitForVideoPageData(page, targetInfo, collector);
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

    console.log("📝 正在提取平台字幕...");
    const transcript = await extractTranscript(context, track);
    console.log(`   字幕提取完成，共 ${transcript.length} 字`);

    const { outputPath, markdown } = await writeMarkdown(
      {
        ...metadata,
        videoUrl: targetInfo.canonicalUrl,
      },
      transcript,
    );

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
