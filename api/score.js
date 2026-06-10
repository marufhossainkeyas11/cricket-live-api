/**
 * /api/score
 * POST   — scorer push
 * GET    — single match fetch
 * DELETE — ownership release
 */

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url:   process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

const MATCH_TTL  = 6 * 60 * 60;
const RATE_LIMIT = 2;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    if (req.method === 'POST')   return await handlePost(req, res);
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).end();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

// ── POST ──────────────────────────────────────
async function handlePost(req, res) {
  const { matchId, scorerToken, password = '', ...data } = req.body || {};

  if (!matchId || matchId.length > 64)
    return res.status(400).json({ error: 'matchId required (max 64)' });
  if (!scorerToken || scorerToken.length < 8)
    return res.status(400).json({ error: 'scorerToken min 8 chars' });

  const tokenKey = `token:${matchId}`;
  const matchKey = `match:${matchId}`;
  const passKey  = `pass:${matchId}`;
  const rateKey  = `rate:${matchId}:${scorerToken.slice(0, 8)}`;
  const listKey  = 'active_matches';

  // Rate limit
  if (await kv.get(rateKey))
    return res.status(429).json({ error: 'Too fast — wait 2s' });

  // Token ownership
  const existing = await kv.get(tokenKey);
  if (existing && existing !== scorerToken)
    return res.status(403).json({ error: 'Match owned by another scorer' });

  if (!existing) {
    // নতুন match register
    await kv.set(tokenKey, scorerToken, { ex: MATCH_TTL });

    // password save (খালি হলেও save করো)
    await kv.set(passKey, password, { ex: MATCH_TTL });

    // active list update
    const list = (await kv.get(listKey)) || [];
    const updated = [...list.filter(id => id !== matchId), matchId].slice(-50);
    await kv.set(listKey, updated, { ex: MATCH_TTL });
  } else {
    await kv.expire(tokenKey, MATCH_TTL);
    await kv.expire(passKey,  MATCH_TTL);
  }

  // Save match data
  const payload = {
    matchId,
    hasPassword: !!password,
    ...sanitize(data),
    updatedAt: Date.now(),
  };
  await kv.set(matchKey, JSON.stringify(payload), { ex: MATCH_TTL });
  await kv.set(rateKey, 1, { ex: RATE_LIMIT });
  await kv.set(`signal:${matchId}`, Date.now(), { ex: 30 });

  return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
}

// ── GET ───────────────────────────────────────
async function handleGet(req, res) {
  const matchId  = req.query.matchId || req.query.match;
  const password = req.query.password || '';

  if (!matchId) return res.status(400).json({ error: 'matchId required' });

  const raw = await kv.get(`match:${matchId}`);
  if (!raw)  return res.status(404).json({ error: 'Not found' });

  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Password check
  if (data.hasPassword) {
    const stored = await kv.get(`pass:${matchId}`);
    if (stored && stored !== password)
      return res.status(401).json({ error: 'password_required' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(data);
}

// ── DELETE — ownership release ─────────────────
async function handleDelete(req, res) {
  const { matchId, scorerToken } = req.body || {};
  if (!matchId || !scorerToken)
    return res.status(400).json({ error: 'matchId + scorerToken required' });

  const existing = await kv.get(`token:${matchId}`);
  if (existing && existing !== scorerToken)
    return res.status(403).json({ error: 'Not your match' });

  // Keys delete
  await kv.del(`token:${matchId}`);
  await kv.del(`pass:${matchId}`);
  await kv.del(`signal:${matchId}`);

  // active list থেকে সরাও
  const list    = (await kv.get('active_matches')) || [];
  const updated = list.filter(id => id !== matchId);
  await kv.set('active_matches', updated, { ex: 6 * 60 * 60 });

  // match data রেখে দাও (result দেখার জন্য) কিন্তু টোকেন মুছে দাও
  return res.status(200).json({ ok: true, released: matchId });
}

// ── Sanitize ──────────────────────────────────
function sanitize({ setup, match, inn1, inn1FullData, screen, resultData }) {
  return {
    setup, match, inn1, inn1FullData,
    screen:     ['setup','scoring','result'].includes(screen) ? screen : 'scoring',
    resultData: resultData || null,
  };
}
