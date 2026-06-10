/**
 * GET /api/matches — সব active matches এর list
 * Viewer landing page এ দেখাবে
 */

import { Redis } from '@upstash/redis';
const kv = new Redis({
  url: process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const activeIds = (await kv.get('active_matches')) || [];
    if (!activeIds.length) {
      return res.status(200).json({ matches: [] });
    }

    // সব match এর basic info এক সাথে fetch (pipeline)
    const pipeline = kv.pipeline();
    activeIds.forEach(id => pipeline.get(`match:${id}`));
    const results = await pipeline.exec();

    const matches = [];
    activeIds.forEach((id, i) => {
      const d = results[i];
      if (!d || !d.setup) return; // expired বা invalid

      const m = d.match;
      const s = d.setup;
      matches.push({
        matchId:     id,
        teamA:       s.teamA || s.team1 || '?',
        teamB:       s.teamB || s.team2 || '?',
        overs:       s.overs,
        innings:     m?.innings || 1,
        score:       m ? `${m.runs}/${m.wickets}` : '0/0',
        balls:       m?.balls || 0,
        done:        m?.done || false,
        screen:      d.screen || 'scoring',
        updatedAt:   d.updatedAt,
      });
    });

    // সর্বশেষ আপডেট হওয়া আগে দেখাও
    matches.sort((a, b) => b.updatedAt - a.updatedAt);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ matches });
  } catch (err) {
    console.error('[matches]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
