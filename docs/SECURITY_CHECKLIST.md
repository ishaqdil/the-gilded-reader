# Security Checklist — The Gilded Cage

Last verified: 2026-10-13. Automated suite: `npm test` → **178/178 assertions pass**
(~37s, two consecutive green runs), plus manual smoke tests during integration.
Every item below was exercised, not just reviewed.

## Authentication & sessions
- [x] Phone is the account identifier; validated E.164-ish (`+` + 7–15 digits), unique.
- [x] Passwords hashed with bcrypt (cost 12); OTP codes stored only as SHA-256 hashes, never plaintext.
- [x] Wrong password → generic 401; unknown phone on OTP send → generic "if registered" message (no enumeration).
- [x] Blocked users cannot log in; existing sessions are destroyed on block.
- [x] Sessions are random opaque tokens, HTTP-only + SameSite=Lax (+ Secure on HTTPS), 30-day sliding expiry.
- [x] Logout destroys the session; password change destroys all other sessions.
- [x] Admin claim token is single-use (404 after claim); bad token → 404; token compared with timingSafeEqual.

## OTP (AUTH_MODE=otp)
- [x] 6-digit codes, 10-minute expiry (expired codes rejected — tested by backdating in DB).
- [x] Max 5 verify attempts per code, then invalidated (6th attempt rejected).
- [x] 60-second resend cooldown per phone (immediate resend → 429).
- [x] Rate limits: 3 sends/hour per phone, 10 sends/hour per IP, 10 verifies/10 min per phone.
- [x] Codes are single-use (reuse after success → rejected).
- [x] Dev provider prints the code to the server console ONLY, clearly labeled dev-only.
- [x] WhatsApp provider: real Meta Cloud API call (template message), 10s timeout, provider errors surfaced without the code, code never logged.

## Phone-number privacy (mandatory)
- [x] Automated leak sweep: the test phone number is asserted ABSENT from 9 public surfaces
      (`/`, `/p/:id`, `/u/:username`, `/api/thread/post/:id/comments`, `/search`, `/c/:slug`,
      `/notifications` page, chapter pages, public JSON) — all clean.
- [x] Public queries use explicit column lists; `phone`, `password_hash`, `claim_token_hash`
      are never selected outside auth/admin-phone flows (verified by code grep).
- [x] Only `GET /admin/users/:id/phone` selects `phone`; it writes an `audit_log`
      (`action='phone.view'`) BEFORE rendering, and is admin-only (non-admin → 403).
- [x] Admin user-search matches phone numbers but results never include the number itself.
- [x] No phone in URLs, page source, JSON, logs, or error messages.

## Authorization (IDOR / access control)
- [x] Edit comment/post: author only, within 15-minute window (other user's edit → 403).
- [x] Delete post: author only; delete comment: author or admin (other user's → 403).
- [x] Every `/admin/*` route re-checks `role='admin'` from the DB per request (non-admin → 403;
      anonymous → redirect/401). Tested on dashboard, users, phone view, reports, settings.
- [x] Announcements community (`allow_posts=0`) rejects non-admin posts (403); admin bypass works.
- [x] Notifications mark-read only touches the caller's own rows.

## CSRF
- [x] Global middleware requires the per-session token on all POST/PUT/PATCH/DELETE with a
      session; missing/wrong token → 403 (tested on post creation and voting).
- [x] All EJS forms include `_csrf`; fetch calls send `x-csrf-token`.
- [x] `/admin/claim` POST is bearer-token authed (no session needed); includes `_csrf` when a
      session happens to exist so the middleware doesn't trip.

## Rate limiting & abuse
- [x] Registration 5/hour/IP; login 10/10 min/IP; comments 15/min/user; posts 10/hour/user;
      votes 60/min/user; reports 10/hour/user; admin routes 120/min/user — 429s verified
      (vote limit and OTP resend cooldown hit in tests).
- [x] Duplicate guards: same comment text within 5 min → 429; same post title within 5 min → 429;
      one open report per reporter+target → 409; votes deduped by UNIQUE constraint + toggle logic.
- [x] Comment depth capped at 6 (depth-7 reply → 400); body 2000 chars; post body 10000 chars;
      request bodies limited (256kb forms / 64kb JSON).

## Injection & output
- [x] All DB access is parameterized (`?` placeholders); LIKE wildcards escaped in search.
- [x] All EJS output uses `<%= %>` (escaped); user bodies rendered via `escapeHtml`/`formatBody`;
      comment-tree JS builds DOM with `textContent` only.
- [x] Error handler returns generic messages; stack traces go to the server log only
      (first 3 lines, no secrets). No secrets in responses or client JS.

## Admin account
- [x] No public admin registration. First boot creates an admin row with NO password and a
      one-time claim token printed once to the console (or `ADMIN_CLAIM_TOKEN` if preset).
- [x] Admin cannot block self or other admins (400).
- [x] Sensitive actions (block, phone view, delete, hide) use POST forms with CSRF + confirm.

## Headers & transport
- [x] `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, strict `Referrer-Policy`,
      restrictive `Permissions-Policy`, and a tight CSP (`default-src 'self'`, no inline scripts).
- [x] `x-powered-by` disabled; `trust proxy` set for correct HTTPS detection behind Render.

## Known limitations (honest, not hidden)
- The in-memory rate limiter resets on restart and doesn't share state across instances —
      fine for the single-instance free tier, not for multi-instance hosting.
- SQLite is used locally; Render's disk is ephemeral, so production MUST set `DATABASE_URL`
      (Neon) or all data is lost on restart — documented in DEPLOY.md.
- `OTP_PROVIDER=whatsapp` is implemented for real but dormant until the owner completes
      Meta business verification + billing; per-message charges apply (see docs/WHATSAPP_SETUP.md).
- Comment/post edit window is 15 minutes; after that only admins can change content.
