# Smoke test fixtures

The smoke test in `worker/test/smoke/smoke.test.js` looks for `sample.mp4` here. It's
intentionally not committed because:

1. We don't have a CC0 / public-domain talking-head clip with clear speech vetted
   for redistribution under MIT.
2. A 60-second 1080p MP4 is ~10 MB, which is annoying in git history.

To produce one locally:

```bash
# A synthetic test pattern with a 1 kHz tone — enough to verify ffmpeg/whisper plumbing,
# not enough to verify clip selection quality.
ffmpeg -y -f lavfi -i testsrc=duration=60:size=1280x720:rate=30 \
       -f lavfi -i sine=frequency=440:duration=60 \
       -shortest -c:v libx264 -preset veryfast -c:a aac \
       sample.mp4
```

For a real talking-head fixture you would:

- Record a 60-second clip yourself and license it CC0.
- Or take a short clip from Wikimedia Commons that ships under CC-BY-SA. Note
  that distributing that under MIT in your own repo is **not** permitted — you'd
  need to keep it out of git and download at test time, or stick to CC0.
