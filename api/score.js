/**
 * POST /api/score  — scorer পাঠাবে
 * GET  /api/score  — একবার fetch (fallback)
 */

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url:   process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

const MATCH_TTL  = 6 * 60 * 60;  // 6 ঘণ্টা
const RATE_LIMIT = 2;             // সেকেন্ড

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'GET')  return await handleGet(req, res);
    return res.status(405).end();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

// ── POST ──────────────────────────────────────
async function handlePost(req, res) {
  const { matchId, scorerToken, ...data } = req.body || {};

  if (!matchId || matchId.length > 64)
    return res.status(400).json({ error: 'matchId required (max 64)' });
  if (!scorerToken || scorerToken.length < 8)
    return res.status(400).json({ error: 'scorerToken min 8 chars' });

  const tokenKey = `token:${matchId}`;
  const matchKey = `match:${matchId}`;
  const rateKey  = `rate:${matchId}:${scorerToken.slice(0,8)}`;

  // Rate limit
  if (await kv.get(rateKey))
    return res.status(429).json({ error: 'Too fast' });

  // Token check — FIX: token TTL আলাদা, MATCH_TTL এ expire
  const existing = await kv.get(tokenKey);
  if (existing && existing !== scorerToken)
    return res.status(403).json({ error: 'Match owned by another scorer' });

  // প্রথমবার হলে register
  if (!existing) {
    await kv.set(tokenKey, scorerToken, { ex: MATCH_TTL });
  } else {
    // প্রতিবার TTL refresh — যতক্ষণ push হচ্ছে token টিকে থাকবে
    await kv.expire(tokenKey, MATCH_TTL);
  }

  // Data save
  const payload = {
    matchId,
    ...sanitize(data),
    updatedAt: Date.now(),
  };
  await kv.set(matchKey, JSON.stringify(payload), { ex: MATCH_TTL });

  // Rate limit — শুধু 2 সেকেন্ড
  await kv.set(rateKey, 1, { ex: RATE_LIMIT });

  // SSE listener দের জন্য "নতুন data আছে" signal
  await kv.set(`signal:${matchId}`, Date.now(), { ex: 30 });

  return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
}

// ── GET (fallback) ────────────────────────────
async function handleGet(req, res) {
  const matchId = req.query.matchId || req.query.match;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });

  const raw = await kv.get(`match:${matchId}`);
  if (!raw) return res.status(404).json({ error: 'Not found' });

  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(data);
}

// ── Sanitize ──────────────────────────────────
function sanitize({ setup, match, inn1, inn1FullData, screen, resultData }) {
  return {
    setup:       setup       || null,
    match:       match       || null,
    inn1:        inn1        || null,
    inn1FullData: inn1FullData || null,
    screen:      ['setup','scoring','result'].includes(screen) ? screen : 'scoring',
    resultData:  resultData  || null,
  };
}
