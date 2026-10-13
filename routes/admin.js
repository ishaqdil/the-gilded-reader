// ================= ADMIN =================
// Admin dashboard backend.
//
// Mounted by server.js (which owns session/CSRF/security-header middleware) as:
//   require('./routes/admin')(app, {
//     db, auth, v, rl, requireAuth, requireAdmin, adminRl, clientIp, isSecureReq,
//     helpers: { escapeHtml, formatBody, fmtDate }, getSetting, audit,
//   });
// The old inline admin block in server.js is removed; this module is its complete
// replacement, plus the extended Reddit-style admin surface (communities, posts,
// reports, audit log, settings, phone-privacy views).
//
// Every route here requires admin (server-side role re-check via ctx.requireAdmin)
// and is rate-limited via adminRl. All SQL uses '?' placeholders and
// datetime('now') per the db.js contract (SQLite text timestamps / Postgres
// timestamptz both supported through the adapter).
//
// PHONE PRIVACY: the only query that ever selects the `phone` column is the
// dedicated GET /admin/users/:id/phone view, which audit-logs the access BEFORE
// rendering. User search may MATCH on phone (parameterized LIKE) but returns
// id/username/role/status/created_at only — never the number itself.

module.exports = (app, ctx) => {
  const { db, auth, v, rl, requireAdmin } = ctx;

  // Rate limiter for admin routes. Prefer the one server.js passes in ctx
  // (keyed on the admin's user id, 120 req/min).
  const adminRl =
    ctx.adminRl ||
    rl.middleware(
      (req) => 'adm:' + (req.user ? req.user.id : 'anon'),
      120,
      60_000,
      'Slow down.'
    );

  // Audit helper: INSERT INTO audit_log (admin_id, action, target_type, target_id, detail).
  const audit =
    ctx.audit ||
    (async (adminId, action, targetType, targetId, detail) => {
      await db
        .prepare(
          'INSERT INTO audit_log (admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?)'
        )
        .run(
          adminId,
          action,
          targetType || null,
          targetId == null ? null : targetId,
          detail == null ? null : String(detail)
        );
    });

  // Settings reader with fallback when server.js doesn't supply one.
  const getSetting =
    ctx.getSetting ||
    (async (key, fb) => {
      const r = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? r.value : fb;
    });

  // ---- Local validators (no new deps; lib/validate.js stays untouched) ----
  const SLUG_RE = /^[a-z0-9-]{2,32}$/;
  function slugOk(s) {
    return typeof s === 'string' && SLUG_RE.test(s.trim());
  }
  function textLen(val, max) {
    // Returns trimmed string (may be ''), or null when over max / not a string.
    if (typeof val !== 'string') return null;
    const s = val.trim().replace(/\s+/g, ' ');
    return s.length <= max ? s : null;
  }
  function likeEscape(q) {
    return q.replace(/[\\%_]/g, (c) => '\\' + c);
  }
  function sqlCutoffDaysAgo(days) {
    // Portable 'YYYY-MM-DD HH:MM:SS' cutoff param (SQLite stores datetime('now');
    // Postgres casts the string to timestamptz). The pg adapter does not
    // translate datetime('now','-N days'), so compute in JS instead.
    return new Date(Date.now() - days * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
  }

  // ================= DASHBOARD =================
  app.get('/admin', requireAdmin, adminRl, async (req, res) => {
    // Number() because the Postgres adapter returns COUNT(*) as a string;
    // the view does arithmetic (visible+hidden totals), so coerce here.
    const count = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).c);
    const stats = {
      users: await count('SELECT COUNT(*) c FROM users'),
      blocked: await count("SELECT COUNT(*) c FROM users WHERE status='blocked'"),
      admins: await count("SELECT COUNT(*) c FROM users WHERE role='admin'"),
      chapters: await count('SELECT COUNT(*) c FROM chapters'),
      published: await count('SELECT COUNT(*) c FROM chapters WHERE published=1'),
      communities: await count('SELECT COUNT(*) c FROM communities'),
      postsVisible: await count("SELECT COUNT(*) c FROM posts WHERE status='visible'"),
      postsHidden: await count("SELECT COUNT(*) c FROM posts WHERE status='hidden'"),
      commentsVisible: await count("SELECT COUNT(*) c FROM comments WHERE status='visible'"),
      commentsHidden: await count("SELECT COUNT(*) c FROM comments WHERE status='hidden'"),
      votes: await count('SELECT COUNT(*) c FROM votes'),
      reportsOpen: await count("SELECT COUNT(*) c FROM reports WHERE status='open'"),
      notifications: await count('SELECT COUNT(*) c FROM notifications'),
      phoneViews: await count(
        "SELECT COUNT(*) c FROM audit_log WHERE action='phone.view' AND created_at >= ?",
        sqlCutoffDaysAgo(30)
      ),
    };
    const recentComments = await db
      .prepare(
        `SELECT c.id, c.body, c.created_at, c.status, u.username,
                ch.id AS chid, ch.number AS chnum, ch.title AS chtitle,
                p.id AS pid, p.title AS ptitle, co.slug AS comslug
         FROM comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN chapters ch ON ch.id = c.chapter_id
         LEFT JOIN posts p ON p.id = c.post_id
         LEFT JOIN communities co ON co.id = p.community_id
         ORDER BY c.created_at DESC LIMIT 8`
      )
      .all();
    const recentPosts = await db
      .prepare(
        `SELECT p.id, p.title, p.status, p.pinned, p.created_at, u.username, co.slug AS comslug
         FROM posts p
         JOIN users u ON u.id = p.user_id
         JOIN communities co ON co.id = p.community_id
         ORDER BY p.created_at DESC LIMIT 8`
      )
      .all();
    const recentAudit = await db
      .prepare(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.username AS admin_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
         ORDER BY a.created_at DESC LIMIT 5`
      )
      .all();
    res.render('admin/dashboard', { title: 'Admin dashboard', stats, recentComments, recentPosts, recentAudit });
  });

  // ================= CHAPTERS (existing behavior, preserved exactly) =================
  app.get('/admin/chapters', requireAdmin, adminRl, async (req, res) => {
    const chapters = await db
      .prepare(
        `SELECT ch.id, ch.number, ch.title, ch.published, ch.updated_at,
           (SELECT COUNT(*) FROM comments c WHERE c.chapter_id = ch.id) AS comment_count
         FROM chapters ch ORDER BY ch.number ASC`
      )
      .all();
    res.render('admin/chapters', { title: 'Manage chapters', chapters });
  });
  app.get('/admin/chapters/new', requireAdmin, async (req, res) => {
    const nextNum = ((await db.prepare('SELECT MAX(number) m FROM chapters').get()).m || 0) + 1;
    res.render('admin/chapter-form', {
      title: 'New chapter',
      ch: { number: nextNum, title: '', excerpt: '', body: '', published: 1 },
      error: null,
      editing: false,
    });
  });
  app.post('/admin/chapters', requireAdmin, adminRl, async (req, res) => {
    const number = v.chapterNumber(req.body.number);
    const title = v.chapterTitle(req.body.title);
    const body = v.chapterBody(req.body.body);
    const excerpt = typeof req.body.excerpt === 'string' ? req.body.excerpt.trim().slice(0, 400) : '';
    const published = req.body.published === 'on' ? 1 : 0;
    const render = (error) =>
      res.status(400).render('admin/chapter-form', {
        title: 'New chapter',
        ch: { number: req.body.number, title: req.body.title || '', excerpt, body: req.body.body || '', published },
        error,
        editing: false,
      });
    if (!number || !title || !body) return render('Chapter number, title and body are required (body up to 200k chars).');
    if (await db.prepare('SELECT 1 FROM chapters WHERE number = ?').get(number))
      return render('A chapter with that number already exists.');
    const finalExcerpt = excerpt || body.replace(/\s+/g, ' ').slice(0, 180);
    await db
      .prepare('INSERT INTO chapters (number, title, excerpt, body, published) VALUES (?,?,?,?,?)')
      .run(number, title, finalExcerpt, body, published);
    res.redirect('/admin/chapters?ok=1');
  });
  app.get('/admin/chapters/:id/edit', requireAdmin, async (req, res) => {
    const id = v.intId(req.params.id);
    const ch = id && (await db.prepare('SELECT * FROM chapters WHERE id = ?').get(id));
    if (!ch) return res.status(404).render('404', { title: 'Not found' });
    res.render('admin/chapter-form', { title: 'Edit chapter', ch, error: null, editing: true });
  });
  app.post('/admin/chapters/:id', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const existing = id && (await db.prepare('SELECT * FROM chapters WHERE id = ?').get(id));
    if (!existing) return res.status(404).render('404', { title: 'Not found' });
    const number = v.chapterNumber(req.body.number);
    const title = v.chapterTitle(req.body.title);
    const body = v.chapterBody(req.body.body);
    const excerpt = typeof req.body.excerpt === 'string' ? req.body.excerpt.trim().slice(0, 400) : '';
    const published = req.body.published === 'on' ? 1 : 0;
    const render = (error) =>
      res.status(400).render('admin/chapter-form', {
        title: 'Edit chapter',
        ch: { id, number: req.body.number, title: req.body.title || '', excerpt, body: req.body.body || '', published },
        error,
        editing: true,
      });
    if (!number || !title || !body) return render('Chapter number, title and body are required.');
    const clash = await db.prepare('SELECT 1 FROM chapters WHERE number = ? AND id != ?').get(number, id);
    if (clash) return render('Another chapter already uses that number.');
    const finalExcerpt = excerpt || body.replace(/\s+/g, ' ').slice(0, 180);
    await db
      .prepare("UPDATE chapters SET number=?, title=?, excerpt=?, body=?, published=?, updated_at=datetime('now') WHERE id = ?")
      .run(number, title, finalExcerpt, body, published, id);
    res.redirect('/admin/chapters?ok=1');
  });
  app.post('/admin/chapters/:id/delete', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare('DELETE FROM chapters WHERE id = ?').run(id); // comments cascade
    res.redirect('/admin/chapters?ok=1');
  });

  // ================= USERS =================
  // Search matches username OR phone, but results never include the phone column.
  app.get('/admin/users', requireAdmin, adminRl, async (req, res) => {
    const q = v.searchQuery(req.query.q);
    const base = `
      SELECT u.id, u.username, u.role, u.status, u.created_at,
        (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count
      FROM users u`;
    let users;
    if (q) {
      const pat = likeEscape(q);
      users = await db
        .prepare(
          base +
            ` WHERE u.username LIKE '%' || ? || '%' ESCAPE '\\'
                 OR u.phone LIKE '%' || ? || '%' ESCAPE '\\'
              ORDER BY u.created_at DESC LIMIT 100`
        )
        .all(pat, pat);
    } else {
      users = await db.prepare(base + ' ORDER BY u.created_at DESC LIMIT 100').all();
    }
    res.render('admin/users', { title: 'Manage users', users, q });
  });

  // User detail: public fields + activity counts + reports against them + audit rows about them.
  // Never selects phone.
  app.get('/admin/users/:id', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const u = id && (await db
      .prepare('SELECT id, username, phone_verified, avatar, bio, role, status, created_at FROM users WHERE id = ?')
      .get(id));
    if (!u) return res.status(404).render('404', { title: 'Not found' });
    const counts = {
      comments: (await db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id = ?').get(id)).c,
      posts: (await db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(id)).c,
      votes: (await db.prepare('SELECT COUNT(*) c FROM votes WHERE user_id = ?').get(id)).c,
      reportsFiled: (await db.prepare('SELECT COUNT(*) c FROM reports WHERE reporter_id = ?').get(id)).c,
      reportsAgainst: (
        await db
          .prepare(
            `SELECT COUNT(*) c FROM reports r WHERE
               (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?)) OR
               (r.target_type = 'post' AND r.target_id IN (SELECT id FROM posts WHERE user_id = ?))`
          )
          .get(id, id)
      ).c,
    };
    const reportsAgainst = await db
      .prepare(
        `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, ru.username AS reporter
         FROM reports r JOIN users ru ON ru.id = r.reporter_id
         WHERE (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?)) OR
               (r.target_type = 'post' AND r.target_id IN (SELECT id FROM posts WHERE user_id = ?))
         ORDER BY r.created_at DESC LIMIT 10`
      )
      .all(id, id);
    const auditRows = await db
      .prepare(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, au.username AS admin_name
         FROM audit_log a LEFT JOIN users au ON au.id = a.admin_id
         WHERE (a.target_type = 'user' AND a.target_id = ?) OR a.admin_id = ?
         ORDER BY a.created_at DESC LIMIT 10`
      )
      .all(id, id);
    const me = req.user.id === id;
    res.render('admin/user-detail', { title: 'User: ' + u.username, u, counts, reportsAgainst, auditRows, me });
  });

  // Phone view: the ONLY place a phone number is ever displayed.
  // Writes the audit row BEFORE rendering.
  app.get('/admin/users/:id/phone', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const u = id && (await db.prepare('SELECT id, username FROM users WHERE id = ?').get(id));
    if (!u) return res.status(404).render('404', { title: 'Not found' });
    await audit(req.user.id, 'phone.view', 'user', id, 'phone view for @' + u.username);
    const row = await db.prepare('SELECT id, username, phone, phone_verified FROM users WHERE id = ?').get(id);
    res.render('admin/phone', { title: 'Phone: ' + row.username, u: row });
  });

  app.post('/admin/users/:id/block', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const target = id && (await db.prepare('SELECT id, role, username FROM users WHERE id = ?').get(id));
    if (!target) return res.status(404).render('404', { title: 'Not found' });
    if (target.id === req.user.id)
      return res.status(400).render('error', { title: 'Error', message: 'You cannot block yourself.', status: 400 });
    if (target.role === 'admin')
      return res.status(400).render('error', { title: 'Error', message: 'Admin accounts cannot be blocked.', status: 400 });
    await db.prepare("UPDATE users SET status='blocked' WHERE id = ?").run(id);
    await auth.destroyUserSessions(id);
    await audit(req.user.id, 'user.block', 'user', id, '@' + target.username + ' blocked');
    res.redirect('/admin/users?ok=1');
  });
  app.post('/admin/users/:id/unblock', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const target = id && (await db.prepare('SELECT id, username FROM users WHERE id = ?').get(id));
    if (!target) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare("UPDATE users SET status='active' WHERE id = ?").run(id);
    await audit(req.user.id, 'user.unblock', 'user', id, '@' + target.username + ' unblocked');
    res.redirect('/admin/users?ok=1');
  });

  // ================= COMMENTS MODERATION =================
  // Listing now covers post comments too (LEFT JOIN chapters + posts for context).
  app.get('/admin/comments', requireAdmin, adminRl, async (req, res) => {
    const filter = req.query.f === 'hidden' ? 'hidden' : 'all';
    const comments = await db
      .prepare(
        `SELECT c.id, c.body, c.created_at, c.status, u.username,
                ch.id AS chid, ch.number AS chnum, ch.title AS chtitle,
                p.id AS pid, p.title AS ptitle, co.slug AS comslug
         FROM comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN chapters ch ON ch.id = c.chapter_id
         LEFT JOIN posts p ON p.id = c.post_id
         LEFT JOIN communities co ON co.id = p.community_id
         ${filter === 'hidden' ? "WHERE c.status='hidden'" : ''}
         ORDER BY c.created_at DESC LIMIT 100`
      )
      .all();
    res.render('admin/comments', { title: 'Moderate comments', comments, filter });
  });
  app.post('/admin/comments/:id/hide', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (id) {
      await db.prepare("UPDATE comments SET status='hidden' WHERE id = ?").run(id);
      await audit(req.user.id, 'comment.hide', 'comment', id, null);
    }
    res.redirect('/admin/comments?ok=1');
  });
  app.post('/admin/comments/:id/show', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (id) {
      await db.prepare("UPDATE comments SET status='visible' WHERE id = ?").run(id);
      await audit(req.user.id, 'comment.show', 'comment', id, null);
    }
    res.redirect('/admin/comments?ok=1');
  });
  app.post('/admin/comments/:id/delete', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (id) {
      await db.prepare('DELETE FROM comments WHERE id = ?').run(id);
      await audit(req.user.id, 'comment.delete', 'comment', id, null);
    }
    res.redirect('/admin/comments?ok=1');
  });

  // ================= COMMUNITIES =================
  app.get('/admin/communities', requireAdmin, adminRl, async (req, res) => {
    const communities = await db
      .prepare(
        `SELECT cm.id, cm.slug, cm.title, cm.description, cm.allow_posts, cm.created_at,
           (SELECT COUNT(*) FROM posts p WHERE p.community_id = cm.id) AS post_count
         FROM communities cm ORDER BY cm.title ASC`
      )
      .all();
    res.render('admin/communities', { title: 'Manage communities', communities, error: null, form: {} });
  });
  app.post('/admin/communities', requireAdmin, adminRl, async (req, res) => {
    const slug = typeof req.body.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
    const title = textLen(req.body.title, 80);
    const description = textLen(req.body.description || '', 500);
    const allowPosts = req.body.allow_posts === 'on' ? 1 : 0;
    const communities = await db
      .prepare(
        `SELECT cm.id, cm.slug, cm.title, cm.description, cm.allow_posts, cm.created_at,
           (SELECT COUNT(*) FROM posts p WHERE p.community_id = cm.id) AS post_count
         FROM communities cm ORDER BY cm.title ASC`
      )
      .all();
    const render = (error) =>
      res.status(400).render('admin/communities', {
        title: 'Manage communities',
        communities,
        error,
        form: { slug, title: req.body.title || '', description: req.body.description || '', allow_posts: allowPosts },
      });
    if (!slugOk(slug)) return render('Slug must be 2–32 characters: lowercase letters, numbers, hyphens.');
    if (!title) return render('Title is required (1–80 characters).');
    if (description === null) return render('Description is too long (max 500 characters).');
    if (await db.prepare('SELECT 1 FROM communities WHERE slug = ?').get(slug))
      return render('That slug is already taken.');
    const r = await db
      .prepare('INSERT INTO communities (slug, title, description, allow_posts) VALUES (?,?,?,?)')
      .run(slug, title, description, allowPosts);
    await audit(req.user.id, 'community.create', 'community', Number(r.lastInsertRowid), slug);
    res.redirect('/admin/communities?ok=1');
  });
  app.post('/admin/communities/:id', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const existing = id && (await db.prepare('SELECT * FROM communities WHERE id = ?').get(id));
    if (!existing) return res.status(404).render('404', { title: 'Not found' });
    const slug = typeof req.body.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
    const title = textLen(req.body.title, 80);
    const description = textLen(req.body.description || '', 500);
    const allowPosts = req.body.allow_posts === 'on' ? 1 : 0;
    const fail = (msg) => res.status(400).render('error', { title: 'Error', message: msg, status: 400 });
    if (!slugOk(slug)) return fail('Slug must be 2–32 characters: lowercase letters, numbers, hyphens.');
    if (!title) return fail('Title is required (1–80 characters).');
    if (description === null) return fail('Description is too long (max 500 characters).');
    if (await db.prepare('SELECT 1 FROM communities WHERE slug = ? AND id != ?').get(slug, id))
      return fail('That slug is already taken by another community.');
    await db
      .prepare('UPDATE communities SET slug=?, title=?, description=?, allow_posts=? WHERE id = ?')
      .run(slug, title, description, allowPosts, id);
    await audit(req.user.id, 'community.update', 'community', id, slug);
    res.redirect('/admin/communities?ok=1');
  });
  app.post('/admin/communities/:id/delete', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const existing = id && (await db.prepare('SELECT slug FROM communities WHERE id = ?').get(id));
    if (!existing) return res.status(404).render('404', { title: 'Not found' });
    const postCount = (await db.prepare('SELECT COUNT(*) c FROM posts WHERE community_id = ?').get(id)).c;
    if (postCount > 0)
      return res
        .status(400)
        .render('error', { title: 'Error', message: 'Cannot delete a community that still has posts. Move or delete its posts first.', status: 400 });
    await db.prepare('DELETE FROM communities WHERE id = ?').run(id);
    await audit(req.user.id, 'community.delete', 'community', id, existing.slug);
    res.redirect('/admin/communities?ok=1');
  });

  // ================= POSTS =================
  // Admin creation of announcement posts reuses the public POST /api/posts
  // (communities with allow_posts=0 still accept posts from admins via an admin
  // bypass there) — no separate admin create route is needed.
  app.get('/admin/posts', requireAdmin, adminRl, async (req, res) => {
    const statusF = req.query.status === 'visible' || req.query.status === 'hidden' ? req.query.status : '';
    const communityF = v.intId(req.query.community);
    const where = [];
    const params = [];
    if (statusF) {
      where.push('p.status = ?');
      params.push(statusF);
    }
    if (communityF) {
      where.push('p.community_id = ?');
      params.push(communityF);
    }
    const posts = await db
      .prepare(
        `SELECT p.id, p.title, SUBSTR(p.body, 1, 160) AS excerpt, p.status, p.pinned, p.created_at,
                u.username, co.slug AS community_slug, co.title AS community_title,
                COALESCE((SELECT SUM(v.value) FROM votes v WHERE v.target_type = 'post' AND v.target_id = p.id), 0) AS score,
                (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS comment_count
         FROM posts p
         JOIN users u ON u.id = p.user_id
         JOIN communities co ON co.id = p.community_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.pinned DESC, p.created_at DESC LIMIT 100`
      )
      .all(...params);
    const communities = await db.prepare('SELECT id, slug, title FROM communities ORDER BY title ASC').all();
    res.render('admin/posts', { title: 'Manage posts', posts, communities, statusF, communityF: communityF || '' });
  });
  async function postOr404(id) {
    return id && (await db.prepare('SELECT id, title FROM posts WHERE id = ?').get(id));
  }
  app.post('/admin/posts/:id/pin', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!(await postOr404(id))) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare('UPDATE posts SET pinned = 1 WHERE id = ?').run(id);
    await audit(req.user.id, 'post.pin', 'post', id, null);
    res.redirect('/admin/posts?ok=1');
  });
  app.post('/admin/posts/:id/unpin', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!(await postOr404(id))) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare('UPDATE posts SET pinned = 0 WHERE id = ?').run(id);
    await audit(req.user.id, 'post.unpin', 'post', id, null);
    res.redirect('/admin/posts?ok=1');
  });
  app.post('/admin/posts/:id/hide', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!(await postOr404(id))) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare("UPDATE posts SET status = 'hidden' WHERE id = ?").run(id);
    await audit(req.user.id, 'post.hide', 'post', id, null);
    res.redirect('/admin/posts?ok=1');
  });
  app.post('/admin/posts/:id/show', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!(await postOr404(id))) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare("UPDATE posts SET status = 'visible' WHERE id = ?").run(id);
    await audit(req.user.id, 'post.show', 'post', id, null);
    res.redirect('/admin/posts?ok=1');
  });
  app.post('/admin/posts/:id/delete', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const p = await postOr404(id);
    if (!p) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare('DELETE FROM posts WHERE id = ?').run(id); // comments/votes cascade
    await audit(req.user.id, 'post.delete', 'post', id, p.title);
    res.redirect('/admin/posts?ok=1');
  });

  // ================= REPORTS =================
  app.get('/admin/reports', requireAdmin, adminRl, async (req, res) => {
    const valid = ['open', 'resolved', 'dismissed', 'all'];
    const statusF = valid.includes(req.query.status) ? req.query.status : 'open';
    const reports = await db
      .prepare(
        `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
                ru.username AS reporter,
                p.title AS post_title,
                SUBSTR(cm.body, 1, 140) AS comment_excerpt
         FROM reports r
         JOIN users ru ON ru.id = r.reporter_id
         LEFT JOIN posts p ON r.target_type = 'post' AND r.target_id = p.id
         LEFT JOIN comments cm ON r.target_type = 'comment' AND r.target_id = cm.id
         ${statusF === 'all' ? '' : 'WHERE r.status = ?'}
         ORDER BY r.created_at DESC LIMIT 100`
      )
      .all(...(statusF === 'all' ? [] : [statusF]));
    const openCount = (await db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open'").get()).c;
    res.render('admin/reports', { title: 'Reports', reports, statusF, openCount });
  });
  app.post('/admin/reports/:id/resolve', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const r = id && (await db.prepare('SELECT id, target_type, target_id FROM reports WHERE id = ?').get(id));
    if (!r) return res.status(404).render('404', { title: 'Not found' });
    const hideTarget = req.body.hide_target === 'on';
    if (hideTarget && r.target_type === 'post') {
      await db.prepare("UPDATE posts SET status = 'hidden' WHERE id = ?").run(r.target_id);
    } else if (hideTarget && r.target_type === 'comment') {
      await db.prepare("UPDATE comments SET status = 'hidden' WHERE id = ?").run(r.target_id);
    }
    await db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(id);
    await audit(
      req.user.id,
      'report.resolve',
      'report',
      id,
      r.target_type + '#' + r.target_id + (hideTarget ? ' (target hidden)' : '')
    );
    res.redirect('/admin/reports?ok=1');
  });
  app.post('/admin/reports/:id/dismiss', requireAdmin, adminRl, async (req, res) => {
    const id = v.intId(req.params.id);
    const r = id && (await db.prepare('SELECT id, target_type, target_id FROM reports WHERE id = ?').get(id));
    if (!r) return res.status(404).render('404', { title: 'Not found' });
    await db.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").run(id);
    await audit(req.user.id, 'report.dismiss', 'report', id, r.target_type + '#' + r.target_id);
    res.redirect('/admin/reports?ok=1');
  });

  // ================= AUDIT LOG =================
  app.get('/admin/audit', requireAdmin, adminRl, async (req, res) => {
    const PER_PAGE = 50;
    let page = v.intId(req.query.page) || 1;
    if (page < 1) page = 1;
    const total = (await db.prepare('SELECT COUNT(*) c FROM audit_log').get()).c;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page > pages) page = pages;
    const rows = await db
      .prepare(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.username AS admin_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
         ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(PER_PAGE, (page - 1) * PER_PAGE);
    res.render('admin/audit', { title: 'Audit log', rows, page, pages, total });
  });

  // ================= SETTINGS =================
  const SETTING_DEFS = [
    { key: 'site_name', def: 'The Gilded Cage', max: 60, required: true },
    { key: 'tagline', def: '', max: 120, required: false },
    { key: 'rules_text', def: '', max: 2000, required: false },
  ];
  const CHECKBOX_DEFS = [
    { key: 'registrations_open', def: '1' },
    { key: 'user_posts_enabled', def: '1' },
  ];
  async function readSettings() {
    const out = {};
    for (const d of SETTING_DEFS) out[d.key] = await getSetting(d.key, d.def);
    for (const d of CHECKBOX_DEFS) out[d.key] = (await getSetting(d.key, d.def)) === '1';
    return out;
  }
  async function upsertSetting(key, value) {
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key')
      .run(key, value);
  }
  app.get('/admin/settings', requireAdmin, adminRl, async (req, res) => {
    res.render('admin/settings', { title: 'Site settings', settings: await readSettings(), error: null });
  });
  app.post('/admin/settings', requireAdmin, adminRl, async (req, res) => {
    const vals = {};
    for (const d of SETTING_DEFS) {
      const t = textLen(req.body[d.key] ?? '', d.max);
      if (t === null || (d.required && !t)) {
        return res.status(400).render('admin/settings', {
          title: 'Site settings',
          settings: await readSettings(),
          error: d.key === 'site_name' ? 'Site name is required (1–60 characters).' : `“${d.key}” is too long (max ${d.max} characters).`,
        });
      }
      vals[d.key] = t;
    }
    for (const d of CHECKBOX_DEFS) vals[d.key] = req.body[d.key] === 'on' ? '1' : '0';
    for (const k of Object.keys(vals)) await upsertSetting(k, vals[k]);
    await audit(req.user.id, 'settings.update', 'setting', null, Object.keys(vals).join(', '));
    res.redirect('/admin/settings?ok=1');
  });
};
