#!/usr/bin/env python3
"""Render an ASS subtitle file from a section of an SRT plus brand styling.

The ASS is then burned in by ffmpeg `ass=...` filter. The point of going through
ASS rather than the raw SRT is style control: font, size, outline, and vertical
position match brand_config exactly.
"""
import argparse
import json
import sys
from pathlib import Path

import pysubs2


def hex_to_ass_color(hex_str: str, alpha: int = 0) -> str:
    """Convert '#RRGGBB' to ASS '&HAABBGGRR'."""
    h = hex_str.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"bad color {hex_str}")
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--srt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--style-json", required=True,
                   help="Path to a JSON file with brand styling.")
    p.add_argument("--start-ms", type=int, default=0,
                   help="Optional start of the slice (subtitles before this are dropped, "
                        "and remaining ones are shifted to be 0-relative).")
    p.add_argument("--end-ms", type=int, default=None,
                   help="Optional end of the slice (subtitles after this are dropped).")
    p.add_argument("--video-w", type=int, default=1080)
    p.add_argument("--video-h", type=int, default=1920)
    args = p.parse_args()

    style = json.loads(Path(args.style_json).read_text(encoding="utf-8"))

    subs = pysubs2.load(args.srt, encoding="utf-8")

    # Slice + shift
    end_ms = args.end_ms if args.end_ms is not None else 10**9
    kept = []
    for line in subs:
        if line.end <= args.start_ms or line.start >= end_ms:
            continue
        line.start = max(0, line.start - args.start_ms)
        line.end = max(0, min(line.end, end_ms) - args.start_ms)
        kept.append(line)

    out = pysubs2.SSAFile()
    out.events = kept
    out.info["PlayResX"] = args.video_w
    out.info["PlayResY"] = args.video_h
    out.info["WrapStyle"] = "0"
    out.info["ScaledBorderAndShadow"] = "yes"

    style_obj = pysubs2.SSAStyle()
    style_obj.fontname = style.get("font_name", "DejaVu Sans")
    style_obj.fontsize = int(style.get("font_size", 56))
    style_obj.primarycolor = hex_to_ass_color(style.get("font_color", "#FFFFFF"))
    style_obj.outlinecolor = hex_to_ass_color(style.get("outline_color", "#000000"))
    style_obj.outline = int(style.get("outline_width", 3))
    style_obj.shadow = 0
    style_obj.bold = style.get("bold", True)
    style_obj.alignment = pysubs2.Alignment.BOTTOM_CENTER
    # Vertical position: place baseline at vertical_pct% from top.
    # ASS MarginV is the margin from the bottom in pixels.
    vertical_pct = int(style.get("vertical_pct", 80))
    style_obj.marginv = max(0, args.video_h - int(args.video_h * vertical_pct / 100))
    style_obj.marginl = 80
    style_obj.marginr = 80
    out.styles["Default"] = style_obj
    for ev in out.events:
        ev.style = "Default"

    out.save(args.out, format_="ass")
    print(f"wrote {len(out.events)} subtitle events to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
