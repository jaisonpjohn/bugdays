import { nanoid } from 'nanoid';

interface Env {
  DATA_STORE: KVNamespace;
  ALLOWED_ORIGIN: string;
  TTL_DAYS: string;
}

interface StoredData {
  type: string;  // 'json', 'xml', 'text', 'diff', etc.
  data: string;
  created: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = ['https://bugdays.com', 'https://www.bugdays.com'];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // POST /store
    if (request.method === 'POST' && url.pathname === '/store') {
      const body = await request.json() as { type: string; data: string };

      if (!body.data || typeof body.data !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing data' }), { status: 400, headers });
      }

      const type = body.type || 'text';
      const stored: StoredData = {
        type,
        data: body.data,
        created: Date.now()
      };

      const id = nanoid(12);
      const ttlDays = parseInt(env.TTL_DAYS) || 30;
      await env.DATA_STORE.put(id, JSON.stringify(stored), { expirationTtl: 60 * 60 * 24 * ttlDays });

      return new Response(JSON.stringify({ id, type }), { status: 201, headers });
    }

    // GET /get/:id
    if (request.method === 'GET' && url.pathname.startsWith('/get/')) {
      const id = url.pathname.slice(5);
      if (!/^[a-zA-Z0-9_-]{8,24}$/.test(id)) {
        return new Response(JSON.stringify({ error: 'Invalid ID' }), { status: 400, headers });
      }

      const raw = await env.DATA_STORE.get(id);
      if (!raw) {
        return new Response(JSON.stringify({
          error: 'expired',
          message: 'This shared link has expired or does not exist. Shared links are available for 30 days.'
        }), { status: 410, headers });
      }

      const stored: StoredData = JSON.parse(raw);
      return new Response(JSON.stringify({
        type: stored.type,
        data: stored.data,
        created: stored.created
      }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  },
};
