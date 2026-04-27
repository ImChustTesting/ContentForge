import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildCropExprFromCsv } from '../../src/lib/smoothing.js';

async function withCsv(rows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cf-smooth-'));
  const csvPath = path.join(dir, 'faces.csv');
  const header = 'frame_idx,t_ms,x_center,y_center,confidence,w_in,h_in';
  const body = rows.map((r) => r.join(',')).join('\n');
  await writeFile(csvPath, `${header}\n${body}\n`);
  return csvPath;
}

test('builds a crop expression with at least one if(...) chain element', async () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push([i, i * 33, 640, 360, 0.95, 1280, 720]);
  }
  const csv = await withCsv(rows);
  const r = await buildCropExprFromCsv(csv);
  assert.ok(r.cropExpr.length > 0);
  assert.ok(r.cropExpr.includes('max(') && r.cropExpr.includes('min('), r.cropExpr);
  assert.equal(r.inputWidth, 1280);
  assert.equal(r.inputHeight, 720);
});

test('falls back to center for low-confidence frames', async () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push([i, i * 33, -1, -1, 0.0, 1280, 720]);
  }
  const csv = await withCsv(rows);
  const r = await buildCropExprFromCsv(csv);
  assert.ok(r.cropExpr.includes('640'), 'expected center-x (640) in fallback expression');
  assert.equal(r.usableFrames, 0);
});

test('reports usable ratio honestly', async () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const usable = i % 2 === 0;
    rows.push([i, i * 33, usable ? 700 : -1, usable ? 360 : -1, usable ? 0.9 : 0.0, 1280, 720]);
  }
  const csv = await withCsv(rows);
  const r = await buildCropExprFromCsv(csv);
  assert.equal(r.totalFrames, 100);
  assert.equal(r.usableFrames, 50);
});
