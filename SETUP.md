# Going paid — one-time setup

## 1. Supabase (accounts + database) — free
1. https://supabase.com → New project (any region near you, e.g. eu-west).
2. SQL Editor → paste the whole of `schema.sql` → Run.
3. Authentication → Providers → Email: leave enabled. (Optional later: Google.)
4. Project Settings → API — copy three values:
   - Project URL            → goes in index.html CHEMLAB_CONFIG.url  AND Vercel env SUPABASE_URL
   - anon public key        → goes in index.html CHEMLAB_CONFIG.anon
   - service_role key       → Vercel env SUPABASE_SERVICE_ROLE  (server only — never in the page)

## 2. Lemon Squeezy (payments)
1. https://lemonsqueezy.com → create store (it starts in test mode — perfect).
2. Products → New product → "ChemLab Premium", Subscription, e.g. £4.99/month
   (add a yearly variant £29/year if you like).
3. Share → copy the checkout link → index.html CHEMLAB_CONFIG.checkout
4. Settings → Webhooks → new webhook:
   - URL: https://chemlab-ten.vercel.app/api/ls-webhook
   - Signing secret: invent a long random string → Vercel env LS_WEBHOOK_SECRET
   - Events: subscription_created, subscription_expired, subscription_resumed,
     subscription_unpaused, subscription_payment_success

## 3. Vercel environment variables
Project → Settings → Environment Variables (Production):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE, LS_WEBHOOK_SECRET

## 4. Tell Claude the two public values
Paste the Project URL + anon key + checkout link in chat (they are safe to be public —
the anon key is designed to ship in the page; row-level security does the protecting).
Claude fills CHEMLAB_CONFIG, pushes, and the site switches from local mode to accounts.

## Notes
- Until step 4, the site runs in "local mode": everything unlocked, progress on-device only.
- Before charging real money: switch the LS store out of test mode, and add Terms +
  Privacy + refund policy pages (LS requires them; Claude can draft these).
