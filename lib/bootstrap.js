// First-boot admin provisioning for The Gilded Cage.
// If no admin user exists, creates one with a one-time claim token instead of
// a password: the claim URL is printed to the server console once. The admin
// then claims the account at /admin/claim?token=... and sets a phone number
// (plus a password in AUTH_MODE=password, or verifies an OTP in AUTH_MODE=otp).
//
// Contract on db.js (users): phone TEXT UNIQUE NULL, phone_verified INTEGER,
// avatar, bio, claim_token_hash TEXT NULL, password_hash nullable TEXT.
const crypto = require('crypto');
const db = require('../db');

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

async function ensureAdmin() {
  const existing = await db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return null;

  const username = process.env.ADMIN_USER || 'admin';
  const preset = process.env.ADMIN_CLAIM_TOKEN;
  const token = preset || crypto.randomBytes(24).toString('hex');
  const tokenHash = sha256(token);
  await db.prepare(
    "INSERT INTO users (username, password_hash, role, status, phone, phone_verified, claim_token_hash) VALUES (?, '', 'admin', 'active', NULL, 0, ?)"
  ).run(username, tokenHash);

  const port = Number(process.env.PORT) || 3000;
  console.log('──────────────────────────────────────────────');
  console.log(' Admin account created (none existed).');
  console.log(' Username:', username);
  if (preset) {
    // Token was supplied via env: never print it.
    console.log(' Claim it at: /admin/claim?token=<your ADMIN_CLAIM_TOKEN>');
    console.log(' (token preset via ADMIN_CLAIM_TOKEN — not shown here)');
  } else {
    console.log(' ONE-TIME claim URL — shown once, then claim the account:');
    console.log(` http://localhost:${port}/admin/claim?token=${token}`);
  }
  console.log('──────────────────────────────────────────────');
  return { username, claimed: false };
}

module.exports = { ensureAdmin };
