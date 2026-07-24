// AI examiner: marks written answers against mark schemes, and generates study plans.
// Env: ANTHROPIC_API_KEY (Vercel). Without it, returns 501 and the client falls back to self-marking.
import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 300 };

const MARK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          awarded: { type: 'integer' },
          feedback: { type: 'string' },
          points_hit: { type: 'array', items: { type: 'string' } },
          points_missed: { type: 'array', items: { type: 'string' } },
        },
        required: ['awarded', 'feedback', 'points_hit', 'points_missed'],
        additionalProperties: false,
      },
    },
    overall: { type: 'string' },
  },
  required: ['results', 'overall'],
  additionalProperties: false,
};

const MARK_SYSTEM = `You are a senior A-level Chemistry examiner — a chemistry professor with decades of marking experience across physical, inorganic and organic chemistry, marking to AQA conventions.

Mark each student answer strictly against its mark scheme:
- Award a mark only when the chemistry genuinely earns the marking point (equivalent wording is fine; vague hand-waving is not).
- Apply error-carried-forward in calculations: a wrong early number worked through correctly still earns method marks.
- Never award more than the question's maximum marks. awarded must be an integer from 0 to that maximum.
- points_hit / points_missed must quote the mark scheme points (verbatim or lightly shortened).
- feedback: 2-4 sentences to a 16-18 year old student — name exactly what was missing or wrong, state the correct chemistry, and be encouraging without inflating the marks. Use the precise wording examiners reward.
- overall: 2-3 sentences on the pattern across the whole paper: strongest area, the one habit that would gain the most marks next time.
Return results in the same order as the questions given.`;

const REPORT_SYSTEM = `You are a senior A-level Chemistry examiner writing a formal Predicted Grade Report for one student, based on a JSON summary of their app data (per-chapter accuracy, confidence, mastery, exam history, streaks, rank).

Write the report in clean sections separated by lines of "----". Sections, in order:
1. HEADLINE — one paragraph: overall standing and a predicted grade band (A*, A, B, C, D or E) with honest confidence. Base it on exam percentages (A* ≈ 85%+, A ≈ 75%+, B ≈ 65%+, C ≈ 55%+, D ≈ 45%+) weighted toward recent papers, adjusted down if data is thin — say so if it is.
2. CHAPTER MAP — for each chapter with data: one line "Chapter — accuracy — verdict" (verdict: secure / developing / at risk / untested).
3. TRAJECTORY — are they improving? Reference their recent exam scores in order.
4. THE FORTNIGHT PLAN — a concrete 14-day plan (30-45 min/day) targeting the two weakest chapters, with spaced returns and one strong-chapter maintenance session.
5. EXAMINER'S NOTE — two sentences of encouragement grounded in something real from their data.

Address the student as "you". No markdown syntax, no asterisks. Keep it under 550 words. Be precise, warm and honest — never inflate the grade.`;

const PLAN_SYSTEM = `You are an expert A-level Chemistry tutor and study coach — a professor with deep expertise in every A-level topic and in how students actually learn.

You receive a JSON summary of one student's progress: per-chapter question accuracy, self-rated confidence (1-5), chapters marked mastered, and recent exam scores.

Write a personalised 2-week catch-up plan in plain text (no markdown headers, use simple numbered days/blocks):
- Start with one honest, encouraging sentence about where they stand.
- Identify the 2-3 weakest chapters from the data and explain in one line each WHY that chapter is likely weak (which concepts within it usually cause the trouble).
- Give a day-by-day plan (about 30-45 min/day): which chapter, what to reread, which misconception to attack, and when to re-test with the app's chapter quizzes and exams.
- Interleave: revisit each weak chapter at least twice with spacing, and include one strong chapter session to maintain it.
- End with one concrete measurable goal for the fortnight.
Keep it under 350 words. Address the student as "you".`;

// Premium-only: verify the caller's Supabase JWT and premium flag before spending
// Anthropic credits. Local mode (no Supabase env) skips the check.
async function requirePremium(req) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { ok: true };
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, status: 401, error: 'sign in required' };
  const uRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!uRes.ok) return { ok: false, status: 401, error: 'invalid session' };
  const user = await uRes.json();
  const pRes = await fetch(`${url}/rest/v1/profiles?id=eq.${user.id}&select=premium,admin,examiner,season_until,ai_month,ai_used,report_credits`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const row = (pRes.ok && ((await pRes.json())[0])) || {};
  if (!row.premium && !row.admin) return { ok: false, status: 402, error: 'premium required' };
  return { ok: true, userId: user.id, row };
}

const AI_QUOTA = 25;
function unlimited(row) {
  if (row.admin || row.examiner) return true;
  if (row.season_until && new Date(row.season_until) > new Date()) return true;
  return false;
}
async function spendQuota(userId, row) {
  // returns {allowed, remaining} and increments usage for metered users
  if (unlimited(row)) return { allowed: true, remaining: -1 };
  const month = new Date().toISOString().slice(0, 7);
  const used = row.ai_month === month ? (row.ai_used || 0) : 0;
  if (used >= AI_QUOTA) return { allowed: false, remaining: 0 };
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ ai_month: month, ai_used: used + 1 }),
  });
  return { allowed: true, remaining: AI_QUOTA - used - 1 };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ fallback: true });

  const gate = await requirePremium(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const client = new Anthropic();
  const body = req.body || {};

  try {
    if (body.action === 'quota') {
      const r = gate.row || {};
      const month = new Date().toISOString().slice(0, 7);
      return res.status(200).json({
        unlimited: unlimited(r),
        used: r.ai_month === month ? (r.ai_used || 0) : 0,
        limit: AI_QUOTA,
        report_credits: r.report_credits || 0,
      });
    }
    if (body.action === 'mark') {
      const q = await spendQuota(gate.userId, gate.row || {});
      if (!q.allowed) return res.status(402).json({ error: 'quota', limit: AI_QUOTA });
      const items = (body.items || []).slice(0, 30).map(it => ({
        question: String(it.q || '').slice(0, 2000),
        max_marks: it.marks,
        mark_scheme: it.scheme,
        student_answer: String(it.answer || '').slice(0, 4000),
      }));
      if (!items.length) return res.status(400).json({ error: 'no items' });

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 16000,
        system: MARK_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: MARK_SCHEMA } },
        messages: [{ role: 'user', content: JSON.stringify({ answers_to_mark: items }) }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '{}';
      return res.status(200).json({ ...JSON.parse(text), quota_remaining: q.remaining });
    }

    if (body.action === 'report') {
      const r = gate.row || {};
      if (!r.admin && (r.report_credits || 0) < 1)
        return res.status(402).json({ error: 'report_credit' });
      if (!r.admin) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${gate.userId}`, {
          method: 'PATCH',
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
          },
          body: JSON.stringify({ report_credits: (r.report_credits || 0) - 1 }),
        });
      }
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 6000,
        system: REPORT_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(body.stats || {}).slice(0, 24000) }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '';
      return res.status(200).json({ report: text });
    }
    if (body.action === 'plan') {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 4000,
        system: PLAN_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(body.stats || {}).slice(0, 20000) }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '';
      return res.status(200).json({ plan: text });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
