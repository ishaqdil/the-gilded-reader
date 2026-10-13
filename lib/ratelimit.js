// Tiny in-memory sliding-window rate limiter. No dependencies.
// key -> array of timestamps (ms). Old entries are pruned on each hit.
const buckets = new Map();

function hit(key, limit, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) {
    return { allowed: false, retryAfterMs: arr[0] + windowMs - now };
  }
  arr.push(now);
  return { allowed: true };
}

// Periodic cleanup so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= now - 3600_000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 5 * 60_000).unref();

function middleware(keyFn, limit, windowMs, message) {
  return (req, res, next) => {
    const r = hit(keyFn(req), limit, windowMs);
    if (!r.allowed) {
      res.set('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      return res.status(429).json({ ok: false, error: message || 'Too many requests. Please slow down.' });
    }
    next();
  };
}

module.exports = { hit, middleware };
