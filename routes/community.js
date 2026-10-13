// Community features: feed, communities, posts, votes, unified comments,
// reports, profiles, notifications, search.
//
// module.exports = (app, ctx) => { ... }
// ctx = { db, auth, v, rl, requireAuth, requireAdmin, adminRl, clientIp,
//         isSecureReq, helpers:{escapeHtml,formatBody,fmtDate}, getSetting, audit }
//
// WIRING NOTE (for the parent orchestrator): server.js already defines
//   GET /, GET /u/:username, GET /me, DELETE /api/comments/:id
// and this module registers the spec'd replacements for those paths.
// Express matches routes in registration order, so the old server.js
// handlers MUST be removed/replaced for these to take effect:
//   - remove server.js `app.get('/')`            -> replaced by feed below
//   - remove server.js `app.get('/u/:username')`  -> replaced by profiles below
//   - remove server.js `app.get('/me')`          -> replaced by /me below
//   - remove server.js `DELETE /api/comments/:id` (+ the old chapter-only
//     comment APIs if the unified thread API is meant to fully replace them)
// Also: ctx.getSetting / ctx.audit are not defined in server.js yet; they are
// optional here (safe fallbacks apply) but the parent should supply them.
// Finally: the contract schema (communities, posts, votes, reports,
// notifications, settings; users.avatar/bio/phone; comments.post_id and
// nullable chapter_id) is NOT present in db.js — db.js must be migrated
// (CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN) before these routes
// can run, and the seeded communities (announcements, discussions) plus
// settings keys (site_name, tagline, registrations_open, user_posts_enabled,
// rules_text) must be seeded.

const notify = require('../lib/notify');
const { buildTree, parseMentions, MAX_DEPTH } = require('../lib/comments');
const { isValidAvatar } = require('../lib/avatars');

const FEED_PAGE_SIZE = 20;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const VALID_SORTS = new Set(['latest', 'popular', 'discussed']);

module.exports = (app, ctx) => {
  const db = ctx.db;
  const v = ctx.v;
  const rl = ctx.rl;
  const requireAuth = ctx.requireAuth;
  const helpers = ctx.helpers || {};

  const getSetting = ctx.getSetting || (async (_key, fallback) => fallback);
  const audit = async (action, req, details) => {
    if (typeof ctx.audit === 'function') {
      try { await ctx.audit(action, req, details || {}); }
      catch (e) { console.error('[audit]', e && e.message ? e.message : e); }
    }
  };

  const ok = (res, data) => res.json(Object.assign({ ok: true }, data));
  const fail = (res, status, error) => res.status(status).json({ ok: false, error });

  // Parse a stored timestamp ('YYYY-MM-DD HH:MM:SS' from SQLite, or ISO from
  // Postgres) as UTC milliseconds.
  const toMs = (ts) => {
    try {
      const s = String(ts);
      return new Date(s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z').getTime();
    } catch { return NaN; }
  };
  const withinEditWindow = (createdAt) => {
    const ms = toMs(createdAt);
    return Number.isFinite(ms) && (Date.now() - ms) <= EDIT_WINDOW_MS;
  };
  const excerptOf = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n || 180);
  // Escape LIKE wildcards, mirroring the existing admin user search.
  const likeEscape = (q) => q.replace(/[\\%_]/g, (c) => '\\' + c);

  const postTitle = (val) => v.chapterTitle(val); // 1..200 chars
  const postBody = (val) => {
    if (typeof val !== 'string') return null;
    const s = val.replace(/\r\n?/g, '\n').trim();
    return (s.length >= 1 && s.length <= 10000) ? s : null;
  };
  const reportReason = (val) => {
    if (typeof val !== 'string') return null;
    const s = val.trim().replace(/\s+/g, ' ');
    return (s.length >= 1 && s.length <= 500) ? s : null;
  };
  const bioText = (val) => (typeof val === 'string' ? val.trim().slice(0, 300) : '');

  const pageOf = (req) => {
    const p = Number(req.query.page);
    return Number.isInteger(p) && p >= 1 ? p : 1;
  };
  const sortOf = (req) => (VALID_SORTS.has(req.query.sort) ? req.query.sort : 'latest');

  async function isAdmin(userId) {
    const row = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    return !!row && row.role === 'admin';
  }

  function isUniqueViolation(err) {
    return !!err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === '23505' ||
      /unique/i.test(err.message || ''));
  }

  // ---------- shared lookups ----------

  async function getCommunityBySlug(slug) {
    if (typeof slug !== 'string' || !slug) return null;
    return db.prepare(
      'SELECT id, slug, title, description, allow_posts, created_at FROM communities WHERE slug = ?'
    ).get(slug.slice(0, 64));
  }

  // Server-side canPost: logged in AND (allow_posts=1 ? user_posts_enabled=1
  // : caller is admin). Announcements (allow_posts=0) are admin-only.
  async function canPostIn(userId, community) {
    if (!userId || !community) return false;
    if (Number(community.allow_posts) === 1) {
      return (await getSetting('user_posts_enabled', '1')) === '1';
    }
    return isAdmin(userId);
  }

  async function getVisiblePost(id, viewerId) {
    const row = await db.prepare(`
      SELECT p.id, p.community_id, p.user_id, p.title, p.body, p.status, p.pinned,
             p.created_at, p.updated_at,
             u.username, u.avatar,
             cm.slug AS community_slug, cm.title AS community_title,
             COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='post' AND vv.target_id=p.id),0) AS score,
             (SELECT COUNT(*) FROM comments cc WHERE cc.post_id=p.id AND cc.status='visible') AS comment_count
             ${viewerId ? ", (SELECT value FROM votes WHERE user_id=? AND target_type='post' AND target_id=p.id) AS user_vote" : ', NULL AS user_vote'}
      FROM posts p
      JOIN users u ON u.id = p.user_id
      JOIN communities cm ON cm.id = p.community_id
      WHERE p.id = ? AND p.status = 'visible'`
    ).get(...(viewerId ? [viewerId, id] : [id]));
    if (!row) return null;
    row.score = Number(row.score) || 0;
    row.comment_count = Number(row.comment_count) || 0;
    row.userVote = Number(row.user_vote) || 0;
    return row;
  }

  async function getThread(type, id) {
    // Returns { ok, error } style: { found, threadId } — validates visibility.
    if (type === 'chapter') {
      const ch = await db.prepare('SELECT id, title FROM chapters WHERE id = ? AND published = 1').get(id);
      return ch ? { type, id: ch.id } : null;
    }
    if (type === 'post') {
      const p = await db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'visible'").get(id);
      return p ? { type, id: p.id } : null;
    }
    return null;
  }

  // Depth of a comment (top-level = 1), walking the parent chain. Caps the
  // walk so a corrupt cycle can't loop forever.
  async function commentDepth(commentId) {
    let depth = 1;
    let cur = commentId;
    for (let i = 0; i < MAX_DEPTH + 4; i++) {
      const row = await db.prepare('SELECT parent_id FROM comments WHERE id = ?').get(cur);
      if (!row || !row.parent_id) break;
      depth += 1;
      cur = row.parent_id;
    }
    return depth;
  }

  async function fetchCommentRows(type, threadId, viewerId) {
    const threadCol = type === 'chapter' ? 'c.chapter_id' : 'c.post_id';
    const voteSel = viewerId
      ? "(SELECT value FROM votes WHERE user_id=? AND target_type='comment' AND target_id=c.id)"
      : 'NULL';
    return db.prepare(`
      SELECT c.id, c.parent_id, c.body, c.created_at, c.user_id, u.username, u.avatar,
             COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='comment' AND vv.target_id=c.id),0) AS score,
             ${voteSel} AS userVote
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE ${threadCol} = ? AND c.status = 'visible'
      ORDER BY c.created_at ASC, c.id ASC`
    ).all(...(viewerId ? [viewerId, threadId] : [threadId]));
  }

  function commentContext(c) {
    if (c.chapter_id) {
      return {
        url: `/chapter/${c.chapter_id}`,
        label: c.chapter_number ? `Chapter ${c.chapter_number}: ${c.chapter_title}` : (c.chapter_title || 'Chapter'),
      };
    }
    return { url: `/p/${c.post_id}`, label: c.post_title || 'Post' };
  }

  // ================= FEED =================
  // Replaces the old chapter-only home page. Renders views/home.ejs with the
  // merged chapter+post feed.
  app.get('/', async (req, res) => {
    const sort = sortOf(req);
    const page = pageOf(req);

    const chapters = await db.prepare(`
      SELECT ch.id, ch.number, ch.title, ch.excerpt, ch.created_at,
        COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='chapter' AND vv.target_id=ch.id),0) AS score,
        (SELECT COUNT(*) FROM comments cc WHERE cc.chapter_id=ch.id AND cc.status='visible') AS comment_count
      FROM chapters ch WHERE ch.published = 1`).all();

    const posts = await db.prepare(`
      SELECT p.id, p.user_id, p.title, p.body, p.pinned, p.created_at,
        u.id AS author_id, u.username AS author_name, u.avatar AS author_avatar,
        cm.slug AS community_slug, cm.title AS community_title,
        COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='post' AND vv.target_id=p.id),0) AS score,
        (SELECT COUNT(*) FROM comments cc WHERE cc.post_id=p.id AND cc.status='visible') AS comment_count
      FROM posts p
      JOIN users u ON u.id = p.user_id
      JOIN communities cm ON cm.id = p.community_id
      WHERE p.status = 'visible'`).all();

    const items = [
      ...chapters.map((ch) => ({
        kind: 'chapter',
        id: ch.id,
        number: ch.number,
        title: ch.title,
        excerpt: ch.excerpt,
        author: null, // chapters carry no author in the schema
        community: null,
        score: Number(ch.score) || 0,
        commentCount: Number(ch.comment_count) || 0,
        createdAt: ch.created_at,
        url: `/chapter/${ch.id}`,
        pinned: 0,
      })),
      ...posts.map((p) => ({
        kind: 'post',
        id: p.id,
        title: p.title,
        excerpt: excerptOf(p.body),
        author: { id: p.author_id, username: p.author_name, avatar: p.author_avatar },
        community: { slug: p.community_slug, title: p.community_title },
        score: Number(p.score) || 0,
        commentCount: Number(p.comment_count) || 0,
        createdAt: p.created_at,
        url: `/p/${p.id}`,
        pinned: Number(p.pinned) || 0,
      })),
    ];

    const sorters = {
      // Pinned posts float to the top of the "latest" feed; chapters are
      // never pinned. "popular"/"discussed" ignore pinning.
      latest: (a, b) => (b.pinned - a.pinned) || (toMs(b.createdAt) - toMs(a.createdAt)) || (b.id - a.id),
      popular: (a, b) => (b.score - a.score) || (toMs(b.createdAt) - toMs(a.createdAt)) || (b.id - a.id),
      discussed: (a, b) => (b.commentCount - a.commentCount) || (toMs(b.createdAt) - toMs(a.createdAt)) || (b.id - a.id),
    };
    items.sort(sorters[sort]);

    const totalPages = Math.max(1, Math.ceil(items.length / FEED_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const pageItems = items.slice((safePage - 1) * FEED_PAGE_SIZE, safePage * FEED_PAGE_SIZE);

    const communities = await db.prepare(
      'SELECT id, slug, title, description, allow_posts FROM communities ORDER BY title ASC'
    ).all();

    res.render('home', {
      title: await getSetting('site_name', 'The Gilded Cage'),
      items: pageItems,
      sort,
      page: safePage,
      totalPages,
      communities,
      settings: {
        siteName: await getSetting('site_name', 'The Gilded Cage'),
        tagline: await getSetting('tagline', ''),
      },
    });
  });

  // ================= COMMUNITIES =================
  app.get('/c/:slug', async (req, res) => {
    const community = await getCommunityBySlug(req.params.slug);
    if (!community) return res.status(404).render('404', { title: 'Not found' });
    const sort = sortOf(req);
    const page = pageOf(req);

    const orderBy = sort === 'popular'
      ? 'score DESC'
      : sort === 'discussed'
        ? 'comment_count DESC'
        : 'p.pinned DESC'; // latest: pinned first, then newest

    const rows = await db.prepare(`
      SELECT p.id, p.user_id, p.title, p.body, p.pinned, p.created_at,
        u.username AS author_name, u.avatar AS author_avatar,
        COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='post' AND vv.target_id=p.id),0) AS score,
        (SELECT COUNT(*) FROM comments cc WHERE cc.post_id=p.id AND cc.status='visible') AS comment_count
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.community_id = ? AND p.status = 'visible'
      ORDER BY ${orderBy}, p.created_at DESC, p.id DESC`).all(community.id);

    const totalPages = Math.max(1, Math.ceil(rows.length / FEED_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const posts = rows
      .slice((safePage - 1) * FEED_PAGE_SIZE, safePage * FEED_PAGE_SIZE)
      .map((p) => ({
        kind: 'post',
        id: p.id,
        title: p.title,
        excerpt: excerptOf(p.body),
        author: { id: p.user_id, username: p.author_name, avatar: p.author_avatar },
        community: { slug: community.slug, title: community.title },
        score: Number(p.score) || 0,
        commentCount: Number(p.comment_count) || 0,
        createdAt: p.created_at,
        url: `/p/${p.id}`,
        pinned: Number(p.pinned) || 0,
      }));

    res.render('community', {
      title: community.title,
      community,
      posts,
      sort,
      page: safePage,
      totalPages,
      canPost: await canPostIn(req.user ? req.user.id : null, community),
    });
  });

  // ---------- post creation ----------
  app.post('/api/posts', requireAuth,
    rl.middleware((req) => 'post:' + req.user.id, 10, 3600_000, 'You have created too many posts. Please try again later.'),
    async (req, res) => {
      const communityId = v.intId(req.body.community_id);
      const title = postTitle(req.body.title);
      const body = postBody(req.body.body);
      if (!communityId || !title || !body) {
        return fail(res, 400, 'Title must be 1–200 characters and body 1–10000 characters.');
      }
      const community = await db.prepare(
        'SELECT id, slug, title, allow_posts FROM communities WHERE id = ?'
      ).get(communityId);
      if (!community) return fail(res, 404, 'Community not found.');
      if (!(await canPostIn(req.user.id, community))) {
        return fail(res, 403, 'You cannot post in this community.');
      }
      // Duplicate-spam guard: same user, same title, last 5 minutes.
      // (Idempotency-Key header is intentionally not required; this guard
      // covers double-submits well enough for a community feed.)
      const dup = await db.prepare(
        "SELECT 1 FROM posts WHERE user_id = ? AND title = ? AND created_at > datetime('now','-5 minutes') LIMIT 1"
      ).get(req.user.id, title);
      if (dup) return fail(res, 429, 'You already posted this. Duplicate posts are blocked.');
      const r = await db.prepare(
        "INSERT INTO posts (community_id, user_id, title, body, status, pinned) VALUES (?, ?, ?, ?, 'visible', 0)"
      ).run(communityId, req.user.id, title, body);
      const id = Number(r.lastInsertRowid);
      await audit('post.create', req, { id, communityId });
      return ok(res, { id, url: `/p/${id}` });
    });

  // ================= POST DETAIL / EDIT / DELETE =================
  app.get('/p/:id', async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return res.status(404).render('404', { title: 'Not found' });
    const post = await getVisiblePost(id, req.user ? req.user.id : null);
    if (!post) return res.status(404).render('404', { title: 'Not found' });
    const me = req.user ? req.user.id : null;
    const canEdit = !!me && post.user_id === me && withinEditWindow(post.created_at);
    const canDelete = !!me && post.user_id === me; // admins hide via the admin panel
    const bodyHtml = helpers.formatBody ? helpers.formatBody(post.body) : post.body;
    // views/post.ejs expects camelCase + a nested author object; the DB row
    // is snake_case with a flat username column. Map it here so the page
    // doesn't 500 on `_p.author.username`.
    const viewPost = {
      id: post.id,
      title: post.title,
      body: post.body,
      bodyHtml,
      score: post.score,
      userVote: post.userVote,
      pinned: Number(post.pinned) || 0,
      createdAt: post.created_at,
      commentCount: post.comment_count,
      author: { username: post.username, avatar: post.avatar },
    };
    res.render('post', {
      title: post.title,
      post: viewPost,
      community: { slug: post.community_slug, title: post.community_title },
      canEdit,
      canDelete,
    });
  });

  app.put('/api/posts/:id', requireAuth, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid post.');
    const post = await db.prepare("SELECT id, user_id, created_at FROM posts WHERE id = ? AND status = 'visible'").get(id);
    if (!post) return fail(res, 404, 'Post not found.');
    if (post.user_id !== req.user.id) return fail(res, 403, 'Forbidden.'); // IDOR
    if (!withinEditWindow(post.created_at)) return fail(res, 403, 'Edit window expired.');
    const title = postTitle(req.body.title);
    const body = postBody(req.body.body);
    if (!title || !body) return fail(res, 400, 'Title must be 1–200 characters and body 1–10000 characters.');
    await db.prepare("UPDATE posts SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, body, id);
    await audit('post.edit', req, { id });
    return ok(res, {});
  });

  app.delete('/api/posts/:id', requireAuth, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid post.');
    const post = await db.prepare("SELECT id, user_id FROM posts WHERE id = ? AND status = 'visible'").get(id);
    if (!post) return fail(res, 404, 'Post not found.');
    if (post.user_id !== req.user.id) return fail(res, 403, 'Forbidden.'); // IDOR; admins hide via panel
    await db.prepare('DELETE FROM posts WHERE id = ?').run(id);
    await audit('post.delete', req, { id });
    return ok(res, {});
  });

  // ================= VOTES =================
  const voteScore = async (targetType, targetId) => {
    const row = await db.prepare(
      'SELECT COALESCE(SUM(value),0) s FROM votes WHERE target_type = ? AND target_id = ?'
    ).get(targetType, targetId);
    return Number(row.s) || 0;
  };

  app.post('/api/vote', requireAuth,
    rl.middleware((req) => 'vote:' + req.user.id, 60, 60_000, 'You are voting too fast. Please wait a moment.'),
    async (req, res) => {
      const targetType = req.body.target_type;
      const targetId = v.intId(req.body.target_id);
      const value = Number(req.body.value);
      if (!['post', 'chapter', 'comment'].includes(targetType) || !targetId || (value !== 1 && value !== -1)) {
        return fail(res, 400, 'Invalid vote.');
      }
      // Target must exist and be visible to the voter.
      let exists = false;
      if (targetType === 'post') {
        exists = !!(await db.prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'visible'").get(targetId));
      } else if (targetType === 'chapter') {
        exists = !!(await db.prepare('SELECT 1 FROM chapters WHERE id = ? AND published = 1').get(targetId));
      } else {
        const c = await db.prepare(`
          SELECT c.id FROM comments c
          LEFT JOIN posts p ON p.id = c.post_id
          LEFT JOIN chapters ch ON ch.id = c.chapter_id
          WHERE c.id = ? AND c.status = 'visible'
            AND (c.post_id IS NULL OR p.status = 'visible')
            AND (c.chapter_id IS NULL OR ch.published = 1)`).get(targetId);
        exists = !!c;
      }
      if (!exists) return fail(res, 404, 'Target not found.');

      const me = req.user.id;
      const apply = async () => {
        const cur = await db.prepare(
          'SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?'
        ).get(me, targetType, targetId);
        if (cur && Number(cur.value) === value) {
          // Toggle off: same value -> unvote.
          await db.prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
            .run(me, targetType, targetId);
        } else if (cur) {
          await db.prepare('UPDATE votes SET value = ? WHERE user_id = ? AND target_type = ? AND target_id = ?')
            .run(value, me, targetType, targetId);
        } else {
          try {
            await db.prepare('INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?,?,?,?)')
              .run(me, targetType, targetId, value);
          } catch (e) {
            if (isUniqueViolation(e)) return apply(); // lost a race; refetch state
            throw e;
          }
        }
      };
      try { await apply(); }
      catch (e) { console.error('[vote]', e.message); return fail(res, 500, 'Something went wrong. Please try again.'); }

      const after = await db.prepare(
        'SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?'
      ).get(me, targetType, targetId);
      return ok(res, { score: await voteScore(targetType, targetId), userVote: after ? Number(after.value) : 0 });
    });

  // ================= UNIFIED COMMENTS =================
  app.get('/api/thread/:type/:id/comments', async (req, res) => {
    const type = req.params.type;
    const id = v.intId(req.params.id);
    if ((type !== 'chapter' && type !== 'post') || !id) return fail(res, 400, 'Invalid thread.');
    const thread = await getThread(type, id);
    if (!thread) return fail(res, 404, 'Thread not found.');
    const rows = await fetchCommentRows(type, id, req.user ? req.user.id : null);
    return ok(res, { comments: buildTree(rows) });
  });

  app.post('/api/thread/:type/:id/comments', requireAuth,
    rl.middleware((req) => 'cmt:' + req.user.id, 15, 60_000, 'You are commenting too fast. Please wait a moment.'),
    async (req, res) => {
      const type = req.params.type;
      const id = v.intId(req.params.id);
      if ((type !== 'chapter' && type !== 'post') || !id) return fail(res, 400, 'Invalid thread.');
      const thread = await getThread(type, id);
      if (!thread) return fail(res, 404, 'Thread not found.');
      const parentId = req.body.parent_id == null || req.body.parent_id === '' ? null : v.intId(req.body.parent_id);
      const body = v.commentBody(req.body.body);
      if (!body) return fail(res, 400, 'Comment must be 1–2000 characters.');
      if (req.body.parent_id != null && req.body.parent_id !== '' && !parentId) {
        return fail(res, 400, 'Invalid reply target.');
      }

      let parent = null;
      if (parentId) {
        parent = await db.prepare('SELECT id, user_id, chapter_id, post_id, status FROM comments WHERE id = ?').get(parentId);
        const threadCol = type === 'chapter' ? 'chapter_id' : 'post_id';
        if (!parent || parent.status !== 'visible' || Number(parent[threadCol]) !== id) {
          return fail(res, 400, 'Invalid reply target.');
        }
        if (await commentDepth(parentId) >= MAX_DEPTH) {
          return fail(res, 400, 'Maximum reply depth reached.');
        }
      }

      // Duplicate-spam guard: same user, same text, last 5 minutes.
      const dup = await db.prepare(
        "SELECT 1 FROM comments WHERE user_id = ? AND body = ? AND created_at > datetime('now','-5 minutes') LIMIT 1"
      ).get(req.user.id, body);
      if (dup) return fail(res, 429, 'You already posted this. Duplicate comments are blocked.');

      const threadCol = type === 'chapter' ? 'chapter_id' : 'post_id';
      const r = await db.prepare(
        `INSERT INTO comments (${threadCol}, user_id, parent_id, body, status) VALUES (?, ?, ?, ?, 'visible')`
      ).run(id, req.user.id, parentId, body);
      const commentId = Number(r.lastInsertRowid);

      // Notifications: reply to the parent author; mentions for @usernames.
      // Never notify the actor about their own action (handled in notify.js).
      try {
        if (parent && parent.user_id !== req.user.id) {
          await notify.createNotification({
            userId: parent.user_id, type: 'reply', actorId: req.user.id,
            targetType: 'comment', targetId: commentId, excerpt: body,
          });
        }
        const mentions = parseMentions(body);
        if (mentions.length) {
          const found = await db.prepare(
            `SELECT id, username FROM users WHERE username IN (${mentions.map(() => '?').join(',')})`
          ).all(...mentions);
          const seenIds = new Set();
          for (const u of found) {
            if (u.id === req.user.id) continue; // never self-notify
            if (parent && u.id === parent.user_id) continue; // already got a reply notification
            if (seenIds.has(u.id)) continue;
            seenIds.add(u.id);
            await notify.createNotification({
              userId: u.id, type: 'mention', actorId: req.user.id,
              targetType: 'comment', targetId: commentId, excerpt: body,
            });
          }
        }
      } catch (e) { console.error('[notify]', e.message); }

      await audit('comment.create', req, { id: commentId, threadType: type, threadId: id });
      return ok(res, { id: commentId });
    });

  app.put('/api/comments/:id', requireAuth, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid comment.');
    const c = await db.prepare('SELECT id, user_id, created_at FROM comments WHERE id = ?').get(id);
    if (!c) return fail(res, 404, 'Comment not found.');
    if (c.user_id !== req.user.id) return fail(res, 403, 'Forbidden.'); // IDOR
    if (!withinEditWindow(c.created_at)) return fail(res, 403, 'Edit window expired.');
    const body = v.commentBody(req.body.body);
    if (!body) return fail(res, 400, 'Comment must be 1–2000 characters.');
    await db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(body, id);
    await audit('comment.edit', req, { id });
    return ok(res, {});
  });

  app.delete('/api/comments/:id', requireAuth, async (req, res) => {
    const id = v.intId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid comment.');
    const c = await db.prepare('SELECT id, user_id FROM comments WHERE id = ?').get(id);
    if (!c) return fail(res, 404, 'Comment not found.');
    // IDOR: only the author or an admin may delete. Hard delete, consistent
    // with the existing chapter-comment behavior (replies cascade).
    if (c.user_id !== req.user.id && !(await isAdmin(req.user.id))) return fail(res, 403, 'Forbidden.');
    await db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    await audit('comment.delete', req, { id });
    return ok(res, {});
  });

  // ================= REPORTS =================
  app.post('/api/reports', requireAuth,
    rl.middleware((req) => 'rep:' + req.user.id, 10, 3600_000, 'You have submitted too many reports. Please try again later.'),
    async (req, res) => {
      const targetType = req.body.target_type;
      const targetId = v.intId(req.body.target_id);
      const reason = reportReason(req.body.reason);
      if ((targetType !== 'post' && targetType !== 'comment') || !targetId || !reason) {
        return fail(res, 400, 'Reason must be 1–500 characters.');
      }
      const target = targetType === 'post'
        ? await db.prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'visible'").get(targetId)
        : await db.prepare("SELECT 1 FROM comments WHERE id = ? AND status = 'visible'").get(targetId);
      if (!target) return fail(res, 404, 'Target not found.');
      const open = await db.prepare(
        "SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open' LIMIT 1"
      ).get(req.user.id, targetType, targetId);
      if (open) return fail(res, 409, 'You have already reported this.');
      await db.prepare(
        "INSERT INTO reports (reporter_id, target_type, target_id, reason, status) VALUES (?, ?, ?, ?, 'open')"
      ).run(req.user.id, targetType, targetId, reason);
      await audit('report.create', req, { targetType, targetId });
      return ok(res, {});
    });

  // ================= PROFILES =================
  // Replaces the old comment-only public profile. Renders views/user.ejs.
  app.get('/u/:username', async (req, res) => {
    const name = v.username(req.params.username);
    if (!name) return res.status(404).render('404', { title: 'Not found' });
    // Public columns only: never phone, never password_hash.
    const u = await db.prepare(
      'SELECT id, username, avatar, bio, created_at FROM users WHERE username = ?'
    ).get(name);
    if (!u) return res.status(404).render('404', { title: 'User not found' });

    const posts = await db.prepare(`
      SELECT p.id, p.title, p.created_at, cm.slug AS community_slug, cm.title AS community_title,
        COALESCE((SELECT SUM(vv.value) FROM votes vv WHERE vv.target_type='post' AND vv.target_id=p.id),0) AS score,
        (SELECT COUNT(*) FROM comments cc WHERE cc.post_id=p.id AND cc.status='visible') AS comment_count
      FROM posts p JOIN communities cm ON cm.id = p.community_id
      WHERE p.user_id = ? AND p.status = 'visible'
      ORDER BY p.created_at DESC LIMIT 10`).all(u.id);

    const commentRows = await db.prepare(`
      SELECT c.id, c.body, c.created_at, c.chapter_id, c.post_id,
             ch.number AS chapter_number, ch.title AS chapter_title,
             p.title AS post_title
      FROM comments c
      LEFT JOIN chapters ch ON ch.id = c.chapter_id
      LEFT JOIN posts p ON p.id = c.post_id
      WHERE c.user_id = ? AND c.status = 'visible'
      ORDER BY c.created_at DESC LIMIT 10`).all(u.id);
    const comments = commentRows.map((c) => Object.assign({}, c, { context: commentContext(c) }));

    // NOTE: await must wrap the .get() call before reading a column —
    // `await ...get(x).c` would read `.c` off the Promise (always undefined).
    const postCountRow = await db.prepare("SELECT COUNT(*) c FROM posts WHERE user_id = ? AND status = 'visible'").get(u.id);
    const commentCountRow = await db.prepare("SELECT COUNT(*) c FROM comments WHERE user_id = ? AND status = 'visible'").get(u.id);
    const postCount = postCountRow ? Number(postCountRow.c) : 0;
    const commentCount = commentCountRow ? Number(commentCountRow.c) : 0;
    const karmaRow = await db.prepare(`
      SELECT
        COALESCE((SELECT SUM(vv.value) FROM votes vv JOIN posts p ON p.id = vv.target_id
                  WHERE vv.target_type = 'post' AND p.user_id = ?), 0) +
        COALESCE((SELECT SUM(vv.value) FROM votes vv JOIN comments cc ON cc.id = vv.target_id
                  WHERE vv.target_type = 'comment' AND cc.user_id = ?), 0) AS karma`
    ).get(u.id, u.id);

    res.render('user', {
      title: u.username,
      profile: u,
      posts,
      comments,
      stats: { postCount, commentCount, karma: Number(karmaRow.karma) || 0 },
    });
  });

  // ---------- own profile ----------
  // Replaces the old chapter-only /me. Renders views/profile.ejs.
  app.get('/me', requireAuth, async (req, res) => {
    const me = await db.prepare(
      'SELECT id, username, avatar, bio, role, created_at FROM users WHERE id = ?'
    ).get(req.user.id);
    const commentRows = await db.prepare(`
      SELECT c.id, c.body, c.created_at, c.chapter_id, c.post_id,
             ch.number AS chapter_number, ch.title AS chapter_title,
             p.title AS post_title
      FROM comments c
      LEFT JOIN chapters ch ON ch.id = c.chapter_id
      LEFT JOIN posts p ON p.id = c.post_id
      WHERE c.user_id = ? AND c.status = 'visible'
      ORDER BY c.created_at DESC LIMIT 10`).all(req.user.id);
    const comments = commentRows.map((c) => Object.assign({}, c, { context: commentContext(c) }));
    res.render('profile', { title: 'My profile', me, comments, error: null, okMsg: req.query.ok || null });
  });

  app.post('/me/profile', requireAuth, async (req, res) => {
    const avatar = typeof req.body.avatar === 'string' ? req.body.avatar.trim() : '';
    const bio = bioText(req.body.bio);
    if (avatar && !isValidAvatar(avatar)) {
      return res.status(400).render('profile', {
        title: 'My profile',
        me: await db.prepare('SELECT id, username, avatar, bio, role, created_at FROM users WHERE id = ?').get(req.user.id),
        comments: [],
        error: 'Invalid avatar choice.',
        okMsg: null,
      });
    }
    await db.prepare('UPDATE users SET avatar = ?, bio = ? WHERE id = ?')
      .run(avatar || null, bio, req.user.id);
    await audit('profile.update', req, {});
    res.redirect('/me?ok=1');
  });

  // ================= NOTIFICATIONS =================
  app.get('/notifications', requireAuth, async (req, res) => {
    const rows = await db.prepare(`
      SELECT n.id, n.type, n.actor_id, n.target_type, n.target_id, n.excerpt, n.is_read, n.created_at,
             u.username AS actor_username
      FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC LIMIT 50`).all(req.user.id);
    // views/notifications.ejs expects camelCase (actorUsername, targetType,
    // targetId, isRead, createdAt); the query returns snake_case. Map it here
    // so the inbox doesn't render "@undefined" with dead links.
    const notifications = rows.map((n) => ({
      id: n.id,
      type: n.type,
      actorUsername: n.actor_username,
      targetType: n.target_type,
      targetId: n.target_id,
      excerpt: n.excerpt,
      isRead: Number(n.is_read) === 1,
      createdAt: n.created_at,
    }));
    res.render('notifications', {
      title: 'Notifications',
      notifications,
      unreadCount: await notify.getUnreadCount(req.user.id),
    });
  });

  app.post('/api/notifications/read', requireAuth, async (req, res) => {
    if (req.body && req.body.all === true) {
      await notify.markAllRead(req.user.id);
      return ok(res, {});
    }
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map(v.intId).filter(Boolean).slice(0, 200)
      : [];
    if (!ids.length) return fail(res, 400, 'Provide ids or all:true.');
    // Only the owner's own notifications are marked (IDOR-safe).
    await db.prepare(
      `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    ).run(req.user.id, ...ids);
    return ok(res, {});
  });

  // ================= SEARCH =================
  app.get('/search', async (req, res) => {
    const q = v.searchQuery(req.query.q);
    let posts = [], chapters = [], users = [];
    if (q) {
      const pat = q; // wildcards escaped below, wrapped by the query itself
      const esc = likeEscape(pat);
      const postRows = await db.prepare(`
        SELECT p.id, p.title, p.body, p.created_at, cm.slug AS community_slug, cm.title AS community_title,
               u.username AS author_name
        FROM posts p
        JOIN users u ON u.id = p.user_id
        JOIN communities cm ON cm.id = p.community_id
        WHERE p.status = 'visible' AND (p.title LIKE '%' || ? || '%' ESCAPE '\\' OR p.body LIKE '%' || ? || '%' ESCAPE '\\')
        ORDER BY p.created_at DESC LIMIT 20`).all(esc, esc);
      posts = postRows.map((p) => ({
        id: p.id, title: p.title, excerpt: excerptOf(p.body),
        author_name: p.author_name, community_slug: p.community_slug,
        community_title: p.community_title, created_at: p.created_at, url: `/p/${p.id}`,
      }));
      chapters = await db.prepare(`
        SELECT id, number, title, excerpt, created_at FROM chapters
        WHERE published = 1 AND (title LIKE '%' || ? || '%' ESCAPE '\\' OR body LIKE '%' || ? || '%' ESCAPE '\\')
        ORDER BY number ASC LIMIT 20`).all(esc, esc);
      const userRows = await db.prepare(`
        SELECT id, username, avatar, created_at FROM users
        WHERE username LIKE '%' || ? || '%' ESCAPE '\\'
        ORDER BY username ASC LIMIT 20`).all(esc);
      users = userRows; // public columns only
    }
    res.render('search', { title: q ? `Search: ${q}` : 'Search', q, posts, chapters, users });
  });
};
