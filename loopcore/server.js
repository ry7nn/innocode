// Loopcore — tiny server. Serves index.html and proxies the AI matcher so the API key
// stays on the server. No dependencies: Node 18+ only.
//
//   ANTHROPIC_API_KEY=sk-... node server.js
//   PORT=3001 LOOPCORE_MODEL=claude-sonnet-4-5 node server.js
//
// With no key set the page still works: /api/match answers 501 and the front end falls
// back to its built-in offline library. That is the demo-safe path.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LOOPCORE_MODEL || 'claude-sonnet-4-5';

// The only nodes that exist on the demo map. The model may only reference these.
const NODES = ['bakery', 'laundry', 'cement', 'datacentre', 'plastics', 'greenhouse', 'dyehouse'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

/* ---- crude per-IP rate limit: 20 requests a minute ---- */
const buckets = new Map();
function limited(ip) {
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 5000) buckets.clear();
  return hits.length > 20;
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractJSON(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
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

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

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

async function handleMatch(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (limited(ip)) return send(res, 429, { error: 'rate_limit' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  const business = typeof body?.business === 'string' ? body.business.trim() : '';
  if (business.length < 3) return send(res, 400, { error: 'empty' });
  if (!KEY) return send(res, 501, { error: 'no_key' });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: 'user', content: business.slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      console.error('[match] upstream', upstream.status, detail);
      return send(res, 502, { error: 'upstream', status: upstream.status });
    }

    const data = await upstream.json();
    const text = (data?.content || []).map((c) => c?.text || '').join('\n');
    const parsed = extractJSON(text);
    if (!parsed) return send(res, 502, { error: 'bad_json' });

    const out = sanitize(parsed);
    if (!out.partners.length) return send(res, 502, { error: 'no_partners' });
    return send(res, 200, { ...out, source: 'ai' });
  } catch (err) {
    console.error('[match] failed:', err?.message);
    return send(res, 502, { error: 'upstream' });
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return send(res, 400, 'bad path', 'text/plain; charset=utf-8');
  }
  const full = normalize(join(ROOT, decoded));
  if (!full.startsWith(ROOT) || decoded.includes('\0')) {
    return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  }
  try {
    const buf = await readFile(full);
    return send(res, 200, buf, MIME[extname(full).toLowerCase()] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

const server = createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, { error: 'bad_url' });
  }

  if (pathname === '/api/health') {
    return send(res, 200, { ai: Boolean(KEY), model: KEY ? MODEL : null });
  }
  if (pathname === '/api/match') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    return handleMatch(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'method not allowed', 'text/plain; charset=utf-8');
  }
  return serveStatic(res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Loopcore  http://localhost:${PORT}`);
  console.log(
    KEY
      ? `AI matcher: live (${MODEL})`
      : 'AI matcher: no ANTHROPIC_API_KEY set — front end will use its offline library'
  );
});
