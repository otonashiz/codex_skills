#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any


DEFAULT_PYTHON_CANDIDATES = [
    "/Users/otonashic./.claude/skills/tiktok-analyzer/.venv/bin/python",
]

MODEL_CANDIDATES = {
    "medium": [
        "/Users/otonashic./.cache/huggingface/hub/models--Systran--faster-whisper-medium/snapshots/08e178d48790749d25932bbc082711ddcfdfbc4f",
        "Systran/faster-whisper-medium",
    ],
    "turbo": [
        "/Users/otonashic./.cache/huggingface/hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    ],
    "large-v3-turbo": [
        "/Users/otonashic./.cache/huggingface/hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    ],
}


def ensure_runtime() -> None:
    try:
        import faster_whisper  # noqa: F401
        return
    except ImportError:
        pass

    if os.environ.get("MEDIA_TRANSCRIPT_BOOTSTRAPPED") == "1":
        die("faster_whisper is not importable in this Python runtime.")

    candidates = []
    env_python = os.environ.get("FASTER_WHISPER_PYTHON")
    if env_python:
        candidates.append(env_python)
    candidates.extend(DEFAULT_PYTHON_CANDIDATES)

    current = Path(sys.executable).absolute()
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if not path.exists() or path.absolute() == current:
            continue
        env = os.environ.copy()
        env["MEDIA_TRANSCRIPT_BOOTSTRAPPED"] = "1"
        os.execve(str(path), [str(path), __file__, *sys.argv[1:]], env)

    die(
        "faster_whisper is not installed in the current Python, and no usable "
        "FASTER_WHISPER_PYTHON candidate was found."
    )


def die(message: str, code: int = 1) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def ts(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def safe_stem(path: Path) -> str:
    raw = path.stem.strip() or "media"
    return re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-") or "media"


def resolve_model(model: str) -> str:
    env_model = os.environ.get("FASTER_WHISPER_MODEL")
    if model == "medium" and env_model:
        return env_model

    expanded = Path(model).expanduser()
    if expanded.exists():
        return str(expanded)

    for candidate in MODEL_CANDIDATES.get(model, [model]):
        path = Path(candidate).expanduser()
        if path.exists():
            return str(path)
    return MODEL_CANDIDATES.get(model, [model])[-1]


def media_duration(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        return float(result.stdout.strip())
    except Exception:
        return None


def write_outputs(
    out_prefix: Path,
    media_path: Path,
    model: str,
    requested_model: str,
    language: str | None,
    duration: float | None,
    info: Any,
    segments: list[Any],
) -> None:
    plain_text = "\n".join(segment.text.strip() for segment in segments if segment.text.strip())
    segment_lines = [
        f"[{ts(segment.start)} -> {ts(segment.end)}] {segment.text.strip()}"
        for segment in segments
    ]

    raw = {
        "source": str(media_path),
        "requested_model": requested_model,
        "model": model,
        "requested_language": language,
        "detected_language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": duration if duration is not None else getattr(info, "duration", None),
        "whisper_duration": getattr(info, "duration", None),
        "segments": [
            {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "start_ts": ts(segment.start),
                "end_ts": ts(segment.end),
                "text": segment.text.strip(),
                "avg_logprob": segment.avg_logprob,
                "compression_ratio": segment.compression_ratio,
                "no_speech_prob": segment.no_speech_prob,
            }
            for segment in segments
        ],
    }

    last_end = segments[-1].end if segments else None
    coverage_note = ""
    if duration and last_end is not None:
        gap = duration - last_end
        coverage_note = f"\n- Coverage gap: {gap:.2f}s"

    markdown = f"""# Media Transcript

- Source: `{media_path}`
- Requested model: `{requested_model}`
- Model: `{model}`
- Requested language: `{language or "auto"}`
- Detected language: `{getattr(info, "language", None)}`
- Language probability: `{getattr(info, "language_probability", None)}`
- Duration: `{duration if duration is not None else getattr(info, "duration", None)}`
- Last segment end: `{last_end}`{coverage_note}

## Timestamped Transcript

```text
{chr(10).join(segment_lines)}
```

## Plain Transcript

```text
{plain_text}
```
"""

    Path(str(out_prefix) + ".txt").write_text(plain_text + "\n", encoding="utf-8")
    Path(str(out_prefix) + ".segments.txt").write_text("\n".join(segment_lines) + "\n", encoding="utf-8")
    Path(str(out_prefix) + ".json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    Path(str(out_prefix) + ".md").write_text(markdown, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Transcribe a local audio/video file with faster-whisper."
    )
    parser.add_argument("media", help="Path to a local audio/video file")
    parser.add_argument("--out-dir", default="outputs/media-transcripts")
    parser.add_argument("--basename", help="Output basename; defaults to media stem")
    parser.add_argument(
        "--model",
        default="medium",
        help="medium (default), turbo, large-v3-turbo, HF id, or local model path",
    )
    parser.add_argument("--language", help="Language code, e.g. fr, en, zh. Omit for auto-detect")
    parser.add_argument("--prompt", default="", help="Initial prompt with likely names/terms")
    parser.add_argument("--vad-filter", action="store_true", help="Enable faster-whisper VAD")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    invocation_dir = Path(
        os.environ.get("MEDIA_TRANSCRIPT_INVOCATION_DIR", str(Path.cwd()))
    ).expanduser().resolve()
    media_path = Path(args.media).expanduser()
    if not media_path.is_absolute():
        media_path = invocation_dir / media_path
    media_path = media_path.resolve()
    if not media_path.exists():
        die(f"Media file not found: {media_path}")

    out_dir = Path(args.out_dir).expanduser()
    if not out_dir.is_absolute():
        out_dir = (invocation_dir / out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_prefix = out_dir / (args.basename or safe_stem(media_path))
    duration = media_duration(media_path)
    model_path = resolve_model(args.model)

    # Python 3.13 can fail while importing faster-whisper from restricted workspaces.
    # Keep resolved input/output paths, then run the interpreter from a neutral directory.
    os.chdir("/tmp")
    ensure_runtime()
    from faster_whisper import WhisperModel

    model = WhisperModel(model_path, device=args.device, compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        str(media_path),
        language=args.language,
        task="transcribe",
        beam_size=5,
        best_of=5,
        patience=1.2,
        temperature=[0.0, 0.2, 0.4],
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        condition_on_previous_text=True,
        initial_prompt=args.prompt or None,
        vad_filter=args.vad_filter,
        word_timestamps=False,
    )
    segments = list(segments_iter)
    write_outputs(
        out_prefix,
        media_path,
        model_path,
        args.model,
        args.language,
        duration,
        info,
        segments,
    )

    summary = {
        "ok": True,
        "source": str(media_path),
        "requested_model": args.model,
        "selected_model": args.model,
        "model": model_path,
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": duration if duration is not None else getattr(info, "duration", None),
        "segments": len(segments),
        "last_end": segments[-1].end if segments else None,
        "outputs": {
            "md": str(out_prefix) + ".md",
            "txt": str(out_prefix) + ".txt",
            "segments": str(out_prefix) + ".segments.txt",
            "json": str(out_prefix) + ".json",
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
