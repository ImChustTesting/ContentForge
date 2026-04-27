import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.resolve(__dirname, '..', 'views');

const cache = new Map();

async function getTemplate(name) {
  if (process.env.NODE_ENV !== 'production' && cache.has(name)) cache.delete(name);
  if (cache.has(name)) return cache.get(name);
  const src = await readFile(path.join(VIEWS_DIR, name), 'utf8');
  const tpl = Handlebars.compile(src);
  cache.set(name, tpl);
  return tpl;
}

export async function renderPartial(name, ctx = {}) {
  const tpl = await getTemplate(name);
  return tpl(ctx);
}

export async function renderPage(viewName, ctx = {}) {
  const layout = await getTemplate('layout.html');
  const body = await renderPartial(viewName, ctx);
  return layout({ ...ctx, body });
}

Handlebars.registerHelper('ts', function (ms) {
  if (ms == null) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
});

Handlebars.registerHelper('eq', (a, b) => a === b);

Handlebars.registerHelper('gt', (a, b) => Number(a) > Number(b));

Handlebars.registerHelper('json', (v) => new Handlebars.SafeString(JSON.stringify(v ?? null)));
