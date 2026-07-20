// Authenticated account endpoint: GDPR data export + account deletion.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, STRIPE_KEY
const SB = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });

  // resolve the caller from their own JWT — they can only ever act on themselves
  const uRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${token}` },
  });
  if (!uRes.ok) return res.status(401).json({ error: 'invalid session' });
  const user = await uRes.json();

  const pRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=premium,progress,payment_customer_id,updated_at`,
    { headers: SB() });
  const profile = (await pRes.json())[0] || {};

  const action = (req.body && req.body.action) || '';

  if (action === 'export') {
    return res.status(200).json({
      exported_at: new Date().toISOString(),
      account: { id: user.id, email: user.email, created_at: user.created_at, last_sign_in_at: user.last_sign_in_at },
      subscription: { premium: !!profile.premium, stripe_customer_reference: profile.payment_customer_id || null },
      study_progress: profile.progress || {},
      notes: 'Payment card details are held by Stripe, not by ChemLab. This file is every piece of data ChemLab stores about you.',
    });
  }

  if (action === 'delete') {
    if (profile.payment_customer_id && process.env.STRIPE_KEY) {
      const subs = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(profile.payment_customer_id)}&status=active`,
        { headers: { Authorization: `Bearer ${process.env.STRIPE_KEY}` } }).then(r => r.json()).catch(() => ({ data: [] }));
      for (const s of subs.data || []) {
        await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${process.env.STRIPE_KEY}` } }).catch(() => {});
      }
    }
    const del = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE', headers: SB() });
    if (!del.ok) return res.status(502).json({ error: 'deletion failed' });
    return res.status(200).json({ ok: true, deleted: true });
  }

  return res.status(400).json({ error: 'unknown action' });
}
