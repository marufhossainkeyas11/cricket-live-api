/**
 * GET /api/live?matchId=xxx&password=yyy
 * SSE — real-time push to viewers
 */

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url:   process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const matchId  = req.query.matchId || req.query.match;
  const password = req.query.password || '';
  if (!matchId) return res.status(400).end();

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  // Initial data
  const raw = await kv.get(`match:${matchId}`);
  if (!raw) { send({ error: 'not_found' }); return res.end(); }

  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Password check
  if (data.hasPassword) {
    const stored = await kv.get(`pass:${matchId}`);
    if (!password || stored !== password) {
      send({ error: 'password_required' });
      return res.end();
    }
  }

  send(data);

  // Poll signal every 1s
  let lastSig = (await kv.get(`signal:${matchId}`)) || '0';
  let alive   = true;
  res.on('close', () => { alive = false; });

  const iv = setInterval(async () => {
    if (!alive) { clearInterval(iv); return; }
    try {
      const sig = await kv.get(`signal:${matchId}`);
      if (sig && sig !== lastSig) {
        lastSig = sig;
        const d = await kv.get(`match:${matchId}`);
        if (d) send(typeof d === 'string' ? JSON.parse(d) : d);
      }
    } catch {}
  }, 1000);

  // 23s এ close, client reconnect করবে
  setTimeout(() => {
    clearInterval(iv);
    if (alive) { res.write('event: reconnect\ndata: {}\n\n'); res.end(); }
  }, 23000);
}
