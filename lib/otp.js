// OTP engine: 6-digit one-time codes for phone verification.
// Codes are generated with crypto.randomInt and stored ONLY as sha256 hashes
// (salted with OTP_PEPPER when set). Plain codes are never persisted or logged
// except the dev-console line below.
//
// Contract on db.js:
//   otp_codes(id, phone, code_hash, purpose, attempts, expires_at, created_at)
// Purposes: 'register' | 'login' | 'claim'
const crypto = require('crypto');
const db = require('../db');
const phone = require('./phone');

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_PHONE_PER_HOUR = 3;
const MAX_SENDS_PER_IP_PER_HOUR = 10;
const WHATSAPP_TIMEOUT_MS = 10_000;

const PURPOSES = new Set(['register', 'login', 'claim']);

function pepper() { return process.env.OTP_PEPPER || ''; }
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// ---- Defensive DDL: otp_codes is created if the host schema has not added it
// yet. Idempotent (IF NOT EXISTS) so it can never clash with a real migration.
let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      const idDef = db.dialect === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS otp_codes (
          id ${idDef},
          phone TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          purpose TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_codes(phone, purpose)').run();
    })().catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

// Per-IP send counting (otp_codes has no ip column by contract).
const ipSends = new Map();
setInterval(() => {
  const cut = Date.now() - 3600_000;
  for (const [k, arr] of ipSends) {
    while (arr.length && arr[0] <= cut) arr.shift();
    if (!arr.length) ipSends.delete(k);
  }
}, 5 * 60_000).unref();
function ipSendAllowed(ip) {
  const now = Date.now();
  let arr = ipSends.get(ip);
  if (!arr) { arr = []; ipSends.set(ip, arr); }
  while (arr.length && arr[0] <= now - 3600_000) arr.shift();
  if (arr.length >= MAX_SENDS_PER_IP_PER_HOUR) return false;
  arr.push(now);
  return true;
}

// Tolerant timestamp parse: handles ISO ('T') and SQLite (' ') formats.
function parseTs(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  const iso = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}
const nowIso = (ms) => new Date(ms).toISOString();

// ---- Delivery ----
async function sendWhatsAppOtp(p, code) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const template = process.env.WHATSAPP_TEMPLATE || 'otp_code';
  if (!phoneNumberId || !token) {
    throw new Error('WhatsApp OTP not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WHATSAPP_TIMEOUT_MS);
  let res;
  let data = null;
  try {
    res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        // The code travels only inside the request body, which is never logged.
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: p,
          type: 'template',
          template: {
            name: template,
            language: { code: 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
          },
        }),
        signal: ctrl.signal,
      }
    );
    try { data = await res.json(); } catch { data = null; }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('WhatsApp request timed out. Please try again.');
    throw new Error('Could not reach WhatsApp to send the code. Please try again.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Provider's own message; it never contains the code.
    const msg = data && data.error && data.error.message
      ? String(data.error.message)
      : `WhatsApp send failed (status ${res.status}).`;
    throw new Error(msg);
  }
}

// ---- Public API ----
// createOtp(phone, purpose, {ip}) -> {ok:true} | {ok:false,error}
async function createOtp(p, purpose, opts = {}) {
  const phoneNum = phone.validatePhone(p);
  if (!phoneNum) return { ok: false, error: 'Enter a valid phone number with country code, e.g. +923001234567.' };
  if (!PURPOSES.has(purpose)) return { ok: false, error: 'Invalid request.' };
  await ensureTables();

  const now = Date.now();
  // 60s resend cooldown per phone (based on otp_codes.created_at).
  const last = await db.prepare('SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phoneNum);
  if (last && now - parseTs(last.created_at) < RESEND_COOLDOWN_MS) {
    return { ok: false, error: 'A code was just sent. Please wait a minute before requesting another.' };
  }
  // 3 sends/hour per phone (DB-backed so it survives restarts).
  const hr = await db.prepare('SELECT COUNT(*) c FROM otp_codes WHERE phone = ? AND created_at > ?')
    .get(phoneNum, nowIso(now - 3600_000));
  if (hr && Number(hr.c) >= MAX_SENDS_PER_PHONE_PER_HOUR) {
    return { ok: false, error: 'Too many codes sent to this number. Try again in an hour.' };
  }
  // 10 sends/hour per IP.
  if (!ipSendAllowed(opts.ip || 'unknown')) {
    return { ok: false, error: 'Too many codes requested. Try again later.' };
  }

  // A new code invalidates any prior unexpired code for the same phone+purpose.
  const nowISO = nowIso(now);
  await db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ? AND expires_at > ?')
    .run(phoneNum, purpose, nowISO);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
  const hash = sha256(code + pepper());
  await db.prepare(
    'INSERT INTO otp_codes (phone, code_hash, purpose, attempts, expires_at, created_at) VALUES (?,?,?,?,?,?)'
  ).run(phoneNum, hash, purpose, 0, nowIso(now + CODE_TTL_MS), nowISO);

  const provider = String(process.env.OTP_PROVIDER || 'dev').toLowerCase();
  if (provider === 'whatsapp') {
    try {
      await sendWhatsAppOtp(phoneNum, code);
    } catch (e) {
      // Don't leave a code the user can never receive.
      await db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ? AND code_hash = ?')
        .run(phoneNum, purpose, hash);
      return { ok: false, error: e && e.message ? e.message : 'Could not send the code. Please try again.' };
    }
  } else {
    // Dev provider: code goes to the server console only, never to the client.
    console.log(`[otp][dev] code for ${phoneNum} (${purpose}): ${code} — dev only, never in production`);
  }
  return { ok: true };
}

// verifyOtp(phone, code, purpose) -> {ok:true} | {ok:false,error}
// Generic messages throughout: they must not reveal whether a code exists.
async function verifyOtp(p, code, purpose) {
  const phoneNum = phone.validatePhone(p);
  const expired = { ok: false, error: 'Code expired or not found.' };
  if (!phoneNum || !PURPOSES.has(purpose)) return expired;
  await ensureTables();

  const row = await db.prepare(
    'SELECT id, code_hash, attempts FROM otp_codes WHERE phone = ? AND purpose = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
  ).get(phoneNum, purpose, nowIso(Date.now()));
  if (!row) return expired;
  if (Number(row.attempts) >= MAX_ATTEMPTS) {
    await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
    return expired;
  }
  const digest = sha256(String(code == null ? '' : code).trim() + pepper());
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(String(row.code_hash), 'hex'));
  } catch { match = false; }
  if (!match) {
    await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: 'Incorrect code.' };
  }
  await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
  return { ok: true };
}

module.exports = { createOtp, verifyOtp, sendWhatsAppOtp, PURPOSES: [...PURPOSES] };
