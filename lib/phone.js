// Phone number validation / normalization.
// Canonical form is E.164-ish: '+' followed by 7–15 digits, e.g. +923001234567.
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Strip the characters users commonly type around a number (spaces, dashes,
// dots, parentheses) after trimming. Returns the cleaned string or null.
function normalizePhone(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/[\s\-().]/g, '');
  return cleaned === '' ? null : cleaned;
}

// validatePhone(v): returns the E.164-ish string, or null when invalid.
// Invalid input never throws — callers render a friendly message.
function validatePhone(v) {
  const cleaned = normalizePhone(v);
  if (!cleaned) return null;
  return E164_RE.test(cleaned) ? cleaned : null;
}

module.exports = { validatePhone, normalizePhone };
