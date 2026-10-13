// Server-side input validation. Never trust the client.
const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;

function username(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return USERNAME_RE.test(s) ? s : null;
}

function password(v) {
  if (typeof v !== 'string') return null;
  if (v.length < 8 || v.length > 128) return null;
  return v;
}

function commentBody(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 2000) return null;
  return s;
}

function chapterTitle(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 200) return null;
  return s;
}

function chapterBody(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (s.length < 1 || s.length > 200000) return null;
  return s;
}

function chapterNumber(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100000) return null;
  return n;
}

function intId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function searchQuery(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 64);
}

module.exports = { username, password, commentBody, chapterTitle, chapterBody, chapterNumber, intId, searchQuery };
