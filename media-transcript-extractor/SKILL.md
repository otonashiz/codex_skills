---
name: media-transcript-extractor
description: Extract full transcripts or video scripts from local audio/video files using local faster-whisper. Use when the user provides a media file path and asks to transcribe audio, extract video copy, convert speech to text, generate subtitles/timestamps, or avoid cloud tools such as Feishu/Lark Minutes. Handles common audio/video files including mp3, m4a, wav, mp4, mov, and TikTok/short-form media; defaults to medium and uses turbo only when explicitly requested.
---

# Media Transcript Extractor

## Workflow

1. Confirm the input is a local audio/video path. If the user supplied a relative path, resolve it against the user's original task workspace.
2. Preserve that workspace before launching Python. The local Python runtime can fail when it initializes inside a restricted workspace, so pass an absolute output path and let the script switch its runtime directory internally. Never infer the output folder from `/tmp`.
3. Prefer the bundled launcher. It preserves the caller's workspace for relative input/output paths while starting Python from a neutral runtime directory:

```bash
/Users/otonashic./.codex/skills/media-transcript-extractor/scripts/transcribe_media \
  "/path/to/media.mp3" \
  --out-dir "/absolute/task/workspace/outputs/media-transcripts"
```

4. If the language is known, pass it explicitly:

```bash
/Users/otonashic./.codex/skills/media-transcript-extractor/scripts/transcribe_media \
  "/path/to/media.mp4" \
  --language fr \
  --out-dir "/absolute/task/workspace/outputs/media-transcripts"
```

5. For sourcing/product/geography videos, add likely terms as a prompt to improve brand and place names:

```bash
--prompt "Terms: Fujian, Putian, Jinjiang, Guangdong, Guangzhou, Dongguan, Zhejiang, Wenzhou, Anta, Xtep, 361, Peak."
```

6. Validate coverage before reporting success:
   - Read the script JSON summary or final console output.
   - Check that `last_end` is near the media duration.
   - If the transcript seems incomplete, add a better `--prompt` or review the audio around the missing section.
   - Do not switch to `turbo` unless the user explicitly requests that model.

## Defaults

- Default model: `medium`, regardless of media duration.
- Never auto-select `turbo` based on duration. Use `turbo` only when the user explicitly requests it.
- Warn that long recordings can take substantial time with `medium`. If the user does not want to use this skill for long media, stop instead of silently changing models.
- Default execution: local `faster-whisper`; do not use Feishu/Lark Minutes unless the user explicitly requests it.
- Default outputs:
  - Markdown report: `*.md`
  - Plain transcript: `*.txt`
  - Timestamped segments: `*.segments.txt`
  - Machine-readable details: `*.json`

## Local Environment

The script auto-detects the existing faster-whisper runtime at:

```text
/Users/otonashic./.claude/skills/tiktok-analyzer/.venv/bin/python
```

It also prefers cached Hugging Face models on this machine:

```text
~/.cache/huggingface/hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo
~/.cache/huggingface/hub/models--Systran--faster-whisper-medium
```

Use environment variables only when the defaults stop matching the machine:

```bash
FASTER_WHISPER_PYTHON=/path/to/python
FASTER_WHISPER_MODEL=/path/to/model
```

## Output Guidance

- Treat raw ASR as evidence, not polished copy.
- Do not silently invent uncertain brand/place names. If cleaning the transcript, keep a note for corrected or uncertain terms.
- For short-form videos, preserve timestamps; they make it easier to compare suspicious words against the audio.
