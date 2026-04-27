import path from 'node:path';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execShell } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import {
  loadJob, loadClip, getAsset, getDecryptedAnthropicKey, getBrandConfig,
  registerAsset, setClipStatus, setJobStatus, logExecution
} from '../lib/repo.js';
import { makeClient, draftFinalCaption } from '../lib/anthropic.js';
import { thumbsPath, clipsPath } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', 'lib', 'prompts', 'caption.txt');

export async function runFinalize(jobs) {
  const { jobId, clipId } = jobs[0].data;
  const started = new Date();
  await logExecution(jobId, clipId, 'finalize', 'started', { started_at: started });

  const job = await loadJob(jobId);
  const clip = await loadClip(clipId);
  if (!job || !clip) throw new Error('job or clip missing');

  await setClipStatus(clipId, 'finalizing');

  // Thumbnail at clip midpoint from the rendered 9:16 clip
  const clipMp4 = path.join(clipsPath(jobId), `${clip.clip_index}.mp4`);
  await mkdir(thumbsPath(jobId), { recursive: true });
  const thumbPath = path.join(thumbsPath(jobId), `${clip.clip_index}.jpg`);

  const durationMs = Math.max(1, clip.end_ms - clip.start_ms);
  const midSec = (durationMs / 2 / 1000).toFixed(2);

  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', midSec,
    '-i', clipMp4,
    '-frames:v', '1',
    '-q:v', '3',
    thumbPath
  ], { timeoutMs: 60_000 });

  const thumbAsset = await registerAsset(jobId, 'thumb', thumbPath, (await stat(thumbPath)).size);
  await pool.query('UPDATE clips SET thumb_asset_id = $1 WHERE id = $2', [thumbAsset.id, clipId]);

  // Final caption pass via Claude
  const apiKey = await getDecryptedAnthropicKey(job.user_id);
  const client = makeClient(apiKey);
  const promptTpl = await readFile(PROMPT_PATH, 'utf8');
  const brand = await getBrandConfig();
  const systemPrompt = promptTpl.replace('{{BRAND_VOICE}}', brand?.brand_voice || '(none specified)');
  const transcript = await loadTranscriptRange(jobId, clip.start_ms, clip.end_ms);

  const { ig, li, hashtags, usage } = await draftFinalCaption(client, {
    systemPrompt,
    title: clip.draft_title,
    transcript
  });

  await pool.query(`
    UPDATE clips
    SET final_caption_ig = $1, final_caption_li = $2, hashtags = $3,
        status = 'ready', updated_at = NOW()
    WHERE id = $4
  `, [ig, li, hashtags, clipId]);

  await maybeMarkJobReady(jobId);

  await logExecution(jobId, clipId, 'finalize', 'ok', {
    started_at: started, finished_at: new Date(),
    duration_ms: Date.now() - started.getTime(),
    result: {
      thumb: thumbPath,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens
    }
  });
  logger.info({ jobId, clipId }, 'finalize stage done');
}

async function loadTranscriptRange(jobId, startMs, endMs) {
  const cuesAsset = await getAsset(jobId, 'cues');
  if (!cuesAsset) return '(transcript unavailable)';
  const data = JSON.parse(await readFile(cuesAsset.path, 'utf8'));
  const cues = (data.cues ?? []).filter(
    (c) => c.end_ms > startMs && c.start_ms < endMs
  );
  return cues.map((c) => c.text).join(' ').trim() || '(empty range)';
}

async function maybeMarkJobReady(jobId) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'ready') AS ready_n,
      COUNT(*)                                  AS total_n,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_n
    FROM clips WHERE job_id = $1 AND approved
  `, [jobId]);
  const { ready_n, total_n, failed_n } = rows[0];
  if (Number(total_n) === 0) return;
  if (Number(ready_n) === Number(total_n)) {
    await setJobStatus(jobId, 'ready');
  } else if (Number(failed_n) > 0 && Number(ready_n) + Number(failed_n) === Number(total_n)) {
    await setJobStatus(jobId, 'failed', { last_error: 'one or more clips failed' });
  }
}
