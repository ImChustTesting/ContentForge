// Rule-based pre-filter: produce ~12 candidate ranges from a cue list.
// Heuristics: 15–90s duration, hook-word boost on first cue, caption density,
// no overlap once kept.

const HOOK_WORDS = /\b(you|stop|never|imagine|actually|secret|truth|wrong|right|listen|here'?s|why|how|let me|you'?re|i'?ll|the trick|the thing|three|five|seven)\b/i;

const MIN_MS = 15_000;
const MAX_MS = 90_000;
const DEFAULT_TARGET = 12;

export function preFilter(cues, target = DEFAULT_TARGET) {
  if (!Array.isArray(cues) || cues.length === 0) return [];

  const candidates = [];
  for (let i = 0; i < cues.length; i++) {
    let endIdx = i;
    for (let j = i + 1; j < cues.length; j++) {
      const span = cues[j].end_ms - cues[i].start_ms;
      if (span < MIN_MS) continue;
      if (span > MAX_MS) break;
      endIdx = j;
      const text = sliceText(cues, i, j);
      const score = scoreRange(cues[i], text, span);
      candidates.push({
        startCueId: cues[i].id,
        endCueId: cues[j].id,
        start_ms: cues[i].start_ms,
        end_ms: cues[j].end_ms,
        text,
        score
      });
    }
    if (endIdx === i) continue;
  }

  candidates.sort((a, b) => b.score - a.score);

  const kept = [];
  for (const c of candidates) {
    if (kept.length >= target) break;
    const overlaps = kept.some(
      (k) => Math.max(c.start_ms, k.start_ms) < Math.min(c.end_ms, k.end_ms)
    );
    if (overlaps) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.start_ms - b.start_ms);
}

function sliceText(cues, i, j) {
  let s = '';
  for (let k = i; k <= j; k++) s += cues[k].text + ' ';
  return s.trim();
}

function scoreRange(firstCue, text, spanMs) {
  let score = 0;

  // Hook in opener
  if (HOOK_WORDS.test(firstCue.text || '')) score += 4;

  // Caption density (chars per second). 12 cps is conversational; reward higher.
  const cps = (text.length / spanMs) * 1000;
  score += Math.min(cps, 30) / 6;

  // Prefer ends that look like a sentence end
  if (/[.!?]\s*$/.test(text)) score += 1.5;

  // Penalize very short or very long extremes within the allowed window
  const seconds = spanMs / 1000;
  const sweet = seconds >= 25 && seconds <= 60 ? 1 : 0;
  score += sweet;

  // Penalize a lot of single-word filler ("um", "uh")
  const fillers = (text.match(/\b(um+|uh+|like|y'?know)\b/gi) || []).length;
  score -= Math.min(fillers, 6) * 0.3;

  return score;
}
