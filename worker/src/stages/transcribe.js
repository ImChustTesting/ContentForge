import path from 'node:path';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execShell } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { getBoss } from '../lib/queue.js';
import {
  setJobStatus, getSourcePath, registerAsset, logExecution
} from '../lib/repo.js';
import { captionsPath } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON_BIN || 'python3';
const WHISPER_PY = path.resolve(__dirname, '..', 'python', 'whisper.py');

export async function runTranscribe(jobs) {
  const { jobId } = jobs[0].data;
  const started = new Date();

  await setJobStatus(jobId, 'transcribing');
  await logExecution(jobId, null, 'transcribe', 'started', { started_at: started });

  const sourcePath = await getSourcePath(jobId);
  if (!sourcePath) throw new Error(`source asset missing for job ${jobId}`);

  const dir = captionsPath(jobId);
  await mkdir(dir, { recursive: true });

  const wavPath = path.join(dir, 'audio.wav');
  await execShell('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', sourcePath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    wavPath
  ], { timeoutMs: 30 * 60 * 1000 });

  const srtPath = path.join(dir, 'full.srt');
  const cuesJsonPath = path.join(dir, 'cues.json');
  const model = process.env.WHISPER_MODEL || 'small';

  await execShell(PYTHON, [
    WHISPER_PY,
    '--audio', wavPath,
    '--srt-out', srtPath,
    '--json-out', cuesJsonPath,
    '--model', model,
    '--compute', 'int8'
  ], { timeoutMs: 60 * 60 * 1000 });

  const srtSize = (await stat(srtPath)).size;
  const cuesSize = (await stat(cuesJsonPath)).size;
  await registerAsset(jobId, 'srt', srtPath, srtSize);
  await registerAsset(jobId, 'cues', cuesJsonPath, cuesSize);

  // Sanity: cues should not be empty.
  const raw = await readFile(cuesJsonPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`cues.json malformed: ${e.message}`); }
  if (!parsed.cues?.length) {
    throw new Error('whisper produced no cues — silent or unintelligible source');
  }

  await setJobStatus(jobId, 'segmenting');
  const boss = await getBoss();
  await boss.send('segment', { jobId });

  await logExecution(jobId, null, 'transcribe', 'ok', {
    started_at: started,
    finished_at: new Date(),
    duration_ms: Date.now() - started.getTime(),
    result: { cues: parsed.cues.length, language: parsed.language }
  });
  logger.info({ jobId, cueCount: parsed.cues.length }, 'transcribe complete');
}
