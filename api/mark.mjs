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

const PLAN_SYSTEM = `You are an expert A-level Chemistry tutor and study coach — a professor with deep expertise in every A-level topic and in how students actually learn.

You receive a JSON summary of one student's progress: per-chapter question accuracy, self-rated confidence (1-5), chapters marked mastered, and recent exam scores.

Write a personalised 2-week catch-up plan in plain text (no markdown headers, use simple numbered days/blocks):
- Start with one honest, encouraging sentence about where they stand.
- Identify the 2-3 weakest chapters from the data and explain in one line each WHY that chapter is likely weak (which concepts within it usually cause the trouble).
- Give a day-by-day plan (about 30-45 min/day): which chapter, what to reread, which misconception to attack, and when to re-test with the app's chapter quizzes and exams.
- Interleave: revisit each weak chapter at least twice with spacing, and include one strong chapter session to maintain it.
- End with one concrete measurable goal for the fortnight.
Keep it under 350 words. Address the student as "you".`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ fallback: true });

  const client = new Anthropic();
  const body = req.body || {};

  try {
    if (body.action === 'mark') {
      const items = (body.items || []).slice(0, 30).map(it => ({
        question: String(it.q || '').slice(0, 2000),
        max_marks: it.marks,
        mark_scheme: it.scheme,
        student_answer: String(it.answer || '').slice(0, 4000),
      }));
      if (!items.length) return res.status(400).json({ error: 'no items' });

      const msg = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: MARK_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: MARK_SCHEMA } },
        messages: [{ role: 'user', content: JSON.stringify({ answers_to_mark: items }) }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '{}';
      return res.status(200).json(JSON.parse(text));
    }

    if (body.action === 'plan') {
      const msg = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
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
