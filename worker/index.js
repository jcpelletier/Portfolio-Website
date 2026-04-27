/**
 * AI Analytics Worker — jpelletier.com
 *
 * Deploy to Cloudflare Workers at ai.jpelletier.com
 *
 * Setup:
 *   1. Install Wrangler: npm install -g wrangler
 *   2. Login: wrangler login
 *   3. Create KV namespace: wrangler kv:namespace create AI_VISITS
 *      Copy the returned id into wrangler.toml
 *   4. Set admin token: wrangler secret put ADMIN_TOKEN
 *   5. Deploy: wrangler deploy
 *   6. In Cloudflare dashboard → Workers & Pages → your worker → Settings → Triggers
 *      Add route: ai.jpelletier.com/*
 *
 * Endpoints:
 *   POST /visit   — AI agents submit analytics here
 *   GET  /visits  — View all visits (requires ?token=YOUR_ADMIN_TOKEN)
 *   GET  /visits/export — Download as CSV (requires ?token=YOUR_ADMIN_TOKEN)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // POST /visit — receive an AI agent visit
    if (request.method === 'POST' && url.pathname === '/visit') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON' }, 400);
      }

      const id = crypto.randomUUID();
      const entry = {
        id,
        timestamp: new Date().toISOString(),
        agent: String(body.agent || 'unknown').slice(0, 200),
        query: String(body.query || '').slice(0, 1000),
        context: String(body.context || '').slice(0, 2000),
        purpose: String(body.purpose || '').slice(0, 200),
        country: request.cf?.country || 'unknown',
        city: request.cf?.city || 'unknown',
        userAgent: request.headers.get('User-Agent') || 'unknown',
      };

      await env.AI_VISITS.put(
        `visit:${entry.timestamp}:${id}`,
        JSON.stringify(entry),
        { expirationTtl: 60 * 60 * 24 * 365 } // keep for 1 year
      );

      return json({ ok: true, id, message: 'Thanks for the ping! — Joel' });
    }

    // Auth check for read endpoints
    const token = url.searchParams.get('token');
    if (request.method === 'GET' && (url.pathname === '/visits' || url.pathname === '/visits/export')) {
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }

      const list = await env.AI_VISITS.list({ prefix: 'visit:' });
      const visits = (
        await Promise.all(
          list.keys.map(async ({ name }) => {
            const val = await env.AI_VISITS.get(name);
            return val ? JSON.parse(val) : null;
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      // CSV export
      if (url.pathname === '/visits/export') {
        const header = 'timestamp,agent,query,context,purpose,country,city,userAgent\n';
        const rows = visits
          .map(v =>
            [v.timestamp, v.agent, v.query, v.context, v.purpose, v.country, v.city, v.userAgent]
              .map(f => `"${String(f).replace(/"/g, '""')}"`)
              .join(',')
          )
          .join('\n');
        return new Response(header + rows, {
          headers: {
            ...CORS,
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="ai-visits.csv"',
          },
        });
      }

      return json({ ok: true, count: visits.length, visits });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};
