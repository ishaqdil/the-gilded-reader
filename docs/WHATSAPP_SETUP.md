# Setting up real WhatsApp OTP (read this first)

**The short version: real WhatsApp OTP costs money — Meta charges for every
code sent.** That's why the app ships with `OTP_PROVIDER=dev`, which just
prints codes to the server console and costs nothing. If you are broke,
stay on `dev` (local testing) or use password login on your live site (free).
Only do this setup if you understand and accept the per-message cost below.

**What is never used here: Firebase.** Firebase Phone Auth is not used by
this app and is not an alternative — it requires the Firebase Blaze
pay-as-you-go plan with a credit card attached (since September 2024, per
Google's own pricing). That alone rules it out.

## What it costs (verified October 2026)

- Meta bills **authentication-template messages** per message — an OTP code
  sent via WhatsApp is exactly that. There is no free tier for template
  messages.
- Effective **1 October 2026**, Meta raised the authentication rate for
  **Pakistan** from **US $0.0100 to US $0.0150 per message**
  (**APPROXIMATE** — Meta's rate cards change; verify the live rate card at
  `developers.facebook.com/docs/whatsapp/pricing/authenticationinternationalrates`
  before relying on this number).
- Translation: every OTP your site sends to a Pakistani number costs roughly
  1.5 cents. Every resend costs another 1.5 cents — including codes requested
  by bots or mistyped numbers, so the rate limits in this app exist partly to
  protect your wallet.
- WhatsApp **API access itself is free** — but to send to real numbers you
  must complete **Meta business verification** and attach a **payment method**
  in the Billing Hub, or your messages stop being delivered.

## What you need

- A Meta (Facebook) developer account: `developers.facebook.com`
- A Meta Business account, with **business verification** completed
- A phone number registered on the WhatsApp Cloud API (must not be active
  on personal or Business-app WhatsApp)
- A payment method attached in Meta's Billing Hub

## Steps

### 1. Create the Meta developer setup

1. Sign in at `developers.facebook.com` → **Create App**.
2. In the app dashboard, add the **WhatsApp** product.
3. In **API Setup** you'll see a test phone number — good for a first test,
   but for real use, add your own number and verify it (Meta sends an OTP to
   it by SMS or voice call).
4. Note the **Phone number ID** (NOT the phone number itself) shown on the
   API Setup page — this is your `WHATSAPP_PHONE_NUMBER_ID`.

### 2. Create a permanent access token

Test tokens expire in 24 hours. For a live site:

1. In Meta Business Settings, create a **System User**, give it the
   `whatsapp_business_messaging` permission.
2. Generate a token for that system user — this is your
   `WHATSAPP_TOKEN`. It does not expire.
3. **Keep it secret like a password.** Anyone with it can send messages on
   your number and run up your bill.

### 3. Create the authentication template

In WhatsApp Manager (**Account Tools → Message Templates**):

1. Create a template, category **Authentication** — this is the category
   that allows OTP codes and gets the authentication rate.
2. Name it `otp_code` (or your own name — you'll put it in
   `WHATSAPP_TEMPLATE`).
3. Language: **English** (`en`) — the app requests the `en` language.
4. Body: something like

   ```
   Your Gilded Cage code is {{1}}. It expires in 10 minutes. Never share it.
   ```

   `{{1}}` is where the 6-digit code goes. The app sends exactly one body
   parameter (the code), so your template must have exactly one `{{1}}`
   body variable.
5. Submit and wait for approval (usually minutes to a few hours). Codes
   won't send until the template is **Approved**.

### 4. Set the app's environment variables

```
AUTH_MODE=otp
OTP_PROVIDER=whatsapp
WHATSAPP_PHONE_NUMBER_ID=1234567890123456      # from step 1
WHATSAPP_TOKEN=EAAG...                          # from step 2 (secret)
WHATSAPP_TEMPLATE=otp_code                      # from step 3
OTP_PEPPER=<a long random string>               # extra hash protection
```

On Render, set these under **Environment** and redeploy. Locally, put them
in `.env`.

### 5. Test

1. Register a new account with **your own** phone number
   (`+92…` format). You should receive the WhatsApp message with the code.
2. Enter it — registration completes.
3. Check Meta's Billing Hub / message insights to confirm what was billed.
4. If nothing arrives: the template is probably not yet Approved, or the
   number isn't registered on the API, or no payment method is attached.
   Render's logs show the error Meta returned (the app logs it without the
   code).

## Why it's dormant by default

`OTP_PROVIDER=dev` is the default because:

- **It's free.** `whatsapp` costs real money per message (see above).
- **It needs Meta business verification + a payment method**, which requires
  a credit card — a hard no for a no-credit-card setup.
- **Real codes only help real users.** For local development and for a
  password-login site, nothing is gained by paying Meta.

Practical rule of thumb: run `OTP_PROVIDER=dev` locally (codes in the
console) and on a live site use `AUTH_MODE=password` until password-free
login is genuinely worth the per-code cost to you.
