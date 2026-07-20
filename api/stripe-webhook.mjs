// Stripe webhook → flips `premium` on the buyer's Supabase profile.
// Env vars: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE
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

function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // 5 min tolerance
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sbPatch(filter, body) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await rawBody(req);
  if (!verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const event = JSON.parse(raw.toString('utf8'));
  const obj = event?.data?.object || {};

  if (event.type === 'checkout.session.completed') {
    const userId = obj.client_reference_id;
    if (!userId) return res.status(200).json({ ok: true, note: 'no client_reference_id' });
    const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`,
      { premium: true, payment_customer_id: obj.customer ? String(obj.customer) : undefined });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, premium: true });
  }
  if (event.type === 'customer.subscription.deleted') {
    if (!obj.customer) return res.status(200).json({ ok: true, note: 'no customer' });
    const r = await sbPatch(`payment_customer_id=eq.${encodeURIComponent(String(obj.customer))}`,
      { premium: false });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, premium: false });
  }
  return res.status(200).json({ ok: true, note: `ignored ${event.type}` });
}
