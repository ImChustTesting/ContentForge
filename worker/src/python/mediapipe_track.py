#!/usr/bin/env python3
"""Per-frame face centroid CSV using the MediaPipe Tasks vision API."""
import argparse
import csv
import sys

import cv2
import mediapipe as mp


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--model", default="/opt/models/face_detector_short_range.tflite")
    p.add_argument("--min-confidence", type=float, default=0.4)
    args = p.parse_args()

    BaseOptions = mp.tasks.BaseOptions
    FaceDetector = mp.tasks.vision.FaceDetector
    FaceDetectorOptions = mp.tasks.vision.FaceDetectorOptions
    VisionRunningMode = mp.tasks.vision.RunningMode

    options = FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        running_mode=VisionRunningMode.IMAGE,
        min_detection_confidence=args.min_confidence,
    )

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"could not open {args.video}", file=sys.stderr)
        return 2
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w_in = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_in = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    written = 0
    detected = 0
    with FaceDetector.create_from_options(options) as detector, \
         open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["frame_idx", "t_ms", "x_center", "y_center", "confidence", "w_in", "h_in"])
        idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            t_ms = int((idx / fps) * 1000)
            mp_image = mp.Image(
                image_format=mp.ImageFormat.SRGB,
                data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB),
            )
            res = detector.detect(mp_image)
            x = -1.0
            y = -1.0
            score = 0.0
            if res.detections:
                # Largest face wins
                best = max(res.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height)
                bb = best.bounding_box
                x = bb.origin_x + bb.width / 2.0
                y = bb.origin_y + bb.height / 2.0
                score = best.categories[0].score if best.categories else 1.0
                detected += 1
            writer.writerow([idx, t_ms, f"{x:.1f}", f"{y:.1f}", f"{score:.3f}", w_in, h_in])
            written += 1
            idx += 1
    cap.release()
    print(f"wrote {written} rows ({detected} with faces) for fps={fps}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
