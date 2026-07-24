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

  async function sbGet(userId, select) {
    const g = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${select}`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}` },
    });
    const rows = g.ok ? await g.json() : [];
    return rows[0] || {};
  }

  if (event.type === 'checkout.session.completed') {
    const userId = obj.client_reference_id;
    if (!userId) return res.status(200).json({ ok: true, note: 'no client_reference_id' });
    const kind = obj.metadata && obj.metadata.kind;

    if (kind === 'examiner') {
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`,
        { examiner: true, examiner_sub: obj.subscription ? String(obj.subscription) : null });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, examiner: true });
    }
    if (kind === 'report') {
      const row = await sbGet(userId, 'report_credits');
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, { report_credits: (row.report_credits || 0) + 1 });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, report_credits: (row.report_credits || 0) + 1 });
    }
    if (kind === 'lifetime') {
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, { premium: true, lifetime: true });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, lifetime: true });
    }
    if (kind === 'cosmetic') {
      const row = await sbGet(userId, 'progress');
      const progress = row.progress || {};
      const owned = progress['chemlab-cosmetics'] || [];
      const item = obj.metadata.item;
      if (item && !owned.includes(item)) owned.push(item);
      progress['chemlab-cosmetics'] = owned;
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, { progress });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, cosmetics: owned });
    }
    if (kind === 'season') {
      const year = new Date().getFullYear();
      const end = new Date(Date.UTC(new Date() > new Date(`${year}-06-30`) ? year + 1 : year, 5, 30, 23, 59));
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, { season_until: end.toISOString() });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, season_until: end.toISOString() });
    }
    if (kind === 'everything') {
      const row = await sbGet(userId, 'progress,report_credits');
      const progress = row.progress || {};
      progress['chemlab-cosmetics'] = ['aurora', 'magma', 'holo', 'void'];
      const rk = progress['chemlab-ranked'] || { rp: 0, tubes: 0, minted: 0, streak: 0, freezes: 0, log: [] };
      rk.rp = Math.min(3150, (rk.rp || 0) + 450);       // one bonus rank jump, capped below tube territory
      rk.jumps = (rk.jumps || 0) + 1;
      rk.log = [{ t: Date.now(), txt: '🧪 THE EVERYTHING FLASK', rp: 450 }, ...(rk.log || [])].slice(0, 12);
      progress['chemlab-ranked'] = rk;
      const year = new Date().getFullYear();
      const end = new Date(Date.UTC(new Date() > new Date(`${year}-06-30`) ? year + 1 : year, 5, 30, 23, 59));
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, {
        premium: true, lifetime: true, examiner: true,
        report_credits: (row.report_credits || 0) + 3,
        season_until: end.toISOString(), progress,
      });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, everything: true });
    }
    if (kind === 'rankjump') {
      // paid rank jump: +1 full tier (450 RP), capped at the Nobel Laureate floor —
      // test tubes can never be bought
      const g = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=progress`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}` },
      });
      const rows = g.ok ? await g.json() : [];
      const progress = (rows[0] && rows[0].progress) || {};
      const rk = progress['chemlab-ranked'] || { rp: 0, tubes: 0, minted: 0, streak: 0, freezes: 0, lastCheck: null, lastActive: null, decayedFor: null, shieldUntil: 0, log: [] };
      rk.rp = Math.min(3150, (rk.rp || 0) + 450);
      rk.jumps = (rk.jumps || 0) + 1;
      rk.shieldUntil = Date.now() + 3 * 86400000;
      rk.log = [{ t: Date.now(), txt: `🚀 RANK JUMP #${rk.jumps} purchased`, rp: 450 }, ...(rk.log || [])].slice(0, 12);
      progress['chemlab-ranked'] = rk;
      const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`, { progress });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, rankjump: rk.jumps, rp: rk.rp });
    }

    const r = await sbPatch(`id=eq.${encodeURIComponent(userId)}`,
      { premium: true, payment_customer_id: obj.customer ? String(obj.customer) : undefined });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, premium: true });
  }
  if (event.type === 'customer.subscription.deleted') {
    // examiner add-on cancelled?
    const eRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?examiner_sub=eq.${encodeURIComponent(String(obj.id))}&select=id`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}` },
    });
    const eRows = eRes.ok ? await eRes.json() : [];
    if (eRows.length) {
      const r = await sbPatch(`examiner_sub=eq.${encodeURIComponent(String(obj.id))}`, { examiner: false, examiner_sub: null });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, examiner: false });
    }
    if (!obj.customer) return res.status(200).json({ ok: true, note: 'no customer' });
    // premium sub cancelled — lifetime owners keep premium forever (well, 100 years)
    const r = await sbPatch(`payment_customer_id=eq.${encodeURIComponent(String(obj.customer))}&lifetime=eq.false`,
      { premium: false });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, premium: false });
  }
  return res.status(200).json({ ok: true, note: `ignored ${event.type}` });
}
