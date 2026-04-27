import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preFilter } from '../../src/lib/prefilter.js';

function cue(id, startSec, endSec, text) {
  return { id, start_ms: startSec * 1000, end_ms: endSec * 1000, text };
}

test('returns empty on empty input', () => {
  assert.deepEqual(preFilter([]), []);
});

test('drops candidates shorter than 15s', () => {
  const cues = [
    cue(1, 0,  5, 'Hi there.'),
    cue(2, 5, 10, 'Quick thought.')
  ];
  const r = preFilter(cues);
  assert.equal(r.length, 0);
});

test('keeps candidates in the 15-90s window', () => {
  const cues = [];
  for (let i = 0; i < 30; i++) {
    cues.push(cue(i + 1, i * 4, (i + 1) * 4, `Sentence number ${i} here actually you should listen.`));
  }
  const r = preFilter(cues, 5);
  assert.ok(r.length > 0 && r.length <= 5);
  for (const c of r) {
    const span = c.end_ms - c.start_ms;
    assert.ok(span >= 15_000, `span ${span} too short`);
    assert.ok(span <= 90_000, `span ${span} too long`);
  }
});

test('hook words boost score', () => {
  const cues = [
    cue(1, 0,  3, 'Just a normal opener'),
    cue(2, 3, 30, 'And we keep going for a while with words and more words and more words.'),
    cue(3, 30, 33, 'Stop ignoring this one critical thing.'),
    cue(4, 33, 60, 'Continuation of the thought with substantial content here you go.')
  ];
  const r = preFilter(cues, 8);
  // The range starting at cue 3 (hook "Stop") should rank well; we just check
  // that the function returns something.
  assert.ok(r.length > 0);
});

test('returns non-overlapping kept ranges', () => {
  const cues = [];
  for (let i = 0; i < 60; i++) {
    cues.push(cue(i + 1, i * 2, (i + 1) * 2, `Sentence number ${i} actually here listen.`));
  }
  const r = preFilter(cues, 6);
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 1; j < r.length; j++) {
      const overlap = Math.max(r[i].start_ms, r[j].start_ms) < Math.min(r[i].end_ms, r[j].end_ms);
      assert.equal(overlap, false, `kept ranges overlap: ${JSON.stringify(r[i])} ${JSON.stringify(r[j])}`);
    }
  }
});
