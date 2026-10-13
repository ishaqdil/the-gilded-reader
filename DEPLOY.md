# Deploying The Gilded Cage (Render + Neon, $0 to start)

The working setup: **Render** (free tier) runs the site, **Neon** (free tier)
holds the database. Signing up for both needs no credit card. Your chapters,
users, comments and posts live in Neon — Render can sleep and restart all it
wants and nothing is ever wiped.

This is a *free-tier* setup, not "free forever". Both providers have limits —
see "Free-tier limits" below.

## Why two services

On Render's free tier the app's own filesystem is **ephemeral**: the local
SQLite file (`data/chapters.db`) is wiped on every restart or redeploy. The
app handles this by switching to Postgres whenever `DATABASE_URL` is set
(`db.js` dual-mode). So: on Render, `DATABASE_URL` is not optional — it is
what keeps your data permanent.

## Step 1 — Free database (Neon, ~5 minutes)

1. Go to **neon.com** → sign up (email or GitHub, no card required).
2. Create a project (any name; pick a region near Pakistan, e.g. Singapore).
3. Open the project → **Connection Details** → copy the **connection string**.
   It looks like: `postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require`
4. Keep it private — anyone with it can read and change your database.

## Step 2 — Deploy the app (Render, ~10 minutes)

1. Push this project to a GitHub repository.
2. Go to **render.com** → sign up (email, no card required) → **New → Web
   Service** → connect your repo. `render.yaml` fills in the build/start
   commands automatically (Node 22).
3. Before the first deploy, open the service's **Environment** tab and add
   the variables from the table below.
4. **Deploy.** On first boot the app creates all tables in Neon
   automatically and seeds Chapter 1.
5. Your site is live at `https://<name>.onrender.com`.

## Step 3 — Environment variables

Set these in Render under **Environment** (values are placeholders —
use your own):

| Variable | Required? | What to set |
|---|---|---|
| `DATABASE_URL` | **Yes (on Render)** | Neon connection string from Step 1. Without it the app falls back to the SQLite file, which is **wiped on every restart**. |
| `ADMIN_USER` | Optional | Username for the first-boot admin. Default: `admin`. |
| `ADMIN_CLAIM_TOKEN` | Optional | A secret token you choose (e.g. a long random string). If unset, the app prints a random one-time claim URL to the console instead. |
| `AUTH_MODE` | Optional | `password` (default) or `otp`. See README "Auth modes". |
| `OTP_PROVIDER` | Optional | `dev` (default) — prints OTP codes to logs, free, local-only. `whatsapp` — sends real OTPs via the WhatsApp Cloud API; **costs money per message** and needs the WHATSAPP_* vars. See `docs/WHATSAPP_SETUP.md`. |
| `WHATSAPP_PHONE_NUMBER_ID` | Only with `OTP_PROVIDER=whatsapp` | From your Meta developer dashboard. |
| `WHATSAPP_TOKEN` | Only with `OTP_PROVIDER=whatsapp` | Permanent WhatsApp Cloud API token. Treat like a password. |
| `WHATSAPP_TEMPLATE` | Only with `OTP_PROVIDER=whatsapp` | Your approved authentication template name (default the app uses: `otp_code`). |
| `OTP_PEPPER` | Optional | A long random string. Mixes into stored OTP hashes for extra protection. |
| `PORT` | No | Render sets this automatically. Only used locally. |

**Practical recommendation for the first deploy:** leave `AUTH_MODE` unset
(default `password`) and leave `OTP_PROVIDER=dev`. Your readers log in with
phone + password — no phone setup needed, no WhatsApp costs. Switch to
`otp`/`whatsapp` later only if password-free login is worth paying Meta per
code (see `docs/WHATSAPP_SETUP.md` for the costs, stated plainly).

## Step 4 — Claim the admin account (post-deploy)

On first boot the app creates the admin account unclaimed and prints a
one-time claim URL to the logs:

1. Open your Render service → **Logs** (scroll to the first deploy).
2. Find the one-time claim URL containing `/admin/claim?token=...`. **Copy
   only the `token=...` part** (the printed line starts with
   `http://localhost:…`, which is wrong on Render — ignore the hostname).
3. Open in your browser:
   `https://<your-service>.onrender.com/admin/claim?token=PASTE_TOKEN_HERE`
4. Enter your phone number, and in `password` mode also set a password (in
   `otp` mode you'll enter the 6-digit code — with `OTP_PROVIDER=dev` the
   code is printed in Render's logs, so this claim step is a bit of
   copy-pasting; for a real site you'd finish WhatsApp setup first).
5. The token stops working after one use. Log in normally at `/login`.

## Step 5 — Set your site settings

Log in as admin → **Admin → Settings**: set the site name, tagline and
community rules, and choose whether registrations and user posts are open.
Then **Admin → Chapters → New chapter** to add chapters beyond Chapter 1.

## Free-tier limits (read these)

- **Render free tier sleeps after ~15 minutes of no traffic.** The first
  visitor after a sleep waits for a cold start (typically ~30–60 seconds)
  while the service wakes up. After that it's normal speed. Your data is
  unaffected because it lives in Neon.
- **Neon free tier has storage and usage limits** — check Neon's current
  free-tier limits on their site (they change). A novel + thousands of
  comments uses very little; this is fine for a small reader community.
- **What is NOT free:** WhatsApp OTP delivery. Meta bills every
  authentication-template message (approximately US $0.01–0.015 per OTP to
  Pakistani numbers per the Oct 2026 rate card — approximate; verify Meta's
  live rate card before relying on it). With `OTP_PROVIDER=dev` and password
  login, the site itself costs nothing.
- **Firebase is not needed or used.** The site does not use Firebase at all
  — no Firebase project, no Firebase Phone Auth (which, for the record,
  requires the Blaze pay-as-you-go plan with a credit card, so it's off the
  table for a no-credit-card setup).

## If something breaks

- **"Database file wiped" symptoms (empty site after redeploy):**
  `DATABASE_URL` is missing or wrong. Set it in Render → Environment and
  redeploy.
- **Admin claim page says "Not found":** the token was already used or
  mistyped. If you've lost admin access entirely, you'll need to clear the
  `claim_token_hash` situation via the database (Neon console) — ask for
  help rather than guessing.
- **Codes never arrive (otp mode):** with `OTP_PROVIDER=dev` they only go
  to the server logs, never to a phone. Real delivery needs the WhatsApp
  setup in `docs/WHATSAPP_SETUP.md`.
- **Site slow on first visit:** that's the free-tier cold start, not a bug.
