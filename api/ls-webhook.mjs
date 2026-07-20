// Lemon Squeezy webhook → flips `premium` on the buyer's Supabase profile.
// Env vars required (Vercel → Settings → Environment Variables):
//   LS_WEBHOOK_SECRET      — signing secret set when creating the webhook in Lemon Squeezy
//   SUPABASE_URL           — https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE  — service_role key (server-only; never expose to the browser)
import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PREMIUM_ON  = new Set(['subscription_created', 'subscription_resumed', 'subscription_unpaused', 'subscription_payment_success', 'order_created']);
const PREMIUM_OFF = new Set(['subscription_expired']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await rawBody(req);
  const sig = req.headers['x-signature'] || '';
  const digest = crypto.createHmac('sha256', process.env.LS_WEBHOOK_SECRET || '').update(raw).digest('hex');
  const a = Buffer.from(digest, 'utf8'), b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  const payload = JSON.parse(raw.toString('utf8'));
  const event = payload?.meta?.event_name;
  const userId = payload?.meta?.custom_data?.user_id; // passed via checkout link custom data
  if (!userId) return res.status(200).json({ ok: true, note: 'no user_id in custom_data' });

  let premium = null;
  if (PREMIUM_ON.has(event)) premium = true;
  if (PREMIUM_OFF.has(event)) premium = false;
  if (premium === null) return res.status(200).json({ ok: true, note: `ignored ${event}` });

  const customerId = payload?.data?.attributes?.customer_id;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ premium, ls_customer_id: customerId ? String(customerId) : undefined, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return res.status(502).json({ error: 'supabase update failed', status: r.status });
  return res.status(200).json({ ok: true, premium });
}
