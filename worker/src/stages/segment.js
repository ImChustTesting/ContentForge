import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTx } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import {
  setJobStatus, getAsset, loadJob, getDecryptedAnthropicKey,
  logExecution, getBrandConfig
} from '../lib/repo.js';
import { preFilter } from '../lib/prefilter.js';
import { makeClient, rankSegments } from '../lib/anthropic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', 'lib', 'prompts', 'segment.txt');

const TARGET_COUNT_DEFAULT = 5;

export async function runSegment(jobs) {
  const { jobId } = jobs[0].data;
  const started = new Date();
  await logExecution(jobId, null, 'segment', 'started', { started_at: started });

  const job = await loadJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const cuesAsset = await getAsset(jobId, 'cues');
  if (!cuesAsset) throw new Error(`no cues asset for job ${jobId}`);

  const cuesPayload = JSON.parse(await readFile(cuesAsset.path, 'utf8'));
  const cues = cuesPayload.cues ?? [];
  if (!cues.length) throw new Error('cues file is empty');

  const candidates = preFilter(cues, 12);
  if (!candidates.length) {
    throw new Error('pre-filter produced 0 candidates — source may be too short or too uniform');
  }
  logger.info({ jobId, candidates: candidates.length }, 'pre-filter done');

  const apiKey = await getDecryptedAnthropicKey(job.user_id);
  const client = makeClient(apiKey);

  const promptTpl = await readFile(PROMPT_PATH, 'utf8');
  const brand = await getBrandConfig();
  const systemPrompt = promptTpl.replace('{{BRAND_VOICE}}', brand?.brand_voice || '(none specified)');

  const targetCount = clamp(
    Number(job.metadata?.target_clips ?? TARGET_COUNT_DEFAULT),
    3, 10
  );

  const { clips, usage } = await rankSegments(client, {
    systemPrompt,
    candidates,
    targetCount
  });
  logger.info({ jobId, picked: clips.length, usage }, 'Claude returned picks');

  // Validate that returned cue IDs are actually in the cue list
  const cueIds = new Set(cues.map((c) => c.id));
  const cueByid = new Map(cues.map((c) => [c.id, c]));
  const valid = clips.filter((c) => cueIds.has(c.startCueId) && cueIds.has(c.endCueId) && c.startCueId <= c.endCueId);

  if (valid.length === 0) {
    throw new Error('Claude returned no valid clips (all cue IDs out of range)');
  }
  if (valid.length < clips.length) {
    logger.warn({ dropped: clips.length - valid.length }, 'dropped Claude clips with invalid cue IDs');
  }

  const mode = (job.speaker_count === 2 && job.camera_count === 1) ? 'GENERAL' : 'TRACK';

  await withTx(async (db) => {
    await db.query('DELETE FROM clips WHERE job_id = $1', [jobId]);
    let idx = 1;
    for (const c of valid) {
      const startCue = cueByid.get(c.startCueId);
      const endCue = cueByid.get(c.endCueId);
      if (!startCue || !endCue) continue;
      await db.query(
        `INSERT INTO clips
           (job_id, clip_index, start_ms, end_ms, mode,
            approved, draft_title, draft_caption, reason, status)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8, 'pending')`,
        [
          jobId, idx,
          startCue.start_ms, endCue.end_ms, mode,
          c.title, c.draftCaption, c.reason
        ]
      );
      idx++;
    }
  });

  await setJobStatus(jobId, 'awaiting_approval');
  await logExecution(jobId, null, 'segment', 'ok', {
    started_at: started,
    finished_at: new Date(),
    duration_ms: Date.now() - started.getTime(),
    result: {
      candidates: candidates.length,
      picked: valid.length,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
      cache_read_input_tokens: usage?.cache_read_input_tokens,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens
    }
  });
  logger.info({ jobId, valid: valid.length }, 'segment stage done; awaiting approval');
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
