# The Gilded Cage

A Reddit-style reading community for the novel *The Gilded Cage*. Readers log
in with their phone number, read chapters chapter-by-chapter, and join
community spaces to post, comment and vote — like a small forum built around
the book. Ishaq (the admin) publishes chapters and moderates everything from
an admin dashboard.

## Features

**Reading**

- Chapter list + comfortable reading view (serif type, reading-progress bar,
  prev/next chapter navigation, dark mode), mobile-first layout.
- Chapters are written by the admin: create, edit, delete, draft/publish.

**Community (Reddit-style)**

- Accounts: username + phone number. Password login or one-time-code login
  (see "Auth modes" below).
- Communities (like subreddits): default `announcements` (read-only) and
  `discussions`; the admin can create more and enable/disable posting per
  community.
- Posts with up/down votes, threaded comments with replies, comment threads
  on chapters too.
- User reports with reasons; reply notifications; @mentions; public profiles;
  search across posts, comments, chapters and users.

**Admin**

- Dashboard stats, chapter manager, user search + block/unblock, comment
  hide/restore/delete, post pin/hide/delete, report resolve/dismiss, audit
  log of every admin action, and site settings (site name, tagline, rules,
  registrations on/off, user posts on/off).
- Phone numbers: only the admin can see members' phone numbers
  (Admin → Users → view a user), for spam monitoring. No one else sees them.

**Security**

- bcrypt password hashing, httpOnly session cookies, CSRF tokens on every
  state-changing request, rate limits on auth/OTP/comments, server-side role
  checks on every admin route, parameterized SQL, escaped output (XSS-safe),
  strict security headers + CSP, generic login errors (no account
  enumeration).

## Run it locally

You need **Node.js >= 22.5** (check with `node -v`).

```bash
npm install   # once
npm start     # → http://localhost:3000
```

**First boot — claim your admin account.** On the very first start the server
creates an admin account (no one has claimed it yet) and prints a **one-time
claim URL** to the terminal console, something like:

```
http://localhost:3000/admin/claim?token=abc123...
```

Open that URL in your browser, enter your phone number, and finish claiming
the account (in `password` mode you'll also set a password; in `otp` mode
you'll enter the 6-digit code — in dev mode the code prints to the server
console). The token works **once**, then stops working. After claiming, log
in normally and go to **Admin → Chapters → New chapter** to add chapters
(Chapter 1 is seeded automatically from the manuscript).

Tip: copy `.env.example` to `.env` to set options like `AUTH_MODE` without
typing them every time.

## Auth modes

Set `AUTH_MODE` to choose how people log in:

| Value | Behavior |
|---|---|
| `password` (default) | Register with phone + username + password. Log in with phone **or** username + password. |
| `otp` | Register with phone + username; a 6-digit code is sent for verification. Log in with phone + code only — no passwords at all. |

`OTP_PROVIDER` decides how the 6-digit code is delivered (only matters in
`otp` mode):

| Value | Behavior |
|---|---|
| `dev` (default) | The code is printed to the **server console**. Free. Only for local testing — codes never reach a real phone. |
| `whatsapp` | The code is sent via the **WhatsApp Cloud API** using your approved authentication template. **This costs money per message** (Meta bills each authentication-template message; e.g. around US $0.01–0.015 per OTP to Pakistani numbers — always check Meta's current rate card). Setting this up also requires Meta business verification and a payment method. See `docs/WHATSAPP_SETUP.md`. Firebase is not used at all. |

For a real public site with actual readers, `whatsapp` is the only mode that
delivers codes to real phones — and it is the only feature on this site that
costs money.

## Project structure

```
server.js        Express app setup: security headers, sessions, CSRF,
                 settings, chapter reader routes (/chapters, /chapter/:id),
                 error pages, boot
routes/          Route modules, wired from server.js:
  auth.js        login/register/logout, OTP API, one-time admin claim
  community.js   feed (/), communities (/c/:slug), posts (/p/:id), votes,
                 comments, reports, profiles, notifications, search
  admin.js       admin dashboard (/admin/*): chapters, users, comments,
                 posts, communities, reports, audit log, settings
lib/             otp.js (code engine + WhatsApp delivery), phone.js
                 (number validation), auth.js (sessions/passwords),
                 validate.js, ratelimit.js, bootstrap.js (first-boot admin),
                 comments.js, notify.js, avatars.js
db.js            Dual-mode database: SQLite file in ./data by default (zero
                 config locally); PostgreSQL when DATABASE_URL is set.
                 Same code works for both — the app picks automatically.
views/           EJS templates (pages + admin screens)
public/          mobile-first CSS + vanilla JS (no build step)
data/            SQLite database file (local mode; created on boot, never
                 served over HTTP)
seed/            chapter1.json — Chapter 1 text from the manuscript
```

## Putting it on the internet (free)

See [DEPLOY.md](DEPLOY.md): Render's free tier for hosting + Neon's free
tier for the database, no credit card for either. Two rules to remember:

1. **On Render you must set `DATABASE_URL`** (Neon). The local SQLite file
   is wiped on every Render restart/redeploy.
2. **Keep `OTP_PROVIDER=dev` on your live site** unless you've done the paid
   WhatsApp setup in `docs/WHATSAPP_SETUP.md`.

## Phone-number privacy

Members log in with their phone number, so phone numbers are collected —
this is the private part of the site. The rules are simple:

- Phone numbers are **never shown on public pages**, profiles, posts or
  comments.
- Only the **admin** can look up a member's number (Admin → Users → view
  user) for spam/abuse monitoring.
- Numbers are validated and normalized (`+923001234567` style), stored with
  unique indexes, and appear in logs only in the dev-mode OTP line and in
  the admin audit trail.
