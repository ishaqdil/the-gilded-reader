// Dual-mode database layer.
// - Default: SQLite file in ./data (zero-config local use).
// - When DATABASE_URL is set: PostgreSQL (e.g. Neon free tier) for hosted deploys.
// Same interface in both modes: db.prepare(sql) -> { run, get, all } (all async).
// Call sites use SQLite-style SQL ('?' placeholders, datetime('now')); the
// Postgres adapter translates the few dialect differences.
//
// Schema notes (2026-10-13):
// - users: phone login support (phone unique, phone_verified flag), avatar, bio,
//   claim_token_hash. password_hash is NULLABLE (phone/OTP-only accounts have no
//   password). No pre-existing databases exist in the wild (data/ did not exist
//   at migration time), so the nullability is set in the fresh CREATE TABLE and
//   no migration of an old NOT NULL constraint is attempted (SQLite cannot
//   relax NOT NULL via ALTER TABLE anyway).
// - comments: a comment belongs to a chapter OR a community post. App-level
//   rule: exactly one of chapter_id/post_id is set (enforced in app code, not a
//   CHECK constraint, because SQLite cannot add CHECK constraints to an
//   existing table and the old comments table is rebuilt in place on upgrade).
// - phone uniqueness: enforced with CREATE UNIQUE INDEX idx_users_phone, not an
//   inline UNIQUE column constraint, because SQLite forbids UNIQUE in
//   ALTER TABLE ... ADD COLUMN; one mechanism serves fresh and upgraded DBs.
const path = require('path');
const fs = require('fs');

const USE_PG = !!process.env.DATABASE_URL;

// Raw handles for the shared addColumnIfMissing() helper below. Table/column
// names passed to it are hardcoded constants at the call sites (never user
// input), so string interpolation there is safe.
let sqliteDb = null;
let pgPool = null;

// Idempotent column upgrade: runs on every init() so repeated boots are safe
// and existing rows are preserved.
// - sqlite: inspect PRAGMA table_info, ALTER TABLE only when the column is
//   missing (SQLite cannot add UNIQUE/CHECK/PRIMARY KEY via ADD COLUMN).
// - postgres: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
async function addColumnIfMissing(dialect, table, column, ddl) {
  if (dialect === 'sqlite') {
    if (!sqliteDb) throw new Error('addColumnIfMissing: sqlite backend not initialized');
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) return;
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } else {
    if (!pgPool) throw new Error('addColumnIfMissing: postgres backend not initialized');
    await pgPool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${ddl}`);
  }
}

// Seed settings + default communities. INSERT ... ON CONFLICT DO NOTHING keeps
// it idempotent and never overwrites values an admin may have changed. The
// explicit RETURNING clause stops the pg prepare() wrapper from appending its
// own "RETURNING id" (settings has no id column).
async function seedCore(prepare) {
  const insSetting = prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT (key) DO NOTHING RETURNING key'
  );
  const settings = [
    ['site_name', 'The Gilded Cage'],
    ['tagline', 'A reader community for the novel'],
    ['registrations_open', '1'],
    ['user_posts_enabled', '1'],
    ['rules_text', 'Be kind. No spam. No spoilers without warning.'],
  ];
  for (const [k, v] of settings) await insSetting.run(k, v);

  const insCommunity = prepare(
    'INSERT INTO communities (slug, title, description, allow_posts) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT (slug) DO NOTHING RETURNING slug'
  );
  await insCommunity.run('announcements', 'Announcements', 'Official updates from the site owner.', 0);
  await insCommunity.run('discussions', 'Discussions', 'Talk about the novel, chapters and theories.', 1);
}

// ---------- SQLite backend ----------
function sqliteBackend() {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'chapters.db');
  const db = new DatabaseSync(dbFile);
  sqliteDb = db;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // Final comments shape (chapter_id nullable, post_id added). Used both for
  // fresh CREATE TABLE and for the old-shape rebuild below.
  const COMMENTS_DDL = `CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NULL REFERENCES chapters(id) ON DELETE CASCADE,
  post_id INTEGER NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

  function prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      run: async (...p) => stmt.run(...p),
      get: async (...p) => stmt.get(...p),
      all: async (...p) => stmt.all(...p),
    };
  }

  async function init() {
    // Core + community tables. Fresh installs get the final shape directly;
    // CREATE TABLE IF NOT EXISTS leaves pre-existing tables untouched (their
    // new columns arrive via addColumnIfMissing below).
    db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT NOT NULL DEFAULT 'lantern',
  bio TEXT NOT NULL DEFAULT '',
  claim_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  allow_posts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','chapter','comment')),
  target_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1,-1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('reply','mention')),
  actor_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NULL,
  target_id INTEGER NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

    // comments: detect the old shape (chapter_id NOT NULL, no post_id) and
    // rebuild it so chapter_id can be NULL for post comments. Old rows are
    // preserved; only runs when the old shape is detected.
    const commentsExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments'"
    ).get();
    if (commentsExists) {
      const cols = db.prepare('PRAGMA table_info(comments)').all();
      const chapterCol = cols.find((c) => c.name === 'chapter_id');
      const hasPostId = cols.some((c) => c.name === 'post_id');
      if (chapterCol && chapterCol.notnull === 1 && !hasPostId) {
        // Back up the DB file before the destructive step.
        const stamp = new Date().toISOString().replace(/T/, '-').replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(dbFile, `${dbFile}.bak-${stamp}`);
        db.exec('PRAGMA foreign_keys = OFF;');
        db.exec(`
BEGIN;
CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NULL REFERENCES chapters(id) ON DELETE CASCADE,
  post_id INTEGER NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER NULL REFERENCES comments_new(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO comments_new (id, chapter_id, user_id, parent_id, body, status, created_at)
  SELECT id, chapter_id, user_id, parent_id, body, status, created_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
COMMIT;`);
        db.exec('PRAGMA foreign_keys = ON;');
      }
    } else {
      db.exec(COMMENTS_DDL);
    }

    // Idempotent column upgrades for installs that predate each column.
    await addColumnIfMissing('sqlite', 'users', 'phone', 'TEXT');
    await addColumnIfMissing('sqlite', 'users', 'phone_verified', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('sqlite', 'users', 'avatar', "TEXT DEFAULT 'lantern'");
    await addColumnIfMissing('sqlite', 'users', 'bio', "TEXT DEFAULT ''");
    await addColumnIfMissing('sqlite', 'users', 'claim_token_hash', 'TEXT');
    await addColumnIfMissing('sqlite', 'comments', 'post_id', 'INTEGER REFERENCES posts(id) ON DELETE CASCADE');

    db.exec(`
CREATE INDEX IF NOT EXISTS idx_comments_chapter ON comments(chapter_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

    await seedCore(prepare);
  }

  return { init, prepare };
}

// ---------- Postgres backend ----------
function pgBackend() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pgPool = pool;
  pool.on('error', (e) => console.error('[db] pool error:', e.message));

  // Translate the small SQLite-isms used by call sites.
  function translate(sql) {
    let i = 0;
    let out = sql.replace(/\?/g, () => '$' + (++i));
    // datetime('now','-N unit') -> NOW() - INTERVAL 'N unit' (any unit/amount)
    out = out.replace(
      /datetime\('now','(-\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))'\)/gi,
      "NOW() - INTERVAL '$1'"
    );
    out = out.replace(/datetime\('now'\)/g, 'NOW()');
    return out;
  }
  // pg returns Date objects for timestamptz and strings for int8 (COUNT(*));
  // normalize both so the rest of the app (written against SQLite text
  // timestamps / numeric counts) keeps working. Integer-like strings are only
  // coerced for count-style keys ('c', '*_count', 'score') to avoid mangling
  // e.g. phone numbers stored as text.
  function norm(row) {
    if (!row) return row;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v instanceof Date) {
        row[k] = v.toISOString();
      } else if (
        typeof v === 'string' &&
        /^-?\d+$/.test(v) &&
        (k === 'c' || k === 'score' || k.endsWith('_count'))
      ) {
        row[k] = Number(v);
      }
    }
    return row;
  }

  function prepare(sql) {
    const q = translate(sql);
    const isInsert = /^\s*insert\s/i.test(q) && !/returning\s/i.test(q);
    const finalQ = isInsert ? q + ' RETURNING id' : q;
    return {
      run: async (...p) => {
        const r = await pool.query(finalQ, p);
        const idv = r.rows[0] ? r.rows[0].id : undefined;
        return { lastInsertRowid: idv == null ? 0 : Number(idv) };
      },
      get: async (...p) => norm((await pool.query(q, p)).rows[0]) || undefined,
      all: async (...p) => (await pool.query(q, p)).rows.map(norm),
    };
  }

  async function init() {
    await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT NOT NULL DEFAULT 'lantern',
  bio TEXT NOT NULL DEFAULT '',
  claim_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chapters (
  id SERIAL PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  chapter_id INTEGER NULL REFERENCES chapters(id) ON DELETE CASCADE,
  post_id INTEGER NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS communities (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  allow_posts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','chapter','comment')),
  target_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1,-1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('reply','mention')),
  actor_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NULL,
  target_id INTEGER NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Upgrades for pre-existing installs: post comments need post_id and a
-- nullable chapter_id (fresh CREATE TABLE above already has both).
ALTER TABLE comments ADD COLUMN IF NOT EXISTS post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE comments ALTER COLUMN chapter_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_chapter ON comments(chapter_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

    // Idempotent column upgrades for installs that predate each column.
    await addColumnIfMissing('postgres', 'users', 'phone', 'TEXT');
    await addColumnIfMissing('postgres', 'users', 'phone_verified', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('postgres', 'users', 'avatar', "TEXT DEFAULT 'lantern'");
    await addColumnIfMissing('postgres', 'users', 'bio', "TEXT DEFAULT ''");
    await addColumnIfMissing('postgres', 'users', 'claim_token_hash', 'TEXT');

    await seedCore(prepare);
  }

  return { init, prepare };
}

const backend = USE_PG ? pgBackend() : sqliteBackend();

module.exports = {
  prepare: (sql) => backend.prepare(sql),
  init: () => backend.init(),
  dialect: USE_PG ? 'postgres' : 'sqlite',
};
