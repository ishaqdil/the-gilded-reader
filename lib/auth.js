// Session + auth helpers. Sessions are random opaque tokens stored server-side.
// Cookie is httpOnly + SameSite=Lax (+ Secure on HTTPS). CSRF token per session.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function createSession(userId) {
  const id = newToken();
  const csrf = newToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?,?,?,?)')
    .run(id, userId, csrf, expires);
  return { id, csrf };
}

async function getSession(sid) {
  if (!sid || typeof sid !== 'string' || sid.length !== 64) return null;
  const row = await db.prepare(`
    SELECT s.id, s.csrf, s.expires_at, u.id AS user_id, u.username, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?`).get(sid);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) { await destroySession(sid); return null; }
  if (row.status !== 'active') { await destroySession(sid); return null; }
  // sliding expiry
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expires, sid);
  return { id: row.id, csrf: row.csrf, user: { id: row.user_id, username: row.username, role: row.role } };
}

async function destroySession(sid) {
  if (sid) await db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

async function destroyUserSessions(userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, sid, secure) {
  const parts = [`sid=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 24 * 3600}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, secure) {
  const parts = ['sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function hashPassword(pw) { return bcrypt.hash(pw, 12); }
async function checkPassword(pw, hash) { return bcrypt.compare(pw, hash); }

// Public-safe user projection. NEVER add password_hash or other private fields.
function publicUser(u) {
  return { id: u.id, username: u.username };
}

module.exports = {
  newToken, createSession, getSession, destroySession, destroyUserSessions,
  parseCookies, setSessionCookie, clearSessionCookie,
  hashPassword, checkPassword, publicUser,
};
