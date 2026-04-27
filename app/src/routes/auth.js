import express from 'express';
import { pool, withTx } from '../lib/db.js';
import { renderPage } from '../lib/views.js';
import { encrypt } from '../lib/encryption.js';
import { hashPassword, checkPassword, getOnlyUser } from '../lib/auth.js';
import { testAnthropicKey } from '../lib/anthropic-test.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

router.get('/setup', async (req, res, next) => {
  try {
    const existing = await getOnlyUser();
    if (existing) return res.redirect('/login');
    const html = await renderPage('setup-wizard.html', { step: 1 });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/api/test-key', async (req, res) => {
  const { anthropicKey } = req.body ?? {};
  if (!anthropicKey || typeof anthropicKey !== 'string') {
    return res.status(400).type('html').send(
      '<p class="error">Paste your Anthropic API key first.</p>'
    );
  }
  const result = await testAnthropicKey(anthropicKey.trim());
  if (result.ok) {
    return res.type('html').send(
      `<p class="ok">Connected ✓ — Claude responded: "${escapeHtml(result.text)}"</p>` +
      `<button type="submit" name="action" value="save" class="primary">Save and continue</button>`
    );
  }
  return res.status(400).type('html').send(
    `<p class="error">Key test failed (${result.status ?? 'network'}): ${escapeHtml(result.message)}</p>` +
    `<button type="button" hx-post="/api/test-key" hx-include="closest form" hx-target="#test-result">Retry test</button>`
  );
});

router.post('/setup', async (req, res, next) => {
  try {
    const existing = await getOnlyUser();
    if (existing) return res.status(403).send('Already set up');

    const { email, password, passwordConfirm, anthropicKey, action } = req.body ?? {};
    if (action !== 'save') {
      return res.status(400).send('Please test your Anthropic key first.');
    }
    if (!password || password.length < 8) {
      const html = await renderPage('setup-wizard.html', {
        step: 1,
        error: 'Password must be at least 8 characters.'
      });
      return res.status(400).type('html').send(html);
    }
    if (password !== passwordConfirm) {
      const html = await renderPage('setup-wizard.html', {
        step: 1,
        error: 'Passwords do not match.'
      });
      return res.status(400).type('html').send(html);
    }

    const test = await testAnthropicKey(anthropicKey.trim());
    if (!test.ok) {
      const html = await renderPage('setup-wizard.html', {
        step: 2,
        error: `Anthropic key test failed: ${test.message}`
      });
      return res.status(400).type('html').send(html);
    }

    const passwordHash = await hashPassword(password);
    const blob = encrypt(anthropicKey.trim(), process.env.ENCRYPTION_KEY);

    const userId = await withTx(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email?.trim() || null, passwordHash]
      );
      const id = rows[0].id;
      await client.query(
        'INSERT INTO user_secrets (user_id, anthropic_key) VALUES ($1, $2)',
        [id, blob]
      );
      return id;
    });

    req.session.userId = userId;
    logger.info({ userId }, 'admin user created via setup wizard');
    res.redirect('/jobs');
  } catch (err) {
    next(err);
  }
});

router.get('/login', async (req, res, next) => {
  try {
    const user = await getOnlyUser();
    if (!user) return res.redirect('/setup');
    if (req.session?.userId) return res.redirect('/jobs');
    const html = await renderPage('login.html', { error: req.query.error });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { password } = req.body ?? {};
    const user = await getOnlyUser();
    if (!user) return res.redirect('/setup');
    if (!password || !(await checkPassword(password, user.password_hash))) {
      const html = await renderPage('login.html', { error: 'Wrong password.' });
      return res.status(401).type('html').send(html);
    }
    req.session.userId = user.id;
    res.redirect('/jobs');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export default router;
