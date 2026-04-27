#!/usr/bin/env python3
"""Run faster-whisper on an audio file; emit an SRT and a JSON cue list."""
import argparse
import json
import sys
from faster_whisper import WhisperModel


def fmt_ts(t: float) -> str:
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t - (h * 3600) - (m * 60)
    secs = int(s)
    millis = int(round((s - secs) * 1000))
    if millis == 1000:
        secs += 1
        millis = 0
    return f"{h:02d}:{m:02d}:{secs:02d},{millis:03d}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--srt-out", required=True)
    p.add_argument("--json-out", required=True)
    p.add_argument("--model", default="small")
    p.add_argument("--compute", default="int8")
    p.add_argument("--language", default=None,
                   help="Optional ISO code, e.g. 'en'. Default: auto-detect.")
    args = p.parse_args()

    model = WhisperModel(args.model, device="cpu", compute_type=args.compute)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_speech_duration_ms": 250, "min_silence_duration_ms": 500},
    )

    cues = []
    with open(args.srt_out, "w", encoding="utf-8") as srt:
        for i, seg in enumerate(segments, 1):
            text = (seg.text or "").strip()
            if not text:
                continue
            srt.write(f"{i}\n{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}\n{text}\n\n")
            cues.append({
                "id": i,
                "start_ms": int(round(seg.start * 1000)),
                "end_ms":   int(round(seg.end * 1000)),
                "text": text,
                "words": [
                    {
                        "w": (w.word or "").strip(),
                        "s": int(round((w.start or seg.start) * 1000)),
                        "e": int(round((w.end or seg.end) * 1000)),
                    }
                    for w in (seg.words or [])
                ]
            })

    with open(args.json_out, "w", encoding="utf-8") as j:
        json.dump({"cues": cues, "language": info.language,
                   "language_probability": info.language_probability,
                   "duration": info.duration}, j)

    print(f"transcribed {len(cues)} cues, language={info.language}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
