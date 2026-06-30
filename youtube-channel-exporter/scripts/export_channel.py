#!/usr/bin/env python3
"""Export a public YouTube channel inventory to Markdown via yt-dlp."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


CACHE_VERSION = 1
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
TAB_NAMES = {"videos", "shorts", "streams", "featured", "playlists", "community", "about", "live"}
ABSENT_TAB_PATTERNS = (
    "does not have a videos tab",
    "does not have a shorts tab",
    "does not have a streams tab",
    "doesn't have a videos tab",
    "doesn't have a shorts tab",
    "doesn't have a streams tab",
)
SYSTEMIC_BLOCKER_PATTERNS = (
    "sign in to confirm",
    "confirm you're not a bot",
    "confirm you’re not a bot",
    "http error 429",
    "too many requests",
)
METADATA_CACHE_FIELDS = (
    "id",
    "title",
    "view_count",
    "upload_date",
    "release_date",
    "timestamp",
    "release_timestamp",
)


@dataclass
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


@dataclass
class TabResult:
    tab: str
    state: str
    entries: list[dict[str, Any]]
    metadata: dict[str, Any]
    problem: str | None = None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export a YouTube channel's public Videos and Shorts to a Markdown table "
            "and a plain NotebookLM URL block. No media is downloaded."
        )
    )
    parser.add_argument("--profile-url", required=True, help="Public YouTube channel/profile URL")
    parser.add_argument("--mode", choices=("accurate", "fast"), default="accurate")
    parser.add_argument("--include-streams", action="store_true", help="Include Streams as Video")
    parser.add_argument("--max-items-per-tab", type=positive_int, help="Limit each requested tab")
    parser.add_argument(
        "--max-items-total",
        type=positive_int,
        help="Export only the newest N items after combining all requested tabs",
    )
    parser.add_argument("--output-dir", default=".", help="Report/cache directory (default: current directory)")
    parser.add_argument("--output-file", help="Explicit Markdown filename or path")
    parser.add_argument("--yt-dlp", dest="yt_dlp", help="Path to the yt-dlp executable")
    parser.add_argument(
        "--cookies-from-browser",
        metavar="BROWSER",
        help="Explicit opt-in, e.g. chrome or firefox; never enabled automatically",
    )
    parser.add_argument("--sleep-requests", type=nonnegative_float, default=0.75)
    parser.add_argument("--video-delay", type=nonnegative_float, default=0.5)
    parser.add_argument("--command-timeout", type=positive_int, default=180)
    parser.add_argument("--cache-max-age-hours", type=nonnegative_float, default=1.0)
    parser.add_argument("--refresh", action="store_true", help="Ignore cached item metadata")
    return parser.parse_args(argv)


def positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def nonnegative_float(value: str) -> float:
    number = float(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return number


def normalize_channel_url(raw_url: str) -> str:
    value = raw_url.strip()
    if not value:
        raise ValueError("The YouTube channel URL is empty.")
    if "://" not in value:
        value = "https://" + value
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if host not in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        raise ValueError("Expected a youtube.com channel/profile URL.")

    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        raise ValueError("The URL does not identify a YouTube channel.")
    if parts[-1].lower() in TAB_NAMES:
        parts.pop()
    if not parts:
        raise ValueError("The URL does not identify a YouTube channel.")
    if parts[0].lower() in {"watch", "playlist", "shorts"}:
        raise ValueError("Expected a channel/profile URL, not a video or playlist URL.")

    path = "/" + "/".join(parts)
    return urlunsplit(("https", "www.youtube.com", path, "", ""))


def candidate_runtime_paths() -> list[Path]:
    home = Path.home()
    base = home / ".codex" / "skills" / ".runtime" / "yt-dlp"
    return [
        base / "bin" / "yt-dlp",
        base / "Scripts" / "yt-dlp.exe",
    ]


def resolve_ytdlp(explicit: str | None) -> str:
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    env_path = os.environ.get("YTDLP_PATH")
    if env_path:
        candidates.append(env_path)
    on_path = shutil.which("yt-dlp")
    if on_path:
        candidates.append(on_path)
    candidates.extend(str(path) for path in candidate_runtime_paths())

    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path.resolve())
    raise RuntimeError(
        "yt-dlp was not found. Install the isolated runtime under "
        "$HOME/.codex/skills/.runtime/yt-dlp or pass --yt-dlp PATH."
    )


def major_version(command: str) -> int | None:
    try:
        result = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"(\d+)", result.stdout)
    return int(match.group(1)) if match else None


def javascript_args(mode: str) -> tuple[list[str], str]:
    deno = shutil.which("deno")
    if deno and (major_version(deno) or 0) >= 2:
        return [], f"deno ({deno})"
    node = shutil.which("node")
    if node and (major_version(node) or 0) >= 22:
        return ["--js-runtimes", "node"], f"node ({node})"
    if mode == "accurate":
        raise RuntimeError(
            "Accurate mode requires Deno 2.3+ or Node 22+ for current YouTube extraction."
        )
    return [], "not found (fast mode only)"


def run_command(command: list[str], timeout: int) -> CommandResult:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode("utf-8", "replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode("utf-8", "replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
        return CommandResult(124, stdout, stderr, timed_out=True)
    except OSError as error:
        return CommandResult(127, "", str(error))


def common_ytdlp_args(args: argparse.Namespace, js_args: list[str]) -> list[str]:
    command = [args.yt_dlp_path, "--ignore-config", "--no-progress", *js_args]
    if args.cookies_from_browser:
        command.extend(["--cookies-from-browser", args.cookies_from_browser])
    return command


def compact_problem(text: str, limit: int = 500) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    message = " | ".join(lines[-4:]) if lines else "Unknown extraction error"
    return message if len(message) <= limit else message[: limit - 1] + "…"


def is_absent_tab(text: str) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in ABSENT_TAB_PATTERNS)


def is_systemic_blocker(text: str) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in SYSTEMIC_BLOCKER_PATTERNS)


def parse_json_output(result: CommandResult) -> dict[str, Any]:
    payload = result.stdout.strip()
    if not payload:
        raise ValueError("yt-dlp returned no JSON output")
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        # Be tolerant of an unexpected informational line before the final JSON object.
        for line in reversed(payload.splitlines()):
            try:
                parsed = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        else:
            raise ValueError("yt-dlp returned invalid JSON")
    if not isinstance(parsed, dict):
        raise ValueError("yt-dlp JSON root was not an object")
    return parsed


def inventory_tab(
    args: argparse.Namespace,
    base_args: list[str],
    base_url: str,
    tab: str,
) -> TabResult:
    command = [
        *base_args,
        "--flat-playlist",
        "--dump-single-json",
        "--skip-download",
        "--extractor-args",
        "youtubetab:approximate_date",
    ]
    if args.max_items_per_tab:
        command.extend(["--playlist-end", str(args.max_items_per_tab)])
    command.append(f"{base_url}/{tab}")

    result = run_command(command, args.command_timeout)
    combined = "\n".join((result.stderr, result.stdout))
    if result.returncode != 0 and is_absent_tab(combined):
        return TabResult(tab, "absent", [], {})
    if result.returncode != 0:
        label = "timed out" if result.timed_out else f"exit {result.returncode}"
        return TabResult(tab, "error", [], {}, f"{tab} inventory {label}: {compact_problem(combined)}")

    try:
        metadata = parse_json_output(result)
    except ValueError as error:
        return TabResult(tab, "error", [], {}, f"{tab} inventory: {error}")

    entries: list[dict[str, Any]] = []
    for index, raw_entry in enumerate(metadata.get("entries") or []):
        if not isinstance(raw_entry, dict):
            continue
        video_id = str(raw_entry.get("id") or "")
        if not VIDEO_ID_RE.fullmatch(video_id):
            continue
        entries.append(
            {
                "id": video_id,
                "title": clean_text(raw_entry.get("title")) or "—",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "type": "short" if tab == "shorts" else "video",
                "source_tab": tab,
                "view_count": as_int(raw_entry.get("view_count")),
                "upload_date": normalize_date(raw_entry.get("upload_date")),
                "release_date": normalize_date(raw_entry.get("release_date")),
                "timestamp": as_number(raw_entry.get("timestamp")),
                "inventory_index": index,
                "metadata_quality": "flat",
            }
        )
    return TabResult(tab, "ok", entries, metadata)


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def as_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return None


def normalize_date(value: Any) -> str | None:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    if len(digits) != 8:
        return None
    try:
        parsed = datetime.strptime(digits, "%Y%m%d")
    except ValueError:
        return None
    return parsed.strftime("%Y-%m-%d")


def published_date(item: dict[str, Any]) -> str | None:
    return item.get("release_date") or item.get("upload_date")


def channel_slug(base_url: str, metadata: dict[str, Any]) -> str:
    path_part = urlsplit(base_url).path.rstrip("/").split("/")[-1].lstrip("@")
    candidate = path_part or metadata.get("channel_id") or metadata.get("uploader_id") or "channel"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", str(candidate)).strip("-._").lower()
    return slug or "channel"


def merge_inventories(tab_results: list[TabResult]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    sequence = 0
    for result in tab_results:
        for entry in result.entries:
            video_id = entry["id"]
            if video_id not in merged:
                copied = dict(entry)
                copied["sequence"] = sequence
                sequence += 1
                merged[video_id] = copied
            elif entry["type"] == "short":
                merged[video_id]["type"] = "short"
                merged[video_id]["source_tab"] = "shorts"
    return list(merged.values())


def load_cache(path: Path, base_url: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": CACHE_VERSION, "profile_url": base_url, "items": {}}
    if (
        not isinstance(payload, dict)
        or payload.get("version") != CACHE_VERSION
        or payload.get("profile_url") != base_url
        or not isinstance(payload.get("items"), dict)
    ):
        return {"version": CACHE_VERSION, "profile_url": base_url, "items": {}}
    return payload


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def save_cache(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def cached_data(
    cache: dict[str, Any],
    video_id: str,
    max_age_hours: float,
    refresh: bool,
) -> dict[str, Any] | None:
    if refresh or max_age_hours == 0:
        return None
    record = cache.get("items", {}).get(video_id)
    if not isinstance(record, dict) or not isinstance(record.get("data"), dict):
        return None
    try:
        fetched_at = datetime.fromisoformat(str(record.get("fetched_at")))
    except ValueError:
        return None
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - fetched_at.astimezone(timezone.utc) > timedelta(hours=max_age_hours):
        return None
    return record["data"]


def enrich_item(
    args: argparse.Namespace,
    base_args: list[str],
    item: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    command = [
        *base_args,
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--ignore-no-formats-error",
        "--socket-timeout",
        "30",
        "--extractor-retries",
        "3",
    ]
    if args.sleep_requests:
        command.extend(["--sleep-requests", str(args.sleep_requests)])
    command.append(item["url"])
    result = run_command(command, args.command_timeout)
    combined = "\n".join((result.stderr, result.stdout))
    if result.returncode != 0:
        label = "timed out" if result.timed_out else f"exit {result.returncode}"
        problem = f"{item['id']} metadata {label}: {compact_problem(combined)}"
        if is_systemic_blocker(combined):
            problem = "BLOCKER: " + problem
        return None, problem
    try:
        metadata = parse_json_output(result)
        return {key: metadata.get(key) for key in METADATA_CACHE_FIELDS}, None
    except ValueError as error:
        return None, f"{item['id']} metadata: {error}"


def apply_metadata(item: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(item)
    enriched["title"] = clean_text(metadata.get("title")) or enriched.get("title") or "—"
    enriched["view_count"] = as_int(metadata.get("view_count"))
    if enriched["view_count"] is None:
        enriched["view_count"] = item.get("view_count")
    enriched["upload_date"] = normalize_date(metadata.get("upload_date")) or item.get("upload_date")
    enriched["release_date"] = normalize_date(metadata.get("release_date")) or item.get("release_date")
    enriched["timestamp"] = as_number(metadata.get("release_timestamp"))
    if enriched["timestamp"] is None:
        enriched["timestamp"] = as_number(metadata.get("timestamp")) or item.get("timestamp")
    enriched["metadata_quality"] = "accurate"
    return enriched


def markdown_escape(value: Any) -> str:
    text = clean_text(value) or "—"
    return text.replace("\\", "\\\\").replace("|", "\\|")


def format_views(value: Any) -> str:
    number = as_int(value)
    return f"{number:,}" if number is not None else "—"


def sort_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(item: dict[str, Any]) -> tuple[float, int]:
        timestamp = as_number(item.get("timestamp"))
        if timestamp is None:
            date = published_date(item)
            if date:
                timestamp = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
            else:
                timestamp = -1.0
        return (timestamp, -int(item.get("sequence", 0)))

    return sorted(items, key=key, reverse=True)


def choose_channel_metadata(tab_results: list[TabResult]) -> dict[str, Any]:
    for result in tab_results:
        if result.metadata:
            return result.metadata
    return {}


def render_report(
    base_url: str,
    mode: str,
    status: str,
    items: list[dict[str, Any]],
    tab_results: list[TabResult],
    problems: list[str],
    metadata: dict[str, Any],
    runtime_version: str,
    js_runtime: str,
) -> str:
    channel = clean_text(metadata.get("channel")) or clean_text(metadata.get("uploader")) or "Unknown channel"
    channel_id = clean_text(metadata.get("channel_id")) or clean_text(metadata.get("uploader_id")) or "—"
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    video_count = sum(1 for item in items if item["type"] == "video")
    short_count = sum(1 for item in items if item["type"] == "short")
    tab_summary = ", ".join(f"{result.tab}={result.state}:{len(result.entries)}" for result in tab_results)

    lines = [
        f"# {markdown_escape(channel)}",
        "",
        f"- Source: {base_url}",
        f"- Channel ID: {markdown_escape(channel_id)}",
        f"- Generated at: {generated_at}",
        f"- Status: **{status}**",
        f"- Mode: {mode}",
        f"- Tabs: {tab_summary}",
        f"- Videos: {video_count}",
        f"- Shorts: {short_count}",
        f"- Total: {len(items)}",
        f"- yt-dlp: {runtime_version}",
        f"- JavaScript runtime: {js_runtime}",
        "",
        "## 抓取问题",
        "",
    ]
    if problems:
        lines.extend(f"- {markdown_escape(problem)}" for problem in problems)
    else:
        lines.append("- 无")

    if mode == "fast":
        lines.extend(
            [
                "",
                "> Fast 模式使用频道列表元数据；发布时间可能是推算日期，播放数可能被取整或缺失。",
            ]
        )

    lines.extend(
        [
            "",
            "## 视频列表",
            "",
            "| # | 视频标题 | 视频类型 | 播放数 | 发布时间 | 视频链接 |",
            "|---:|---|---|---:|---|---|",
        ]
    )
    for index, item in enumerate(items, start=1):
        public_type = "Short" if item["type"] == "short" else "Video"
        date = published_date(item) or "—"
        lines.append(
            f"| {index} | {markdown_escape(item.get('title'))} | {public_type} | "
            f"{format_views(item.get('view_count'))} | {date} | {item['url']} |"
        )

    lines.extend(["", "## NotebookLM 视频链接", ""])
    lines.extend(item["url"] for item in items)
    lines.append("")
    return "\n".join(lines)


def ytdlp_version(path: str) -> str:
    result = run_command([path, "--version"], 15)
    return clean_text(result.stdout) or "unknown"


def output_path_for(args: argparse.Namespace, output_dir: Path, slug: str) -> Path:
    if not args.output_file:
        return output_dir / f"youtube.{slug}.md"
    explicit = Path(args.output_file).expanduser()
    return explicit if explicit.is_absolute() else output_dir / explicit


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        base_url = normalize_channel_url(args.profile_url)
        args.yt_dlp_path = resolve_ytdlp(args.yt_dlp)
        js_args, js_runtime = javascript_args(args.mode)
    except (ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_args = common_ytdlp_args(args, js_args)
    tabs = ["videos", "shorts"] + (["streams"] if args.include_streams else [])

    tab_results: list[TabResult] = []
    for tab in tabs:
        print(f"Inventory: {tab}", file=sys.stderr)
        tab_results.append(inventory_tab(args, base_args, base_url, tab))

    metadata = choose_channel_metadata(tab_results)
    slug = channel_slug(base_url, metadata)
    report_path = output_path_for(args, output_dir, slug)
    cache_path = output_dir / ".youtube-channel-exporter-cache" / f"{slug}.json"
    items = merge_inventories(tab_results)
    if args.max_items_total:
        # A global top N item cannot rank below N within its own tab. Keep the
        # first N candidates from every tab, then enrich, merge-sort, and trim.
        candidate_ids = {
            entry["id"]
            for result in tab_results
            for entry in result.entries[: args.max_items_total]
        }
        items = [item for item in items if item["id"] in candidate_ids]
    problems = [result.problem for result in tab_results if result.problem]
    successful_tabs = [result for result in tab_results if result.state in {"ok", "absent"}]

    if not successful_tabs:
        status = "FAILED"
        report = render_report(
            base_url,
            args.mode,
            status,
            [],
            tab_results,
            problems or ["No requested tab could be inventoried."],
            metadata,
            ytdlp_version(args.yt_dlp_path),
            js_runtime,
        )
        atomic_write_text(report_path, report)
        print(f"Report: {report_path}")
        print(f"Status: {status}")
        return 1

    if args.mode == "accurate" and items:
        cache = load_cache(cache_path, base_url)
        enriched_items: list[dict[str, Any]] = []
        consecutive_failures = 0
        for index, item in enumerate(items, start=1):
            data = cached_data(cache, item["id"], args.cache_max_age_hours, args.refresh)
            if data is not None:
                print(f"Metadata {index}/{len(items)}: {item['id']} (cache)", file=sys.stderr)
                enriched_items.append(apply_metadata(item, data))
                consecutive_failures = 0
                continue

            print(f"Metadata {index}/{len(items)}: {item['id']}", file=sys.stderr)
            data, problem = enrich_item(args, base_args, item)
            if data is None:
                problems.append(problem or f"{item['id']} metadata failed")
                enriched_items.append(item)
                consecutive_failures += 1
            else:
                cache.setdefault("items", {})[item["id"]] = {
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "data": data,
                }
                save_cache(cache_path, cache)
                enriched_items.append(apply_metadata(item, data))
                consecutive_failures = 0
            should_stop = bool(problem and problem.startswith("BLOCKER:")) or consecutive_failures >= 3
            if should_stop and index < len(items):
                remaining = len(items) - index
                problems.append(
                    f"Metadata enrichment stopped after {consecutive_failures or 1} consecutive/systemic "
                    f"failure(s); {remaining} remaining item(s) use flat inventory metadata."
                )
                enriched_items.extend(items[index:])
                break
            if args.video_delay and index < len(items):
                time.sleep(args.video_delay)
        items = enriched_items

    items = sort_items(items)
    if args.max_items_total:
        items = items[: args.max_items_total]
    status = "PARTIAL" if problems else "SUCCESS"
    report = render_report(
        base_url,
        args.mode,
        status,
        items,
        tab_results,
        problems,
        metadata,
        ytdlp_version(args.yt_dlp_path),
        js_runtime,
    )
    atomic_write_text(report_path, report)
    print(f"Report: {report_path}")
    print(f"Status: {status}")
    print(f"Items: {len(items)}")
    return 2 if status == "PARTIAL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
