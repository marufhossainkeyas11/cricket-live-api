import { Redis } from '@upstash/redis';
const kv = new Redis({
  url: process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

const MATCH_TTL_SEC  = 6 * 60 * 60;
const MAX_MATCHES    = 20;
const RATE_LIMIT_SEC = 2;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'GET')  return await handleGet(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[score]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function handlePost(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object')
    return res.status(400).json({ error: 'Invalid body' });

  const { matchId, scorerToken, setup, match, inn1, inn1FullData, screen, resultData } = body;

  if (!matchId || typeof matchId !== 'string' || matchId.length > 64)
    return res.status(400).json({ error: 'matchId required (max 64 chars)' });
  if (!scorerToken || typeof scorerToken !== 'string' || scorerToken.length < 8)
    return res.status(400).json({ error: 'scorerToken required (min 8 chars)' });

  const matchKey = `match:${matchId}`;
  const tokenKey = `token:${matchId}`;
  const rateKey  = `rate:${matchId}`;  // ✅ FIX 1: token-নির্ভর নয়, matchId-নির্ভর

  // Rate limit
  const rateLimited = await kv.get(rateKey);
  if (rateLimited)
    return res.status(429).json({ error: 'Too fast — wait 2 seconds' });

  // Token ownership
  const existingToken = await kv.get(tokenKey);
  if (existingToken && existingToken !== scorerToken)
    return res.status(403).json({ error: 'Match already owned by another scorer' });

  // নতুন match
  if (!existingToken) {
    const activeList = (await kv.get('active_matches')) || [];
    if (activeList.length >= MAX_MATCHES)
      return res.status(503).json({ error: 'Server full' });

    const updated = [...activeList.filter(id => id !== matchId), matchId];
    // ✅ FIX 2: active_matches TTL longer করো যাতে match চলাকালে expire না করে
    await kv.set('active_matches', updated, { ex: MATCH_TTL_SEC + 3600 });
    await kv.set(tokenKey, scorerToken, { ex: MATCH_TTL_SEC });
  } else {
    // ✅ FIX 3: প্রতি push-এ token TTL refresh
    await kv.expire(tokenKey, MATCH_TTL_SEC);
  }

  const payload = {
    matchId,
    setup:        sanitizeSetup(setup),
    match:        sanitizeMatch(match),
    inn1:         inn1          || null,
    inn1FullData: inn1FullData  || null,
    screen:       ['setup', 'scoring', 'result'].includes(screen) ? screen : 'scoring',
    resultData:   resultData    || null,
    updatedAt:    Date.now(),
    version:      1,
  };

  // ✅ FIX 4: match data আর rate limit একসাথে set
  await Promise.all([
    kv.set(matchKey, payload, { ex: MATCH_TTL_SEC }),
    kv.set(rateKey, 1, { ex: RATE_LIMIT_SEC }),
  ]);

  return res.status(200).json({
    ok: true,
    matchId,
    viewUrl: `/viewer.html?match=${encodeURIComponent(matchId)}`,
    updatedAt: payload.updatedAt,
  });
}

async function handleGet(req, res) {
  const matchId = req.query.matchId || req.query.match;
  if (!matchId)
    return res.status(400).json({ error: 'matchId required' });

  const data = await kv.get(`match:${matchId}`);
  if (!data)
    return res.status(404).json({ error: 'Match not found or expired' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(data);
}
