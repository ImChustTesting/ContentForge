import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';

export function dataDir() { return DATA_DIR; }

export function uploadsPath(jobId, file = '') {
  return path.join(DATA_DIR, 'uploads', jobId, file);
}
export function captionsPath(jobId, file = '') {
  return path.join(DATA_DIR, 'captions', jobId, file);
}
export function editedPath(jobId, file = '') {
  return path.join(DATA_DIR, 'edited', jobId, file);
}
export function clipsPath(jobId, file = '') {
  return path.join(DATA_DIR, 'clips', jobId, file);
}
export function thumbsPath(jobId, file = '') {
  return path.join(DATA_DIR, 'thumbs', jobId, file);
}
export function workPath(jobId, file = '') {
  return path.join(DATA_DIR, 'work', jobId, file);
}
