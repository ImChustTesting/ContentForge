import path from 'node:path';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { execShell } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { getBoss } from '../lib/queue.js';
import {
  loadClip, loadJob, getSourcePath,
  registerAsset, setClipStatus, setJobStatus, logExecution
} from '../lib/repo.js';
import { editedPath } from '../lib/paths.js';

const ENCODE_PRESET = process.env.ENCODE_PRESET || 'veryfast';

export async function runEdit(jobs) {
  const { jobId, clipId } = jobs[0].data;
  const started = new Date();
  await logExecution(jobId, clipId, 'edit', 'started', { started_at: started });

  const job = await loadJob(jobId);
  const clip = await loadClip(clipId);
  if (!job || !clip) throw new Error('job or clip missing');

  if (job.status !== 'editing' && job.status !== 'reframing' && job.status !== 'finalizing') {
    await setJobStatus(jobId, 'editing');
  }
  await setClipStatus(clipId, 'editing');

  const sourcePath = await getSourcePath(jobId);
  if (!sourcePath) throw new Error('source missing');

  const dir = editedPath(jobId);
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${clip.clip_index}.mp4`);
  const tmpCut = path.join(dir, `${clip.clip_index}.cut.mp4`);
  const tmpTrim = path.join(dir, `${clip.clip_index}.trim.mp4`);

  // Step 1: cut to clip range. Re-encode (not stream copy) so the start frame is exact.
  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', secondsOf(clip.start_ms),
    '-to', secondsOf(clip.end_ms),
    '-i', sourcePath,
    '-c:v', 'libx264', '-preset', ENCODE_PRESET, '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    tmpCut
  ], { timeoutMs: 30 * 60 * 1000 });

  // Step 2: auto-editor for silence trim. It defaults to *_ALTERED.mp4 if --output omitted;
  // we pass --output to be explicit and rename if needed.
  let trimmed = tmpTrim;
  try {
    await execShell('auto-editor', [
      tmpCut,
      '--silent-threshold', '0.04',
      '--margin', '0.2sec',
      '-o', tmpTrim
    ], { timeoutMs: 30 * 60 * 1000 });
  } catch (err) {
    // Some auto-editor versions fail on very short clips; fall back to the cut version.
    logger.warn({ err: err.message, clipId }, 'auto-editor failed; using cut without silence trim');
    trimmed = tmpCut;
  }

  // Step 3: audio chain — denoise + EBU R128 loudnorm. Video is copied through.
  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', trimmed,
    '-af', 'afftdn=nt=w:nf=-25, loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    out
  ], { timeoutMs: 30 * 60 * 1000 });

  await safeUnlink(tmpCut);
  if (trimmed !== tmpCut) await safeUnlink(tmpTrim);

  const size = (await stat(out)).size;
  await registerAsset(jobId, 'edited', out, size);

  // Trigger reframe
  await setJobStatus(jobId, 'reframing');
  await setClipStatus(clipId, 'reframing');
  const boss = await getBoss();
  await boss.send('reframe', { jobId, clipId });

  await logExecution(jobId, clipId, 'edit', 'ok', {
    started_at: started, finished_at: new Date(),
    duration_ms: Date.now() - started.getTime(),
    result: { out, size }
  });
  logger.info({ jobId, clipId, out }, 'edit stage done');
}

function secondsOf(ms) {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3);
}

async function safeUnlink(p) {
  await unlink(p).catch(() => {});
}
