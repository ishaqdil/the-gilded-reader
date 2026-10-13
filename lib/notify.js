// Notification helpers.
// notifications(user_id, type 'reply'|'mention', actor_id, target_type, target_id,
//              excerpt, is_read, created_at)
const db = require('../db');

const VALID_TYPES = new Set(['reply', 'mention']);

// Never notify a user about their own action.
async function createNotification({ userId, type, actorId, targetType, targetId, excerpt }) {
  if (!userId || !actorId || userId === actorId) return null;
  if (!VALID_TYPES.has(type)) return null;
  const ex = typeof excerpt === 'string' ? excerpt.slice(0, 140) : '';
  const r = await db.prepare(
    'INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, excerpt, is_read) VALUES (?,?,?,?,?,?,0)'
  ).run(userId, type, actorId, String(targetType), Number(targetId), ex);
  return Number(r.lastInsertRowid);
}

async function getUnreadCount(userId) {
  const row = await db.prepare(
    'SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(userId);
  return row ? Number(row.c) : 0;
}

async function markAllRead(userId) {
  await db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0'
  ).run(userId);
}

module.exports = { createNotification, getUnreadCount, markAllRead };
