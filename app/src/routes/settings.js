import express from 'express';
import { z } from 'zod';
import { pool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { renderPage } from '../lib/views.js';
import { encrypt } from '../lib/encryption.js';
import { testAnthropicKey } from '../lib/anthropic-test.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

const brandSchema = z.object({
  font_name: z.string().min(1).max(80),
  font_size: z.coerce.number().int().min(12).max(200),
  font_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  outline_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  outline_width: z.coerce.number().int().min(0).max(20),
  vertical_pct: z.coerce.number().int().min(0).max(100),
  brand_voice: z.string().max(2000).optional().nullable()
});

router.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const { rows: brand } = await pool.query('SELECT * FROM brand_config WHERE id = 1');
    const usage = await dataVolumeUsage();
    const html = await renderPage('settings.html', {
      brand: brand[0],
      usage,
      success: req.query.ok,
      error: req.query.err
    });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/api/settings/brand', requireAuth, async (req, res, next) => {
  try {
    const parsed = brandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.redirect('/settings?err=invalid');
    }
    const b = parsed.data;
    await pool.query(
      `UPDATE brand_config
       SET font_name = $1, font_size = $2, font_color = $3,
           outline_color = $4, outline_width = $5, vertical_pct = $6,
           brand_voice = $7
       WHERE id = 1`,
      [b.font_name, b.font_size, b.font_color, b.outline_color, b.outline_width, b.vertical_pct, b.brand_voice ?? null]
    );
    res.redirect('/settings?ok=brand');
  } catch (err) {
    next(err);
  }
});

router.post('/api/settings/key', requireAuth, async (req, res, next) => {
  try {
    const { anthropicKey } = req.body ?? {};
    if (!anthropicKey || typeof anthropicKey !== 'string') {
      return res.redirect('/settings?err=missing-key');
    }
    const test = await testAnthropicKey(anthropicKey.trim());
    if (!test.ok) {
      return res.redirect(`/settings?err=${encodeURIComponent('key-test:' + test.message)}`);
    }
    const blob = encrypt(anthropicKey.trim(), process.env.ENCRYPTION_KEY);
    await pool.query(
      `INSERT INTO user_secrets (user_id, anthropic_key)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         anthropic_key = EXCLUDED.anthropic_key,
         updated_at = NOW()`,
      [req.session.userId, blob]
    );
    logger.info({ userId: req.session.userId }, 'anthropic key replaced');
    res.redirect('/settings?ok=key');
  } catch (err) {
    next(err);
  }
});

async function dataVolumeUsage() {
  const { rows } = await pool.query(`
    SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0)::BIGINT AS total
    FROM assets GROUP BY kind ORDER BY kind
  `);
  return rows.map((r) => ({
    kind: r.kind,
    count: Number(r.n),
    total_bytes: Number(r.total),
    total_mb: (Number(r.total) / 1024 / 1024).toFixed(1)
  }));
}

export default router;
