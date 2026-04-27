import { readFile } from 'node:fs/promises';

// Read the centroids CSV and produce an ffmpeg crop x-expression.
// The CSV has columns: frame_idx, t_ms, x_center, y_center, confidence, w_in, h_in
// (a -1 x means "no face detected this frame"; we fall back to center).
//
// Output crop is 9:16 around the smoothed x. The expression uses ffmpeg's `if(...)`
// chain with `t` (seconds) so a single `crop` filter follows the trajectory without
// a sendcmd file. For clips up to ~120s this stays small.

export async function buildCropExprFromCsv(csvPath, opts = {}) {
  const {
    smoothingAlpha = 0.18,
    minConfidence = 0.35,
    cropPixels = null,         // override; defaults to ih*9/16 in ffmpeg
    sampleEveryMs = 80          // sample frequency for the if-chain (12.5 fps)
  } = opts;

  const text = await readFile(csvPath, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('centroid CSV is empty');

  const header = lines.shift().split(',');
  const idx = (name) => header.indexOf(name);
  const ix = idx('x_center'), iy = idx('y_center'),
        ic = idx('confidence'), it = idx('t_ms'),
        iw = idx('w_in'), ih = idx('h_in');

  const points = [];
  let widthIn = 0, heightIn = 0;
  for (const line of lines) {
    const cols = line.split(',');
    const x = Number(cols[ix]);
    const c = Number(cols[ic]);
    const t = Number(cols[it]);
    if (!widthIn) { widthIn = Number(cols[iw]); heightIn = Number(cols[ih]); }
    points.push({ t, x, c });
  }
  if (!points.length) throw new Error('no centroid points');

  // Replace low-confidence frames with center fallback for the smoothing input.
  const center = widthIn / 2;
  let prev = center;
  const smoothed = [];
  for (const pt of points) {
    const usable = pt.x >= 0 && pt.c >= minConfidence;
    const observed = usable ? pt.x : center;
    prev = smoothingAlpha * observed + (1 - smoothingAlpha) * prev;
    smoothed.push({ t: pt.t, x: prev, used: usable });
  }

  // Downsample: take one point per `sampleEveryMs`.
  const sampled = [];
  let nextT = 0;
  for (const s of smoothed) {
    if (s.t >= nextT) {
      sampled.push(s);
      nextT = s.t + sampleEveryMs;
    }
  }
  if (sampled.length === 0) sampled.push(smoothed[0]);

  // The crop width is ih * 9/16 = 0.5625 * ih  (height stays = ih).
  // We need x_center for the centroid; ffmpeg's crop x = x_center - cropWidth/2.
  // We clamp x to [0, w_in - cropWidth].
  // The expression therefore does: max(0, min(w_in - cw, x_smoothed - cw/2))
  // We embed the trajectory as nested if(lt(t,T1), x1, if(lt(t,T2), x2, ...))
  const cwExpr = cropPixels != null ? String(cropPixels) : 'ih*9/16';
  const wInExpr = String(widthIn);

  // Build x_center expression as an if-chain.
  let xExpr = String(Math.round(sampled[sampled.length - 1].x));
  for (let i = sampled.length - 2; i >= 0; i--) {
    const T = (sampled[i + 1].t / 1000).toFixed(3);
    const xi = Math.round(sampled[i].x);
    xExpr = `if(lt(t,${T}),${xi},${xExpr})`;
  }

  // crop X (top-left): clamp(x_center - cw/2, 0, w_in - cw)
  const cropX = `max(0,min(${wInExpr}-(${cwExpr}),(${xExpr})-((${cwExpr})/2)))`;

  // Also count how many frames were unusable for diagnostics
  const totalFrames = smoothed.length;
  const usableFrames = smoothed.filter((s) => s.used).length;

  return {
    cropExpr: cropX,
    cropWidth: cwExpr,
    inputWidth: widthIn,
    inputHeight: heightIn,
    samples: sampled.length,
    totalFrames,
    usableFrames
  };
}
