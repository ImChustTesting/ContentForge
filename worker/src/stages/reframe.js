import path from 'node:path';
import { mkdir, stat, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execShell } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { getBoss } from '../lib/queue.js';
import {
  loadJob, loadClip, getAsset, getClipAsset, getBrandConfig,
  registerAsset, setClipStatus, setJobStatus, logExecution
} from '../lib/repo.js';
import { buildCropExprFromCsv } from '../lib/smoothing.js';
import { editedPath, clipsPath, captionsPath, workPath } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON_BIN || 'python3';
const TRACK_PY = path.resolve(__dirname, '..', 'python', 'mediapipe_track.py');
const ASS_PY = path.resolve(__dirname, '..', 'python', 'ass_render.py');

const ENCODE_PRESET = process.env.ENCODE_PRESET || 'veryfast';
const OUT_W = 1080;
const OUT_H = 1920;

export async function runReframe(jobs) {
  const { jobId, clipId } = jobs[0].data;
  const started = new Date();
  await logExecution(jobId, clipId, 'reframe', 'started', { started_at: started });

  const job = await loadJob(jobId);
  const clip = await loadClip(clipId);
  if (!job || !clip) throw new Error('job or clip missing');

  await setClipStatus(clipId, 'reframing');

  const editedAsset = await getClipAsset(clipId, 'edited');
  if (!editedAsset) {
    // Try the per-job lookup fallback (we only have one edited per clip but kind-by-job doesn't filter clip_index)
    const e = await getAsset(jobId, 'edited');
    if (!e) throw new Error('no edited asset for clip');
  }
  const editedFile = path.join(editedPath(jobId), `${clip.clip_index}.mp4`);

  await mkdir(clipsPath(jobId), { recursive: true });
  const out = path.join(clipsPath(jobId), `${clip.clip_index}.mp4`);
  const work = workPath(jobId);
  await mkdir(work, { recursive: true });

  const brand = await getBrandConfig();
  const styleJsonPath = path.join(work, `style-${clip.clip_index}.json`);
  await writeFile(styleJsonPath, JSON.stringify({
    font_name: brand.font_name,
    font_size: brand.font_size,
    font_color: brand.font_color,
    outline_color: brand.outline_color,
    outline_width: brand.outline_width,
    vertical_pct: brand.vertical_pct
  }));

  // Render captions ASS from the SRT, sliced to this clip's range.
  // The clip's edited file starts at t=0 (we already cut), but auto-editor may have
  // removed silence. For caption alignment, we use the edited file's effective duration
  // and slice the original SRT by [clip.start_ms, clip.end_ms]. This is a known small
  // imperfection: silence-removed mid-clip captions can drift. Acceptable for v1; the
  // alternative is an ffprobe-based rebuild we can ship in v0.2.
  const srtAsset = await getAsset(jobId, 'srt');
  if (!srtAsset) throw new Error('no SRT asset for job');
  const assPath = path.join(work, `captions-${clip.clip_index}.ass`);
  await execShell(PYTHON, [
    ASS_PY,
    '--srt', srtAsset.path,
    '--out', assPath,
    '--style-json', styleJsonPath,
    '--start-ms', String(clip.start_ms),
    '--end-ms', String(clip.end_ms),
    '--video-w', String(OUT_W),
    '--video-h', String(OUT_H)
  ]);

  if (clip.mode === 'TRACK') {
    await runTrack(jobId, clipId, clip, editedFile, assPath, out, work);
  } else {
    await runGeneral(jobId, clipId, clip, editedFile, assPath, out);
  }

  const size = (await stat(out)).size;
  const asset = await registerAsset(jobId, 'clip', out, size);
  await import('../lib/db.js').then(({ pool }) =>
    pool.query('UPDATE clips SET mp4_asset_id = $1 WHERE id = $2', [asset.id, clipId])
  );

  await setClipStatus(clipId, 'finalizing');
  await setJobStatus(jobId, 'finalizing');
  const boss = await getBoss();
  await boss.send('finalize', { jobId, clipId });

  await logExecution(jobId, clipId, 'reframe', 'ok', {
    started_at: started, finished_at: new Date(),
    duration_ms: Date.now() - started.getTime(),
    result: { out, size, mode: clip.mode }
  });
  logger.info({ jobId, clipId, mode: clip.mode, out }, 'reframe stage done');
}

async function runTrack(jobId, clipId, clip, editedFile, assPath, out, work) {
  // 1. Downscale to 720p for face detection (much faster than 1080p)
  const small = path.join(work, `${clip.clip_index}.720.mp4`);
  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', editedFile,
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-an',
    small
  ], { timeoutMs: 30 * 60 * 1000 });

  // 2. MediaPipe → CSV
  const csv = path.join(work, `${clip.clip_index}.faces.csv`);
  await execShell(PYTHON, [
    TRACK_PY,
    '--video', small,
    '--out', csv,
    '--model', process.env.FACE_MODEL_PATH || '/opt/models/face_detector_short_range.tflite'
  ], { timeoutMs: 30 * 60 * 1000 });

  // 3. Smoothing → crop expression
  const { cropExpr, cropWidth, samples, totalFrames, usableFrames } = await buildCropExprFromCsv(csv);
  const usableRatio = totalFrames ? usableFrames / totalFrames : 0;
  logger.info({ clipId, samples, totalFrames, usableFrames, usableRatio }, 'face track summary');

  // If we lost the face for too much of the clip, fall back to GENERAL center-crop layout.
  if (usableRatio < 0.4) {
    logger.warn({ clipId, usableRatio }, 'face confidence too low — falling back to GENERAL mode');
    return runGeneral(jobId, clipId, clip, editedFile, assPath, out);
  }

  // 4. Final encode: crop + scale to 1080x1920 + caption burn-in
  const vf = [
    `crop=${cropWidth}:ih:${cropExpr}:0`,
    `scale=${OUT_W}:${OUT_H}:flags=lanczos`,
    `ass=${escapeFilterPath(assPath)}`
  ].join(',');

  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', editedFile,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', ENCODE_PRESET, '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    out
  ], { timeoutMs: 60 * 60 * 1000 });

  await unlink(small).catch(() => {});
  await unlink(csv).catch(() => {});
}

async function runGeneral(jobId, clipId, clip, editedFile, assPath, out) {
  // Blurred 9:16 background (scaled-up + boxblur), original 16:9 foreground centered.
  const fc = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=20:5[bgblur]`,
    `[fg]scale=${OUT_W}:-2:flags=lanczos[fgs]`,
    `[bgblur][fgs]overlay=(W-w)/2:(H-h)/2,ass=${escapeFilterPath(assPath)}[v]`
  ].join(';');

  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', editedFile,
    '-filter_complex', fc,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', ENCODE_PRESET, '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    out
  ], { timeoutMs: 60 * 60 * 1000 });
}

// ffmpeg's `ass=` filter argument needs colons and backslashes escaped. On Linux
// containers paths don't include drive letters but we still escape colons in case.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
