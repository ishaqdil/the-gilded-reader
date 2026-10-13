// Automated test suite for The Gilded Cage (chapter-site).
// Run: npm test
// Boots the real app on an ephemeral port (no new npm deps; node:test-style
// plain asserts + global fetch). Two suites, fresh DB each:
//   Suite A: AUTH_MODE=password — full auth/community/admin coverage.
//   Suite B: AUTH_MODE=otp + OTP_PROVIDER=dev — OTP flows via captured stdout.
//
// The app's SQLite DB lives in ./data (hardcoded); this runner wipes ./data
// between suites and removes it when finished, so the repo is left clean.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------- tiny assert harness ----------------
let pass = 0, total = 0;
const failures = [];
function ok(cond, name) {
  total++;
  if (cond) { pass++; }
  else { failures.push(name); console.error(`  FAIL: ${name}`); }
}
function eq(a, b, name) {
  ok(a === b, `${name} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function contains(hay, needle, name) {
  ok(typeof hay === 'string' && hay.includes(needle), `${name} — response should contain ${JSON.stringify(needle)}`);
}
function notContains(hay, needle, name) {
  ok(typeof hay === 'string' && !hay.includes(needle), `${name} — response leaked ${JSON.stringify(needle)}`);
}

// ---------------- http client with cookie jar ----------------
function makeClient(base) {
  const jar = new Map();
  const client = { base, csrf: null };
  async function request(method, p, { headers = {}, body = null } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const semi = c.indexOf(';');
      const pair = semi < 0 ? c : c.slice(0, semi);
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim(), val = pair.slice(i + 1).trim();
      if (/max-age=0/i.test(c)) jar.delete(k); else jar.set(k, val);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  client.get = (p, o) => request('GET', p, o);
  client.postForm = (p, fields, o = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.append(k, v == null ? '' : String(v));
    return request('POST', p, {
      ...o,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.headers || {}) },
      body: params.toString(),
    });
  };
  // JSON API POST: sends the session CSRF token as x-csrf-token when present.
  client.postJson = (p, obj, o = {}) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(o.headers || {}) };
    if (client.csrf && !('x-csrf-token' in headers)) headers['x-csrf-token'] = client.csrf;
    return request('POST', p, { ...o, headers, body: JSON.stringify(obj == null ? {} : obj) });
  };
  client.putJson = (p, obj, o = {}) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(o.headers || {}) };
    if (client.csrf && !('x-csrf-token' in headers)) headers['x-csrf-token'] = client.csrf;
    return request('PUT', p, { ...o, headers, body: JSON.stringify(obj == null ? {} : obj) });
  };
  client.delJson = (p, o = {}) => {
    const headers = { accept: 'application/json', ...(o.headers || {}) };
    if (client.csrf && !('x-csrf-token' in headers)) headers['x-csrf-token'] = client.csrf;
    return request('DELETE', p, { ...o, headers });
  };
  // Raw variants that never attach the CSRF token (for negative tests).
  client.rawPostJson = (p, obj, o = {}) => request('POST', p, {
    ...o,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(o.headers || {}) },
    body: JSON.stringify(obj == null ? {} : obj),
  });
  return client;
}

// GET any page and refresh the client's CSRF token from the meta tag.
async function refreshCsrf(client) {
  const r = await client.get('/');
  const m = r.text.match(/<meta name="csrf-token" content="([^"]+)">/);
  client.csrf = m ? m[1] : null;
  return client.csrf;
}

function locationOf(r) { return r.headers.get('location') || ''; }

// ---------------- server lifecycle ----------------
function wipeData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

async function boot(envExtra) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = 4100 + Math.floor(Math.random() * 1000);
    const child = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...envExtra, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 20000);
      const onData = (d) => {
        out += d.toString();
        if (/running →/.test(out)) { clearTimeout(timer); resolve({ ok: true }); }
        else if (/EADDRINUSE/.test(out)) { clearTimeout(timer); resolve({ ok: false, reason: 'inuse' }); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: false, reason: 'exit:' + code }); });
    });
    if (ready.ok) {
      return {
        child, port,
        output() { return out; },
        // Wait until stdout matches re (or timeout); used for [otp][dev] lines.
        async waitFor(re, timeoutMs = 5000) {
          const t0 = Date.now();
          while (Date.now() - t0 < timeoutMs) {
            const m = out.match(re);
            if (m) return m;
            await new Promise((r) => setTimeout(r, 100));
          }
          return null;
        },
      };
    }
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    if (ready.reason !== 'inuse') {
      throw new Error(`server failed to boot (${ready.reason}):\n${out}`);
    }
  }
  throw new Error('could not find a free port after 12 attempts');
}

async function shutdown(srv) {
  const exited = new Promise((r) => srv.child.once('exit', r));
  srv.child.kill('SIGKILL');
  await exited;
}

// Latest dev OTP code for a phone+purpose from captured stdout.
function parseLatestOtp(srv, phone, purpose) {
  const re = new RegExp(`\\[otp\\]\\[dev\\] code for ${phone.replace(/[+]/g, '\\+')} \\(${purpose}\\): (\\d{6})`, 'g');
  let m, last = null;
  const text = srv.output();
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

// community id lookup: <code>/slug</code> ... /admin/communities/<id>/delete
function communityIdFromAdminPage(html, slug) {
  const re = new RegExp(`<code>\\/${slug}<\\/code>[\\s\\S]{0,3000}?\\/admin\\/communities\\/(\\d+)\\/delete`);
  const m = html.match(re);
  return m ? Number(m[1]) : null;
}

function userIdInThreadComments(json, username) {
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.user && n.user.username === username) return n.user.id;
      const f = walk(n.replies);
      if (f) return f;
    }
    return null;
  };
  return walk(json && json.comments);
}

// ================= SUITE A — AUTH_MODE=password =================
const CLAIM_TOKEN = '0123456789abcdef'.repeat(4); // 64 hex chars
const PHONE_A = '+923001112223';
const PHONE_B = '+923004445556';
const ADMIN_PHONE = '+923009998887';
const USER_A = 'testalice';
const USER_B = 'testbob';
const PW = 'supersecret1';
const ADMIN_PW = 'adminpass99';

async function suiteA() {
  console.log('\n=== Suite A (AUTH_MODE=password) ===');
  const srv = await boot({ AUTH_MODE: 'password', ADMIN_CLAIM_TOKEN: CLAIM_TOKEN });
  const base = `http://127.0.0.1:${srv.port}`;
  const anon = makeClient(base);
  const A = makeClient(base);
  const B = makeClient(base);
  const admin = makeClient(base);

  // ---- register + duplicate guards ----
  let r = await anon.get('/register');
  eq(r.status, 200, 'A: GET /register → 200');

  r = await A.postForm('/register', { phone: PHONE_A, username: USER_A, password: PW });
  eq(r.status, 302, 'A: register → 302 (logged in)');
  r = await A.get('/');
  eq(r.status, 200, 'A: home after register → 200');
  contains(r.text, USER_A, 'A: home shows logged-in username');

  r = await B.postForm('/register', { phone: PHONE_A, username: 'someoneelse', password: PW });
  eq(r.status, 400, 'A: duplicate phone → 400');
  contains(r.text, 'already registered', 'A: duplicate phone error message');

  r = await B.postForm('/register', { phone: PHONE_B, username: USER_A, password: PW });
  eq(r.status, 400, 'A: duplicate username → 400');
  contains(r.text, 'taken', 'A: duplicate username error message');

  // ---- logout ----
  ok(await refreshCsrf(A), 'A: CSRF token parsed from page');
  r = await A.postForm('/logout', { _csrf: A.csrf });
  eq(r.status, 302, 'A: logout → 302');
  r = await A.get('/me');
  eq(r.status, 302, 'A: /me after logout → 302 to login');
  ok(locationOf(r).includes('/login'), 'A: /me redirect points at /login');

  // ---- login by phone, by username, wrong password ----
  r = await A.postForm('/login', { identifier: PHONE_A, password: PW });
  eq(r.status, 302, 'A: login by phone → 302');
  r = await A.get('/me');
  eq(r.status, 200, 'A: /me after phone login → 200');

  await refreshCsrf(A);
  r = await A.postForm('/logout', { _csrf: A.csrf });
  eq(r.status, 302, 'A: logout again → 302');

  r = await A.postForm('/login', { identifier: USER_A, password: PW });
  eq(r.status, 302, 'A: login by username → 302');
  r = await A.get('/me');
  eq(r.status, 200, 'A: /me after username login → 200');

  await refreshCsrf(A);
  r = await A.postForm('/logout', { _csrf: A.csrf });
  r = await A.postForm('/login', { identifier: USER_A, password: 'wrongpassword1' });
  eq(r.status, 401, 'A: wrong password → 401');
  contains(r.text, 'Invalid credentials', 'A: wrong password error message');
  r = await A.get('/me');
  eq(r.status, 302, 'A: still logged out after wrong password');

  r = await A.postForm('/login', { identifier: PHONE_A, password: PW });
  eq(r.status, 302, 'A: re-login as A → 302');
  ok(await refreshCsrf(A), 'A: CSRF token available for API calls');

  // B registers + logs in (B's earlier attempts failed validation).
  r = await B.postForm('/register', { phone: PHONE_B, username: USER_B, password: PW });
  eq(r.status, 302, 'A: B registers → 302');
  ok(await refreshCsrf(B), 'B: CSRF token available');

  // ---- CSRF: state-changing POST with session but no token → 403 ----
  r = await A.rawPostJson('/api/posts', { community_id: 2, title: 'x', body: 'y' });
  eq(r.status, 403, 'A: POST /api/posts without CSRF token → 403');
  r = await A.postForm('/logout', {});
  eq(r.status, 403, 'A: POST /logout without CSRF token → 403');
  ok(await refreshCsrf(A), 'A: CSRF token re-parsed');

  // ---- admin claim flow (token preset via env, never printed) ----
  r = await anon.get('/admin/claim?token=deadbeef');
  eq(r.status, 404, 'A: claim with bad token → 404');
  r = await anon.get('/admin/claim?token=' + CLAIM_TOKEN);
  eq(r.status, 200, 'A: claim with good token → 200');
  contains(r.text, 'Claim', 'A: claim page renders');
  r = await anon.postForm('/admin/claim', { token: CLAIM_TOKEN, phone: ADMIN_PHONE, password: ADMIN_PW });
  eq(r.status, 302, 'A: claim POST → 302');
  ok(locationOf(r).includes('/login'), 'A: claim redirects to /login');
  r = await anon.get('/admin/claim?token=' + CLAIM_TOKEN);
  eq(r.status, 404, 'A: claim token single-use → 404 after claim');

  r = await admin.postForm('/login', { identifier: ADMIN_PHONE, password: ADMIN_PW });
  eq(r.status, 302, 'A: admin login → 302');
  r = await admin.get('/admin');
  eq(r.status, 200, 'A: admin dashboard → 200');
  contains(r.text, 'Admin', 'A: dashboard renders');
  ok(await refreshCsrf(admin), 'admin: CSRF token available');

  // community ids for the seeded communities
  r = await admin.get('/admin/communities');
  eq(r.status, 200, 'A: admin communities page → 200');
  const discId = communityIdFromAdminPage(r.text, 'discussions');
  const annId = communityIdFromAdminPage(r.text, 'announcements');
  ok(Number.isInteger(discId) && discId > 0, `A: discussions community id found (${discId})`);
  ok(Number.isInteger(annId) && annId > 0, `A: announcements community id found (${annId})`);

  // ---- posts ----
  r = await A.postJson('/api/posts', { community_id: discId, title: 'First post by A', body: 'Hello from A. This is the body.' });
  eq(r.status, 200, 'A: create post → 200');
  ok(r.json && r.json.ok && Number.isInteger(r.json.id), 'A: post id returned');
  const postA = r.json.id;

  r = await A.postJson('/api/posts', { community_id: discId, title: 'First post by A', body: 'Hello from A. This is the body.' });
  eq(r.status, 429, 'A: duplicate post (same title, 5 min) → 429');

  r = await B.postJson('/api/posts', { community_id: discId, title: "B's post", body: 'Body of B post for moderation tests.' });
  eq(r.status, 200, "A: B creates post → 200");
  const postB = r.json.id;

  r = await A.get('/p/' + postA);
  eq(r.status, 200, 'A: GET /p/:id → 200');
  contains(r.text, 'First post by A', 'A: post page shows title');
  notContains(r.text, PHONE_A, 'A: post page hides phone A');

  // ---- votes: +1, toggle off, -1 ----
  r = await A.postJson('/api/vote', { target_type: 'post', target_id: postB, value: 1 });
  eq(r.status, 200, 'A: vote +1 → 200');
  eq(r.json.userVote, 1, 'A: vote +1 → userVote 1');
  eq(r.json.score, 1, 'A: vote +1 → score 1');

  r = await A.postJson('/api/vote', { target_type: 'post', target_id: postB, value: 1 });
  eq(r.status, 200, 'A: vote +1 again → 200');
  eq(r.json.userVote, 0, 'A: second +1 toggles vote off');
  eq(r.json.score, 0, 'A: toggled vote → score 0');

  r = await A.postJson('/api/vote', { target_type: 'post', target_id: postB, value: -1 });
  eq(r.status, 200, 'A: vote -1 → 200');
  eq(r.json.userVote, -1, 'A: vote -1 → userVote -1');
  eq(r.json.score, -1, 'A: vote -1 → score -1');

  // ---- comments: top-level, nested reply, depth cap ----
  r = await A.postJson('/api/thread/post/' + postA + '/comments', { body: 'Top-level comment by A' });
  eq(r.status, 200, 'A: comment on post → 200');
  const c1 = r.json.id;

  r = await B.postJson('/api/thread/post/' + postA + '/comments', { parent_id: c1, body: 'Reply by B to A' });
  eq(r.status, 200, 'A: nested reply by B → 200');
  const c2 = r.json.id;

  // Build the chain to MAX_DEPTH (6): c1..c6, then one more → 400.
  let parent = c2, depthIds = [c1, c2];
  for (let i = 0; i < 4; i++) {
    r = await A.postJson('/api/thread/post/' + postA + '/comments', { parent_id: parent, body: `depth filler ${i}` });
    eq(r.status, 200, `A: depth chain comment ${i + 3} → 200`);
    parent = r.json.id;
    depthIds.push(parent);
  }
  eq(depthIds.length, 6, 'A: chain is 6 deep');
  r = await A.postJson('/api/thread/post/' + postA + '/comments', { parent_id: parent, body: 'too deep' });
  eq(r.status, 400, 'A: reply beyond MAX_DEPTH → 400');
  contains(r.json.error || '', 'depth', 'A: depth-cap error message');

  // ---- @mention creates a notification for B; reply notifies A ----
  r = await A.postJson('/api/thread/post/' + postA + '/comments', { body: `Hey @${USER_B}, what do you think?` });
  eq(r.status, 200, 'A: mention comment → 200');
  const mentionC = r.json.id;
  r = await B.postJson('/api/thread/post/' + postA + '/comments', { parent_id: mentionC, body: 'Thanks for the mention!' });
  eq(r.status, 200, 'A: reply to mention comment → 200');

  r = await B.get('/notifications');
  eq(r.status, 200, 'A: B notifications page → 200');
  contains(r.text, 'mention', 'A: B got a mention notification');
  contains(r.text, USER_A, 'A: mention notification names actor A');
  notContains(r.text, PHONE_A, 'A: notifications page hides phone A');
  notContains(r.text, PHONE_B, 'A: notifications page hides phone B');

  r = await A.get('/notifications');
  eq(r.status, 200, 'A: A notifications page → 200');
  contains(r.text, 'replied to you', 'A: A got a reply notification');
  contains(r.text, USER_B, 'A: reply notification names actor B');

  // ---- comment edit: own within window ok; other's → 403 ----
  r = await A.putJson('/api/comments/' + c1, { body: 'Edited by A within window' });
  eq(r.status, 200, 'A: edit own comment → 200');
  r = await A.putJson('/api/comments/' + c2, { body: 'A tries to edit B comment' });
  eq(r.status, 403, "A: edit other's comment → 403");

  // ---- delete other's post → 403 ----
  r = await A.delJson('/api/posts/' + postB);
  eq(r.status, 403, "A: delete other's post → 403");

  // ---- reports: create + duplicate → 409 ----
  r = await A.postJson('/api/reports', { target_type: 'post', target_id: postB, reason: 'spam test report' });
  eq(r.status, 200, 'A: report post → 200');
  r = await A.postJson('/api/reports', { target_type: 'post', target_id: postB, reason: 'spam test report again' });
  eq(r.status, 409, 'A: duplicate report → 409');

  // ---- phone number NEVER in public responses ----
  const leakChecks = [
    ['/', anon],
    ['/p/' + postA, anon],
    ['/u/' + USER_A, anon],
    ['/u/' + USER_B, anon],
    ['/api/thread/post/' + postA + '/comments', anon],
    ['/search?q=' + USER_A, anon],
    ['/search?q=' + encodeURIComponent(PHONE_A.slice(1)), anon],
    ['/c/discussions', anon],
    ['/notifications', A],
  ];
  for (const [p, cl] of leakChecks) {
    r = await cl.get(p);
    ok(r.status === 200, `A: leak sweep GET ${p} → 200 (got ${r.status})`);
    notContains(r.text, PHONE_A, `A: no phone-A leak on ${p}`);
    notContains(r.text, PHONE_B, `A: no phone-B leak on ${p}`);
    notContains(r.text, ADMIN_PHONE, `A: no admin-phone leak on ${p}`);
  }

  // ---- vote rate limit: 60/min per user (3 votes used above) ----
  const statuses = [];
  for (let i = 0; i < 61; i++) {
    r = await A.postJson('/api/vote', { target_type: 'post', target_id: postA, value: i % 2 ? 1 : -1 });
    statuses.push(r.status);
  }
  eq(statuses[56], 200, 'A: 60th vote request overall → 200');
  eq(statuses[57], 429, 'A: 61st vote request overall → 429');
  eq(statuses[60], 429, 'A: further votes stay 429');

  // ---- non-admin phone view → 403 (before any blocking) ----
  const uidA = userIdInThreadComments((await anon.get('/api/thread/post/' + postA + '/comments')).json, USER_A);
  const uidB = userIdInThreadComments((await anon.get('/api/thread/post/' + postA + '/comments')).json, USER_B);
  ok(Number.isInteger(uidA) && Number.isInteger(uidB), `A: user ids resolved from thread (${uidA}, ${uidB})`);
  r = await A.get('/admin/users/' + uidA + '/phone');
  eq(r.status, 403, 'A: non-admin GET phone view → 403');

  // ---- block B: session dies; unblock ----
  r = await admin.postForm('/admin/users/' + uidB + '/block', { _csrf: admin.csrf });
  eq(r.status, 302, 'A: admin blocks B → 302');
  // B's session was destroyed server-side: any auth-required page must bounce
  // to /login (the public home page renders anonymously, so /me is the check).
  r = await B.get('/me');
  eq(r.status, 302, 'A: blocked B session dead → /me 302');
  ok(locationOf(r).includes('/login'), 'A: blocked B redirected to /login');
  r = await B.postJson('/api/vote', { target_type: 'post', target_id: postA, value: 1 });
  eq(r.status, 401, 'A: blocked B API call → 401');
  r = await admin.postForm('/admin/users/' + uidB + '/unblock', { _csrf: admin.csrf });
  eq(r.status, 302, 'A: admin unblocks B → 302');

  // ---- admin phone view: shows number + audit_log row ----
  r = await admin.get('/admin/users/' + uidA + '/phone');
  eq(r.status, 200, 'A: admin phone view → 200');
  contains(r.text, PHONE_A, 'A: phone view shows the number to admin');
  r = await admin.get('/admin/audit');
  eq(r.status, 200, 'A: admin audit page → 200');
  contains(r.text, 'phone.view', 'A: audit log has phone.view row');

  // ---- admin creates community; posts an announcement ----
  r = await admin.postForm('/admin/communities', {
    slug: 'news', title: 'News', description: 'Site news.', allow_posts: 'on', _csrf: admin.csrf,
  });
  eq(r.status, 302, 'A: admin creates community → 302');
  r = await admin.get('/admin/communities');
  const newsId = communityIdFromAdminPage(r.text, 'news');
  ok(Number.isInteger(newsId) && newsId > 0, `A: new community id found (${newsId})`);

  r = await admin.postJson('/api/posts', { community_id: annId, title: 'Announcement One', body: 'Official announcement body.' });
  eq(r.status, 200, 'A: admin posts announcement → 200');
  r = await anon.get('/c/announcements');
  eq(r.status, 200, 'A: announcements page → 200');
  contains(r.text, 'Announcement One', 'A: announcement visible in announcements');

  // ---- resolve report with hide ----
  r = await admin.get('/admin/reports');
  eq(r.status, 200, 'A: admin reports page → 200');
  const rm = r.text.match(/\/admin\/reports\/(\d+)\/resolve/);
  ok(rm, 'A: report id found on reports page');
  const reportId = rm ? rm[1] : '0';
  r = await admin.postForm('/admin/reports/' + reportId + '/resolve', { hide_target: 'on', _csrf: admin.csrf });
  eq(r.status, 302, 'A: resolve report with hide → 302');
  r = await anon.get('/p/' + postB);
  eq(r.status, 404, 'A: hidden reported post → 404');

  await shutdown(srv);
  console.log(`Suite A done: ${pass}/${total} assertions passed so far.`);
}

// ================= SUITE B — AUTH_MODE=otp, OTP_PROVIDER=dev =================
const OTP1 = { phone: '+923005556667', user: 'otpuser1' };
const OTP2 = { phone: '+923005556668', user: 'otpuser2' };
const OTP3 = { phone: '+923005556669', user: 'otpuser3' };

async function suiteB() {
  console.log('\n=== Suite B (AUTH_MODE=otp, OTP_PROVIDER=dev) ===');
  const srv = await boot({ AUTH_MODE: 'otp', OTP_PROVIDER: 'dev' });
  const base = `http://127.0.0.1:${srv.port}`;
  const C = makeClient(base); // anonymous until verified

  // ---- register step 1: verify form + dev code on stdout ----
  let r = await C.postForm('/register', { phone: OTP1.phone, username: OTP1.user });
  eq(r.status, 200, 'B: register step 1 → 200 (verify form)');
  contains(r.text, '6-digit code', 'B: verify form mentions the code');
  await srv.waitFor(new RegExp(`\\[otp\\]\\[dev\\] code for \\${OTP1.phone.replace('+', '\\+')}`));
  const code1 = parseLatestOtp(srv, OTP1.phone, 'register');
  ok(/^\d{6}$/.test(code1 || ''), `B: dev OTP code captured from stdout (${code1})`);

  // ---- resend cooldown: immediate second send → 429 ----
  r = await C.postForm('/register', { phone: OTP1.phone, username: OTP1.user });
  eq(r.status, 429, 'B: immediate resend → 429 (cooldown)');

  // ---- wrong code ×5 → 400 each; 6th attempt locks the code out ----
  for (let i = 0; i < 5; i++) {
    r = await C.postJson('/api/otp/verify', { phone: OTP1.phone, purpose: 'register', code: '000000', username: OTP1.user });
    eq(r.status, 400, `B: wrong code attempt ${i + 1} → 400`);
    contains(r.json.error || '', 'Incorrect code', `B: wrong code attempt ${i + 1} message`);
  }
  r = await C.postJson('/api/otp/verify', { phone: OTP1.phone, purpose: 'register', code: '000000', username: OTP1.user });
  eq(r.status, 400, 'B: 6th wrong attempt → 400 (locked)');
  contains(r.json.error || '', 'expired', 'B: locked code reports expiry');

  // The correct code no longer works after lockout either.
  r = await C.postJson('/api/otp/verify', { phone: OTP1.phone, purpose: 'register', code: code1, username: OTP1.user });
  eq(r.status, 400, 'B: correct code after lockout → 400');

  // ---- fresh register for OTP2, verify with the correct code → account ----
  r = await C.postForm('/register', { phone: OTP2.phone, username: OTP2.user });
  eq(r.status, 200, 'B: register step 1 for user2 → 200');
  await srv.waitFor(new RegExp(`\\[otp\\]\\[dev\\] code for \\${OTP2.phone.replace('+', '\\+')} \\(register\\)`));
  const code2 = parseLatestOtp(srv, OTP2.phone, 'register');
  ok(/^\d{6}$/.test(code2 || ''), 'B: dev OTP code captured for user2');
  r = await C.postJson('/api/otp/verify', { phone: OTP2.phone, purpose: 'register', code: code2, username: OTP2.user });
  eq(r.status, 200, 'B: correct register code → 200');
  ok(r.json && r.json.ok === true, 'B: register verify returns ok:true');

  // ---- single-use: the same code cannot be verified twice ----
  // (fresh anonymous client: C now holds a session, and the global CSRF
  // middleware would 403 a token-less POST before OTP logic runs.)
  const F = makeClient(base);
  r = await F.postJson('/api/otp/verify', { phone: OTP2.phone, purpose: 'register', code: code2, username: OTP2.user });
  eq(r.status, 400, 'B: reused code → 400 (single-use)');
  contains(r.json.error || '', 'expired', 'B: reused code reports expiry');

  // Registration logs the user in.
  r = await C.get('/me');
  eq(r.status, 200, 'B: /me after OTP registration → 200 (logged in)');
  contains(r.text, OTP2.user, 'B: profile shows username');

  // ---- register OTP3 (used for the expiry test) ----
  const E = makeClient(base);
  r = await E.postForm('/register', { phone: OTP3.phone, username: OTP3.user });
  eq(r.status, 200, 'B: register step 1 for user3 → 200');
  await srv.waitFor(new RegExp(`\\[otp\\]\\[dev\\] code for \\${OTP3.phone.replace('+', '\\+')} \\(register\\)`));
  const code3 = parseLatestOtp(srv, OTP3.phone, 'register');
  r = await E.postJson('/api/otp/verify', { phone: OTP3.phone, purpose: 'register', code: code3, username: OTP3.user });
  eq(r.status, 200, 'B: user3 registered → 200');

  // ---- login OTP send for user3, then expire the code in the DB ----
  const D = makeClient(base);
  r = await D.postJson('/api/otp/send', { phone: OTP3.phone, purpose: 'login' });
  eq(r.status, 200, 'B: login OTP send for user3 → 200');
  ok(r.json && r.json.ok === true, 'B: login OTP send returns ok:true');
  await srv.waitFor(new RegExp(`\\[otp\\]\\[dev\\] code for \\${OTP3.phone.replace('+', '\\+')} \\(login\\)`));
  const code3b = parseLatestOtp(srv, OTP3.phone, 'login');
  ok(/^\d{6}$/.test(code3b || ''), 'B: login OTP code captured for user3');

  // Move the code's expiry into the past directly in the DB.
  const dbm = require('../db');
  await dbm.init();
  await dbm.prepare("UPDATE otp_codes SET expires_at = '2000-01-01 00:00:00' WHERE phone = ? AND purpose = 'login'")
    .run(OTP3.phone);
  r = await D.postJson('/api/otp/verify', { phone: OTP3.phone, purpose: 'login', code: code3b });
  eq(r.status, 400, 'B: expired code → 400');
  contains(r.json.error || '', 'expired', 'B: expired code message');

  // ---- full login OTP flow with a correct code (user2) ----
  r = await D.postJson('/api/otp/send', { phone: OTP2.phone, purpose: 'login' });
  eq(r.status, 200, 'B: login OTP send for user2 → 200');
  // Immediate resend hits the 60s cooldown.
  r = await D.postJson('/api/otp/send', { phone: OTP2.phone, purpose: 'login' });
  eq(r.status, 429, 'B: immediate login resend → 429 (cooldown)');
  await srv.waitFor(new RegExp(`\\[otp\\]\\[dev\\] code for \\${OTP2.phone.replace('+', '\\+')} \\(login\\)`));
  const code2b = parseLatestOtp(srv, OTP2.phone, 'login');
  ok(/^\d{6}$/.test(code2b || ''), 'B: login OTP code captured for user2');
  r = await D.postJson('/api/otp/verify', { phone: OTP2.phone, purpose: 'login', code: code2b });
  eq(r.status, 200, 'B: correct login code → 200');
  ok(r.json && r.json.ok === true, 'B: login verify returns ok:true');
  r = await D.get('/me');
  eq(r.status, 200, 'B: /me after OTP login → 200 (session works)');
  contains(r.text, OTP2.user, 'B: logged in as user2');

  await shutdown(srv);
  console.log(`Suite B done: ${pass}/${total} assertions passed so far.`);
}

// ================= runner =================
(async () => {
  const t0 = Date.now();
  try {
    wipeData();
    await suiteA();
    wipeData(); // kill-switch isolation: fresh DB for suite B
    await suiteB();
  } catch (e) {
    console.error('\nFATAL:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    wipeData(); // never leave ./data behind
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${pass}/${total} assertions passed in ${secs}s.`);
  if (failures.length) {
    console.log(`${failures.length} FAILURES:`);
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
})();
