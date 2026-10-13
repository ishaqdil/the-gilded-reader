// The Gilded Cage — a Reddit-style reader community for the novel.
// Run: npm start  (listens on PORT, default 3000)
//
// Route layout:
//   server.js ......... app setup, security headers, sessions, CSRF, shared
//                       context (settings, audit, template locals), chapter
//                       reader routes, error handlers, boot.
//   routes/auth.js ..... phone-based auth (password or OTP modes), admin claim.
//   routes/community.js  feed, communities, posts, votes, comments, reports,
//                       profiles, notifications, search.
//   routes/admin.js .... admin dashboard + moderation (chapters, users, posts,
//                       comments, communities, reports, audit, settings).
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');

const db = require('./db');
const auth = require('./lib/auth');
const v = require('./lib/validate');
const rl = require('./lib/ratelimit');
const bootstrap = require('./lib/bootstrap');
const notify = require('./lib/notify');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ---------- Security headers ----------
app.use(async (req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; form-action 'self'");
  next();
});

// ---------- Static: ONLY ./public is ever served. data/, seed/, views/ are unreachable. ----------
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1d', index: false }));

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '64kb' }));

// ---------- Session attach ----------
app.use(async (req, res, next) => {
  const cookies = auth.parseCookies(req);
  req.session = cookies.sid ? await auth.getSession(cookies.sid) : null;
  req.user = req.session ? req.session.user : null;
  res.locals.user = req.user;
  res.locals.csrfToken = req.session ? req.session.csrf : null;
  res.locals.path = req.path;
  next();
});

const isSecureReq = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

// ---------- CSRF: required on every state-changing request with a session ----------
// Login/register/claim have no session yet (the claim token is the auth there);
// they get their own rate limits instead.
app.use(async (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.session) return next();
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (!sent || sent !== req.session.csrf) {
    return res.status(403).json({ ok: false, error: 'Security token mismatch. Please reload and try again.' });
  }
  next();
});

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Body text: stored as plain text; rendered escaped with paragraphs.
function formatBody(text) {
  return String(text).split(/\n{2,}/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
app.locals.formatBody = formatBody;
app.locals.escapeHtml = escapeHtml;
app.locals.fmtDate = (iso) => {
  try { return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Please log in.' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}
async function requireAdmin(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Please log in.' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  // Server-side role check, re-read from the DB on every request.
  // Frontend hints never grant access.
  const row = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!row || row.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Forbidden.' });
    return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to view this page.', status: 403 });
  }
  next();
}
const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

// ---------- Settings (cached 60s) ----------
const settingsCache = { at: 0, map: new Map() };
async function getSetting(key) {
  const now = Date.now();
  if (now - settingsCache.at > 60_000) { settingsCache.at = now; settingsCache.map = new Map(); }
  if (settingsCache.map.has(key)) return settingsCache.map.get(key);
  let val = null;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    val = row ? row.value : null;
  } catch { val = null; }
  settingsCache.map.set(key, val);
  return val;
}

// ---------- Audit dispatcher ----------
// Accepts all three module styles and writes one audit_log row:
//   admin.js:     audit(adminId, action, targetType, targetId, detail)
//   community.js: audit(action, req, details)
//   auth.js:      audit(event, meta)
async function audit(a, b, c, d, e) {
  try {
    if (typeof a === 'number' && typeof b === 'string') {
      await db.prepare('INSERT INTO audit_log (admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?)')
        .run(a, b, c || null, d == null ? null : d, e == null ? '' : String(e).slice(0, 500));
    } else if (typeof a === 'string' && b && typeof b === 'object' && 'user' in b) {
      const adminId = b.user ? b.user.id : null;
      const detail = c ? JSON.stringify(c).slice(0, 500) : '';
      await db.prepare('INSERT INTO audit_log (admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?)')
        .run(adminId, a, null, null, detail);
    } else if (typeof a === 'string') {
      const meta = b && typeof b === 'object' ? b : {};
      const adminId = meta.adminId || null;
      await db.prepare('INSERT INTO audit_log (admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?)')
        .run(adminId, a, null, null, JSON.stringify(meta).slice(0, 500));
    }
  } catch (err) {
    console.error('[audit]', err && err.message ? err.message : err);
  }
}

// ---------- Template locals: branding, sidebar data, unread count ----------
const localsCache = { at: 0, communities: [] };
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/static')) return next();
  try {
    res.locals.siteName = (await getSetting('site_name')) || 'The Gilded Cage';
    res.locals.tagline = (await getSetting('tagline')) || '';
    res.locals.rulesText = (await getSetting('rules_text')) || '';
    const now = Date.now();
    if (now - localsCache.at > 60_000) {
      localsCache.at = now;
      localsCache.communities = await db.prepare('SELECT id, slug, title FROM communities ORDER BY title ASC').all();
    }
    res.locals.communities = localsCache.communities;
    res.locals.unreadCount = req.user ? await notify.getUnreadCount(req.user.id) : 0;
  } catch {
    res.locals.siteName = res.locals.siteName || 'The Gilded Cage';
    res.locals.unreadCount = res.locals.unreadCount || 0;
    res.locals.communities = res.locals.communities || [];
  }
  next();
});

const adminRl = rl.middleware((req) => 'adm:' + req.user.id, 120, 60_000, 'Slow down.');

const ctx = {
  db, auth, v, rl,
  requireAuth, requireAdmin, adminRl, clientIp, isSecureReq,
  helpers: { escapeHtml, formatBody, fmtDate: app.locals.fmtDate },
  getSetting, audit,
};

// ================= CHAPTER READER (kept from the original build) =================
app.get('/chapters', async (req, res) => {
  const chapters = await db.prepare('SELECT id, number, title, excerpt, created_at FROM chapters WHERE published = 1 ORDER BY number ASC').all();
  res.render('chapters', { title: 'Chapters', chapters });
});

app.get('/chapter/:id', async (req, res) => {
  const id = v.intId(req.params.id);
  if (!id) return res.status(404).render('404', { title: 'Not found' });
  const ch = await db.prepare('SELECT id, number, title, body, created_at FROM chapters WHERE id = ? AND published = 1').get(id);
  if (!ch) return res.status(404).render('404', { title: 'Chapter not found' });
  const prev = await db.prepare('SELECT id, number, title FROM chapters WHERE published = 1 AND number < ? ORDER BY number DESC LIMIT 1').get(ch.number);
  const next = await db.prepare('SELECT id, number, title FROM chapters WHERE published = 1 AND number > ? ORDER BY number ASC LIMIT 1').get(ch.number);
  const cc = await db.prepare("SELECT COUNT(*) AS c FROM comments WHERE chapter_id = ? AND status = 'visible'").get(id);
  res.render('read', { title: `Chapter ${ch.number}: ${ch.title}`, ch, prev, next, commentCount: cc ? cc.c : 0 });
});

// ================= MODULE ROUTES =================
// Auth first (login/register/logout/claim), then community (feed, posts,
// comments, votes, profiles, search), then admin (/admin/*).
require('./routes/auth')(app, ctx);
require('./routes/community')(app, ctx);
require('./routes/admin')(app, ctx);

// ================= ERRORS =================
app.use(async (req, res) => res.status(404).render('404', { title: 'Page not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong on our side. Please try again.', status: 500 });
});

// ================= SEED (inside boot) =================
async function boot() {
  await db.init();
  console.log(`Database ready (dialect: ${db.dialect}).`);
  await bootstrap.ensureAdmin();
  if (!await db.prepare('SELECT 1 FROM chapters LIMIT 1').get()) {
    try {
      const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'chapter1.json'), 'utf8'));
      const body = String(seedData.body).replace(/\n{3,}/g, '\n\n').trim();
      const excerpt = body.replace(/\s+/g, ' ').slice(0, 180);
      await db.prepare('INSERT INTO chapters (number, title, excerpt, body, published) VALUES (1,?,?,?,1)')
        .run(seedData.title || 'Chapter 1', excerpt, body);
      console.log('Seeded Chapter 1 from the novel manuscript.');
    } catch { console.log('No chapter seed found; starting with an empty library.'); }
  }
  app.listen(PORT, () => console.log(`The Gilded Cage running → http://localhost:${PORT}  (AUTH_MODE=${process.env.AUTH_MODE || 'password'}, OTP_PROVIDER=${process.env.OTP_PROVIDER || 'dev'})`));
}

boot().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
