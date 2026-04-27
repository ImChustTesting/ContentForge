import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcrypt';
import { pool } from './db.js';

const PgStore = ConnectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required');
}

export const sessionMiddleware = session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'cf.sid',
  cookie: {
    httpOnly: true,
    secure:
      process.env.NODE_ENV === 'production' && process.env.BEHIND_TLS === 'true',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.headers['hx-request']) {
      res.set('HX-Redirect', '/login');
      return res.status(401).end();
    }
    return res.redirect('/login');
  }
  next();
}

export async function getOnlyUser() {
  const { rows } = await pool.query(
    'SELECT id, email, password_hash FROM users LIMIT 1'
  );
  return rows[0] ?? null;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
