// Auth routes for The Gilded Cage — phone-first, in two modes:
//   AUTH_MODE=password (default): phone + username + password registration,
//                                 phone-or-username + password login.
//   AUTH_MODE=otp:                 phone + username registration and phone login
//                                 via 6-digit codes (dev console or WhatsApp).
//
// Wiring: module.exports = (app, ctx) => {...}
//   ctx = { db, auth, v, rl, requireAuth, clientIp, isSecureReq,
//           helpers: { escapeHtml, fmtDate }, getSetting, audit }
//
// SECURITY: parameterized queries only; password_hash is selected only where
// needed and never rendered; generic auth errors (no enumeration); sessions via
// auth.setSessionCookie with the secure flag from ctx.isSecureReq(req).
const crypto = require('crypto');
const otp = require('../lib/otp');
const phoneLib = require('../lib/phone');

const AUTH_MODE = String(process.env.AUTH_MODE || 'password').toLowerCase() === 'otp' ? 'otp' : 'password';
// Timing-attack padding when the account does not exist (same as before).
const DUMMY_HASH = '$2b$12$KIXxQGh5lPz9YvWq8ZxY3uJ6vN5mL4kJ3hG2fD1sA0zX9cV8bN7mL6k';
const OTP_PURPOSES = new Set(['register', 'login']);

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

module.exports = (app, ctx) => {
  const { db, auth, v, rl, requireAuth, clientIp, isSecureReq } = ctx;
  // getSetting/audit are provided by the coordinator; fall back to sane defaults.
  const getSetting = ctx.getSetting || (async (k) => (k === 'registrations_open' ? '1' : null));
  const audit = ctx.audit || ((event, meta) => console.log('[audit]', event, meta || {}));

  // Defensive: never let an undefined body crash a handler (e.g. a route
  // wired without the JSON/urlencoded parsers mounted).
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

  const authMode = AUTH_MODE;

  function wantsJson(req) {
    const accept = req.headers.accept || '';
    const ctype = req.headers['content-type'] || '';
    return Boolean(req.xhr) || accept.includes('application/json') || ctype.includes('application/json');
  }
  function safeNext(val) {
    return (typeof val === 'string' && val.startsWith('/') && !val.startsWith('//')) ? val : '/';
  }
  async function loginUser(req, res, userId) {
    await auth.destroyUserSessions(userId); // invalidate other sessions
    const s = await auth.createSession(userId);
    auth.setSessionCookie(res, s.id, isSecureReq(req));
  }
  async function registrationsOpen() {
    try {
      const val = await getSetting('registrations_open');
      return val === '1' || val == null; // default: open
    } catch { return true; }
  }
  function closedPage(res) {
    return res.status(403).render('error', { title: 'Registrations closed', message: 'Registrations are closed.', status: 403 });
  }

  // ================= REGISTER =================
  app.get('/register', async (req, res) => {
    if (req.user) return res.redirect('/');
    if (!await registrationsOpen()) return closedPage(res);
    res.render('register', { title: 'Create account', error: null, info: null, authMode, step: null, phone: '', username: '' });
  });

  app.post('/register',
    rl.middleware((req) => 'reg:' + clientIp(req), 5, 3600_000, 'Too many signups from this device. Try again later.'),
    async (req, res) => {
      if (req.user) return res.redirect('/');
      if (!await registrationsOpen()) return closedPage(res);
      const render = (error, status = 400) => res.status(status).render('register', {
        title: 'Create account', error, info: null, authMode, step: null,
        phone: typeof req.body.phone === 'string' ? req.body.phone.slice(0, 32) : '',
        username: typeof req.body.username === 'string' ? req.body.username.slice(0, 24) : '',
      });
      if (authMode === 'otp') return otpRegisterStep1(req, res, render);

      // ---- password mode ----
      const ph = phoneLib.validatePhone(req.body.phone);
      const uname = v.username(req.body.username);
      const pw = v.password(req.body.password);
      if (!ph) return render('Enter a valid phone number with country code, e.g. +923001234567.');
      if (!uname || !pw) return render('Username must be 3–24 characters (letters, numbers, _). Password must be at least 8 characters.');
      if (await db.prepare('SELECT 1 FROM users WHERE phone = ?').get(ph)) {
        return render('This phone number is already registered. Try logging in instead.');
      }
      if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
        return render('That username is taken. Try another.');
      }
      const r = await db.prepare(
        "INSERT INTO users (username, password_hash, phone, phone_verified, role) VALUES (?, ?, ?, 0, 'user')"
      ).run(uname, await auth.hashPassword(pw), ph);
      await loginUser(req, res, r.lastInsertRowid);
      res.redirect('/');
    });

  async function otpRegisterStep1(req, res, render) {
    const ph = phoneLib.validatePhone(req.body.phone);
    const uname = v.username(req.body.username);
    if (!ph) return render('Enter a valid phone number with country code, e.g. +923001234567.');
    if (!uname) return render('Username must be 3–24 characters (letters, numbers, _).');
    if (await db.prepare('SELECT 1 FROM users WHERE phone = ?').get(ph)) {
      return render('This phone number is already registered. Try logging in instead.');
    }
    if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
      return render('That username is taken. Try another.');
    }
    const s = await otp.createOtp(ph, 'register', { ip: clientIp(req) });
    if (!s.ok) return render(s.error, 429);
    return res.render('register', {
      title: 'Create account', error: null, info: 'We sent a 6-digit code. It expires in 10 minutes.',
      authMode, step: 'verify', phone: ph, username: uname,
    });
  }

  // ================= LOGIN =================
  app.get('/login', async (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { title: 'Log in', error: null, info: null, authMode, step: null, phone: '', next: req.query.next || '' });
  });

  app.post('/login',
    rl.middleware((req) => 'login:' + clientIp(req), 10, 600_000, 'Too many login attempts. Please wait a few minutes.'),
    async (req, res) => {
      if (req.user) return res.redirect('/');
      const base = {
        title: 'Log in', authMode, step: null,
        phone: typeof req.body.phone === 'string' ? req.body.phone.slice(0, 32) : '',
        next: typeof req.body.next === 'string' ? req.body.next.slice(0, 256) : '',
      };
      const render = (error, status = 401) => res.status(status).render('login', { ...base, error, info: null });
      if (authMode === 'otp') return otpLoginStep1(req, res, base);

      // ---- password mode: identifier = phone or username ----
      const raw = typeof req.body.identifier === 'string' ? req.body.identifier
        : (typeof req.body.username === 'string' ? req.body.username : '');
      const identifier = raw.trim().slice(0, 64);
      const pw = typeof req.body.password === 'string' ? req.body.password : '';
      const ph = phoneLib.validatePhone(identifier);
      let row = null;
      if (ph) row = await db.prepare('SELECT id, password_hash, status FROM users WHERE phone = ?').get(ph);
      else if (identifier) row = await db.prepare('SELECT id, password_hash, status FROM users WHERE username = ?').get(identifier);
      const ok = row && row.password_hash
        ? await auth.checkPassword(pw, row.password_hash)
        : await auth.checkPassword(pw, DUMMY_HASH); // same timing, no enumeration
      if (!ok || !row) return render('Invalid credentials.');
      if (row.status === 'blocked') {
        return res.status(403).render('login', { ...base, error: 'This account has been blocked. Contact the site admin.', info: null });
      }
      await loginUser(req, res, row.id);
      res.redirect(safeNext(req.body.next));
    });

  async function otpLoginStep1(req, res, base) {
    const ph = phoneLib.validatePhone(req.body.phone);
    if (!ph) {
      return res.status(400).render('login', { ...base, error: 'Enter a valid phone number with country code.', info: null });
    }
    const u = await db.prepare('SELECT id, status FROM users WHERE phone = ?').get(ph);
    if (!u || u.status !== 'active') {
      // Generic message — never reveal whether the number is registered.
      return res.render('login', {
        ...base, step: 'verify', phone: ph,
        error: 'If this number is registered, a code was sent.',
        info: null,
      });
    }
    const s = await otp.createOtp(ph, 'login', { ip: clientIp(req) });
    if (!s.ok) return res.status(429).render('login', { ...base, error: s.error, info: null });
    return res.render('login', {
      ...base, step: 'verify', phone: ph,
      error: null, info: 'We sent a 6-digit code. It expires in 10 minutes.',
    });
  }

  // ================= LOGOUT =================
  app.post('/logout', async (req, res) => {
    if (req.session) await auth.destroySession(req.session.id);
    auth.clearSessionCookie(res, isSecureReq(req));
    res.redirect('/');
  });

  // ================= OTP JSON API (also serves the HTML verify forms) =================
  app.post('/api/otp/send', async (req, res) => {
    const ph = phoneLib.validatePhone(req.body.phone);
    const purpose = req.body.purpose;
    if (!ph || !OTP_PURPOSES.has(purpose)) {
      return res.status(400).json({ ok: false, error: 'Invalid request.' });
    }
    const r = rl.hit('otp:send:ip:' + clientIp(req), 10, 3600_000);
    if (!r.allowed) {
      res.set('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    if (purpose === 'login') {
      const u = await db.prepare('SELECT id, status FROM users WHERE phone = ?').get(ph);
      // Silent success for unknown/blocked numbers: no enumeration, no stray SMS.
      if (!u || u.status !== 'active') return res.json({ ok: true });
    }
    if (purpose === 'register') {
      if (!await registrationsOpen()) return res.status(403).json({ ok: false, error: 'Registrations are closed.' });
      if (await db.prepare('SELECT 1 FROM users WHERE phone = ?').get(ph)) {
        return res.status(400).json({ ok: false, error: 'This phone number is already registered.' });
      }
    }
    const s = await otp.createOtp(ph, purpose, { ip: clientIp(req) });
    if (!s.ok) return res.status(429).json({ ok: false, error: s.error });
    return res.json({ ok: true });
  });

  app.post('/api/otp/verify', async (req, res) => {
    const ph = phoneLib.validatePhone(req.body.phone);
    const purpose = req.body.purpose;
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const json = wantsJson(req);
    const fail = (status, error, formLocals) => {
      if (json) return res.status(status).json({ ok: false, error });
      return res.status(status).render(formLocals.view, formLocals.locals);
    };
    if (!ph || !OTP_PURPOSES.has(purpose) || !/^\d{4,10}$/.test(code)) {
      return fail(400, 'Invalid request.', { view: 'error', locals: { title: 'Bad request', message: 'Invalid request.', status: 400 } });
    }
    const r = rl.hit('otp:verify:phone:' + ph, 10, 600_000);
    if (!r.allowed) {
      res.set('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      const locals = verifyFormLocals(purpose, ph, req, 'Too many attempts. Please wait a few minutes.', null);
      return fail(429, 'Too many attempts. Please wait a few minutes.', locals);
    }
    const vr = await otp.verifyOtp(ph, code, purpose);
    if (!vr.ok) {
      const locals = verifyFormLocals(purpose, ph, req, vr.error, null);
      return fail(400, vr.error, locals);
    }
    if (purpose === 'register') {
      if (!await registrationsOpen()) {
        const locals = { view: 'error', locals: { title: 'Registrations closed', message: 'Registrations are closed.', status: 403 } };
        return fail(403, 'Registrations are closed.', locals);
      }
      const uname = v.username(req.body.username);
      if (!uname) {
        const locals = verifyFormLocals(purpose, ph, req, 'Username must be 3–24 characters (letters, numbers, _).', null);
        return fail(400, 'Invalid username.', locals);
      }
      // Re-check uniqueness (a code was issued earlier; someone may have registered since).
      if (await db.prepare('SELECT 1 FROM users WHERE phone = ?').get(ph)) {
        const locals = verifyFormLocals(purpose, ph, req, 'This phone number is already registered.', null);
        return fail(400, 'This phone number is already registered.', locals);
      }
      if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
        const locals = verifyFormLocals(purpose, ph, req, 'That username is taken. Try another.', null);
        return fail(400, 'That username is taken.', locals);
      }
      const ins = await db.prepare(
        "INSERT INTO users (username, password_hash, phone, phone_verified, role) VALUES (?, NULL, ?, 1, 'user')"
      ).run(uname, ph);
      await loginUser(req, res, ins.lastInsertRowid);
      if (json) return res.json({ ok: true });
      return res.redirect(safeNext(req.body.next));
    }
    // purpose === 'login'
    const u = await db.prepare('SELECT id, status FROM users WHERE phone = ?').get(ph);
    if (!u || u.status !== 'active') {
      const locals = verifyFormLocals(purpose, ph, req, 'This account is no longer available.', null);
      return fail(403, 'This account is no longer available.', locals);
    }
    await loginUser(req, res, u.id);
    if (json) return res.json({ ok: true });
    return res.redirect(safeNext(req.body.next));
  });

  function verifyFormLocals(purpose, ph, req, error, info) {
    const next = typeof req.body.next === 'string' ? req.body.next.slice(0, 256) : '';
    const username = typeof req.body.username === 'string' ? req.body.username.slice(0, 24) : '';
    if (purpose === 'register') {
      return { view: 'register', locals: { title: 'Create account', error, info, authMode, step: 'verify', phone: ph, username } };
    }
    return { view: 'login', locals: { title: 'Log in', error, info, authMode, step: 'verify', phone: ph, next } };
  }

  // ================= ADMIN CLAIM =================
  // One-time token (from ensureAdmin) authorizes this flow. No session needed;
  // the token is re-submitted in the form body on POST.
  async function findClaimAdmin(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{32,128}$/i.test(token)) return null;
    const digest = sha256(token);
    const rows = await db.prepare(
      "SELECT id, username, claim_token_hash FROM users WHERE role = 'admin' AND claim_token_hash IS NOT NULL"
    ).all();
    for (const row of rows) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(String(row.claim_token_hash), 'hex'))) return row;
      } catch { /* malformed stored hash: keep looking */ }
    }
    return null;
  }

  app.get('/admin/claim', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const admin = await findClaimAdmin(token);
    if (!admin) return res.status(404).render('404', { title: 'Not found' });
    res.render('claim', { title: 'Claim admin account', error: null, info: null, authMode, step: null, token, phone: '' });
  });

  app.post('/admin/claim', async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const admin = await findClaimAdmin(token);
    if (!admin) return res.status(404).render('404', { title: 'Not found' });
    const render = (error, status = 400, extra = {}) => res.status(status).render('claim', {
      title: 'Claim admin account', error, info: extra.info || null,
      authMode, step: extra.step || null, token,
      phone: typeof req.body.phone === 'string' ? req.body.phone.slice(0, 32) : '',
    });
    const ph = phoneLib.validatePhone(req.body.phone);
    if (!ph) return render('Enter a valid phone number with country code, e.g. +923001234567.');
    if (await db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(ph, admin.id)) {
      return render('This phone number is already registered to another account.');
    }

    if (authMode === 'password') {
      const pw = v.password(req.body.password);
      if (!pw) return render('Password must be at least 8 characters.');
      await db.prepare(
        'UPDATE users SET phone = ?, phone_verified = 1, password_hash = ?, claim_token_hash = NULL WHERE id = ?'
      ).run(ph, await auth.hashPassword(pw), admin.id);
      await auth.destroyUserSessions(admin.id);
      audit('admin.claim', { adminId: admin.id, mode: 'password' });
      return res.redirect('/login');
    }

    // ---- otp mode: two steps within this form ----
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!code) {
      const s = await otp.createOtp(ph, 'claim', { ip: clientIp(req) });
      if (!s.ok) return render(s.error, 429);
      return res.render('claim', {
        title: 'Claim admin account', error: null,
        info: 'We sent a 6-digit code. It expires in 10 minutes.',
        authMode, step: 'verify', token, phone: ph,
      });
    }
    const r = rl.hit('otp:verify:phone:' + ph, 10, 600_000);
    if (!r.allowed) return render('Too many attempts. Please wait a few minutes.', 429, { step: 'verify' });
    const vr = await otp.verifyOtp(ph, code, 'claim');
    if (!vr.ok) return render(vr.error, 400, { step: 'verify' });
    await db.prepare(
      'UPDATE users SET phone = ?, phone_verified = 1, claim_token_hash = NULL WHERE id = ?'
    ).run(ph, admin.id);
    await auth.destroyUserSessions(admin.id);
    audit('admin.claim', { adminId: admin.id, mode: 'otp' });
    return res.redirect('/login');
  });

  // ================= OWN PASSWORD (moved here from the coordinator) =================
  app.post('/me/password', requireAuth,
    rl.middleware((req) => 'pw:' + req.user.id, 5, 3600_000, 'Too many attempts. Try again later.'),
    async (req, res) => {
      const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      const cur = typeof req.body.current === 'string' ? req.body.current : '';
      const next = v.password(req.body.next);
      const render = async (error, okMsg) => {
        const u = await db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id);
        const comments = await db.prepare(`
          SELECT c.id, c.body, c.created_at, ch.id AS chid, ch.number, ch.title
          FROM comments c JOIN chapters ch ON ch.id = c.chapter_id
          WHERE c.user_id = ? AND c.status = 'visible' ORDER BY c.created_at DESC LIMIT 20`).all(req.user.id);
        res.status(error ? 400 : 200).render('profile', { title: 'My profile', me: u, comments, error, okMsg });
      };
      if (!next) return render('New password must be at least 8 characters.', null);
      if (row && row.password_hash) {
        if (!(await auth.checkPassword(cur, row.password_hash))) return render('Current password is incorrect.', null);
      }
      // OTP-mode accounts have no password yet: nothing to check, just set one.
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await auth.hashPassword(next), req.user.id);
      await auth.destroyUserSessions(req.user.id); // log out other devices
      const s = await auth.createSession(req.user.id);
      auth.setSessionCookie(res, s.id, isSecureReq(req));
      return render(null, 'Password updated.');
    });
};
