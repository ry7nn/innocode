// Loopcore — edge deployment.
// Serves the static page and the same /api/match contract as server.js, so the
// front end needs no changes. The key lives in the Worker secret ANTHROPIC_API_KEY.

const NODES = ['bakery', 'laundry', 'cement', 'datacentre', 'plastics', 'greenhouse', 'dyehouse'];

const SYSTEM = `You design industrial symbiosis loops for plants in the United Arab Emirates.
Reply with ONE JSON object and nothing else. No prose, no code fences, no markdown.

{"partners":[{"industry":"","exchange":"","benefit":"","node":""}],"summary":""}

Rules:
- 3 partners maximum, the most valuable exchanges first.
- "exchange" names the stream and its direction, e.g. "oven exhaust at 180 C -> pre-heated wash water".
- "benefit" is a single line with a rough AED/year figure and a CO2 figure.
- "node" must be exactly one of: ${NODES.join(', ')} — whichever demo-map plant the partner is closest to.
- "summary" is one sentence under 200 characters.
- Never invent a partner that shares nothing with the input. If the input is vague, still pick the closest real exchanges and say so in the summary.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function extractJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* try the outermost braces below */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitize(obj) {
  const raw = Array.isArray(obj?.partners) ? obj.partners.slice(0, 4) : [];
  const partners = raw
    .map((p) => ({
      industry: str(p?.industry, 80),
      exchange: str(p?.exchange, 240),
      benefit: str(p?.benefit, 160),
      node: NODES.includes(p?.node) ? p.node : '',
    }))
    .filter((p) => p.industry && p.exchange);
  return { partners, summary: str(obj?.summary, 300) };
}

async function match(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  const key = env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: 'no_key' }, 501);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const business = typeof body?.business === 'string' ? body.business.trim() : '';
  if (business.length < 3) return json({ error: 'empty' }, 400);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.LOOPCORE_MODEL || 'claude-sonnet-4-5',
        max_tokens: 700,
        temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: 'user', content: business.slice(0, 2000) }],
      }),
    });

    if (!upstream.ok) {
      console.error('[match] upstream', upstream.status);
      return json({ error: 'upstream', status: upstream.status }, 502);
    }

    const data = await upstream.json();
    const text = (data?.content || []).map((c) => c?.text || '').join('\n');
    const parsed = extractJSON(text);
    if (!parsed) return json({ error: 'bad_json' }, 502);

    const out = sanitize(parsed);
    if (!out.partners.length) return json({ error: 'no_partners' }, 502);
    return json({ ...out, source: 'ai' });
  } catch (err) {
    console.error('[match] failed:', err?.message);
    return json({ error: 'upstream' }, 502);
  }
}

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json({ error: 'bad_url' }, 400);
    }

    if (url.pathname === '/api/health') {
      return json({
        ai: Boolean(env.ANTHROPIC_API_KEY),
        model: env.ANTHROPIC_API_KEY ? env.LOOPCORE_MODEL || 'claude-sonnet-4-5' : null,
      });
    }

    if (url.pathname === '/api/match') return match(request, env);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
};
