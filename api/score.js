/**
 * Cricket Live Score API — /api/score
 *
 * POST /api/score   → scorer পাঠাবে match data
 * GET  /api/score   → viewer / দর্শক পড়বে
 *
 * Storage: Vercel KV (Redis) — free tier যথেষ্ট
 * Match TTL: 6 ঘণ্টা (match শেষে auto-expire)
 */

import { Redis } from '@upstash/redis';
const kv = new Redis({
  url: process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

// ── Config ────────────────────────────────────────────────────────────────────
const MATCH_TTL_SEC  = 6 * 60 * 60;   // 6 ঘণ্টা
const MAX_MATCHES    = 20;             // একসাথে সর্বোচ্চ active matches
const RATE_LIMIT_SEC = 2;             // প্রতি scorer min interval (সেকেন্ড)

// ── CORS headers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Match-Id, X-Scorer-Token');
  return res;
}

// ── Main handler ──────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  POST — scorer app থেকে data আসে
// ─────────────────────────────────────────────────────────────────────────────
async function handlePost(req, res) {
  const body = req.body;

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const { matchId, scorerToken, setup, match, inn1, inn1FullData, screen } = body;

  if (!matchId || typeof matchId !== 'string' || matchId.length > 64) {
    return res.status(400).json({ error: 'matchId required (max 64 chars)' });
  }
  if (!scorerToken || typeof scorerToken !== 'string' || scorerToken.length < 8) {
    return res.status(400).json({ error: 'scorerToken required (min 8 chars)' });
  }

  const matchKey  = `match:${matchId}`;
  const tokenKey  = `token:${matchId}`;
  const rateKey   = `rate:${matchId}:${scorerToken}`;

  // ── Rate limit: একই scorer ২ সেকেন্ডে একবারের বেশি পাঠাতে পারবে না ─────
  const rateLimited = await kv.get(rateKey);
  if (rateLimited) {
    return res.status(429).json({ error: 'Too fast — wait 2 seconds' });
  }

  // ── Token ownership check ─────────────────────────────────────────────────
  // প্রথম POST → token register হয়
  // পরের POST → same token না হলে reject
  const existingToken = await kv.get(tokenKey);
  if (existingToken && existingToken !== scorerToken) {
    return res.status(403).json({ error: 'Match already owned by another scorer' });
  }

  // ── Max active matches cap ────────────────────────────────────────────────
  if (!existingToken) {
    const activeList = (await kv.get('active_matches')) || [];
    if (activeList.length >= MAX_MATCHES) {
      return res.status(503).json({ error: 'Server full — max active matches reached' });
    }
    // নতুন match register
    const updated = [...activeList.filter(id => id !== matchId), matchId];
    await kv.set('active_matches', updated, { ex: MATCH_TTL_SEC });
    await kv.set(tokenKey, scorerToken, { ex: MATCH_TTL_SEC });
  }

  // ── Sanitize & store ──────────────────────────────────────────────────────
  const payload = {
    matchId,
    setup:       sanitizeSetup(setup),
    match:       sanitizeMatch(match),
    inn1:        inn1         || null,
    inn1FullData: inn1FullData || null,
    screen:      ['setup', 'scoring', 'result'].includes(screen) ? screen : 'scoring',
    updatedAt:   Date.now(),
    version:     1,
  };

  await kv.set(matchKey, payload, { ex: MATCH_TTL_SEC });

  // Rate limit set করো
  await kv.set(rateKey, 1, { ex: RATE_LIMIT_SEC });

  // Token TTL refresh
  await kv.expire(tokenKey, MATCH_TTL_SEC);

  return res.status(200).json({
    ok: true,
    matchId,
    viewUrl: `/viewer.html?match=${encodeURIComponent(matchId)}`,
    updatedAt: payload.updatedAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET — দর্শক / viewer পড়বে
// ─────────────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const matchId = req.query.matchId || req.query.match;

  if (!matchId) {
    return res.status(400).json({ error: 'matchId query param required' });
  }

  const data = await kv.get(`match:${matchId}`);
  if (!data) {
    return res.status(404).json({ error: 'Match not found or expired' });
  }

  // Viewer কে full data দাও, শুধু scorerToken বাদে
  const { ...safe } = data;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(safe);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sanitizers — শুধু যা দরকার তাই রাখো, excess data বাদ দাও
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeSetup(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    team1:      String(s.team1      || '').slice(0, 20),
    team2:      String(s.team2      || '').slice(0, 20),
    teamA:      String(s.teamA      || '').slice(0, 20),
    teamB:      String(s.teamB      || '').slice(0, 20),
    overs:      Math.min(Math.max(parseInt(s.overs) || 20, 1), 100),
    players:    Math.min(Math.max(parseInt(s.players) || 11, 2), 22),
    batFirst:   String(s.batFirst   || '').slice(0, 20),
    byeAllowed: Boolean(s.byeAllowed),
    lastMan:    Boolean(s.lastMan),
    shortCric:  Boolean(s.shortCric),
    batNames:   sanitizeNames(s.batNames),
    bowlNames:  sanitizeNames(s.bowlNames),
  };
}

function sanitizeMatch(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    innings:     parseInt(m.innings)  || 1,
    battingTeam: String(m.battingTeam || '').slice(0, 20),
    runs:        Math.max(parseInt(m.runs)    || 0, 0),
    wickets:     Math.min(Math.max(parseInt(m.wickets) || 0, 0), 10),
    balls:       Math.max(parseInt(m.balls)   || 0, 0),
    extras:      sanitizeExtras(m.extras),
    curOver:     Array.isArray(m.curOver)  ? m.curOver.slice(0, 10)  : [],
    doneOvers:   Array.isArray(m.doneOvers) ? m.doneOvers.slice(0, 100) : [],
    striker:     parseInt(m.striker)     ?? 0,
    nonStriker:  parseInt(m.nonStriker)  ?? 1,
    bat:         sanitizeBat(m.bat),
    bowlOrder:   sanitizeNames(m.bowlOrder),
    bowlMap:     sanitizeBowlMap(m.bowlMap),
    curBowler:   String(m.curBowler  || '').slice(0, 20) || null,
    prevBowler:  String(m.prevBowler || '').slice(0, 20) || null,
    needBowler:  Boolean(m.needBowler),
    needBatsmen: Boolean(m.needBatsmen),
    done:        Boolean(m.done),
  };
}

function sanitizeExtras(e) {
  if (!e || typeof e !== 'object') return { wide: 0, noball: 0, bye: 0, legbye: 0 };
  return {
    wide:   Math.max(parseInt(e.wide)   || 0, 0),
    noball: Math.max(parseInt(e.noball) || 0, 0),
    bye:    Math.max(parseInt(e.bye)    || 0, 0),
    legbye: Math.max(parseInt(e.legbye) || 0, 0),
  };
}

function sanitizeNames(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 22).map(n => String(n || '').slice(0, 20));
}

function sanitizeBat(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 22).map(b => ({
    name:  String(b.name  || '').slice(0, 20),
    runs:  Math.max(parseInt(b.runs)  || 0, 0),
    balls: Math.max(parseInt(b.balls) || 0, 0),
    fours: Math.max(parseInt(b.fours) || 0, 0),
    sixes: Math.max(parseInt(b.sixes) || 0, 0),
    out:   Boolean(b.out),
    howOut: String(b.howOut || '').slice(0, 30),
    notYet: Boolean(b.notYet),
  }));
}

function sanitizeBowlMap(map) {
  if (!map || typeof map !== 'object') return {};
  const out = {};
  const keys = Object.keys(map).slice(0, 22);
  for (const k of keys) {
    const b = map[k];
    if (!b) continue;
    out[k.slice(0, 20)] = {
      balls:   Math.max(parseInt(b.balls)   || 0, 0),
      runs:    Math.max(parseInt(b.runs)    || 0, 0),
      wickets: Math.max(parseInt(b.wickets) || 0, 0),
      wides:   Math.max(parseInt(b.wides)   || 0, 0),
      noballs: Math.max(parseInt(b.noballs) || 0, 0),
    };
  }
  return out;
}
