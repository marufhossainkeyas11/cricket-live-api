import { Redis } from '@upstash/redis';
const kv = new Redis({
  url:   process.env.LIVECS_KV_REST_API_URL,
  token: process.env.LIVECS_KV_REST_API_TOKEN,
});
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const ids = (await kv.get('active_matches')) || [];
    if (!ids.length) return res.status(200).json({ matches: [] });
    const pipeline = kv.pipeline();
    ids.forEach(id => pipeline.get(`match:${id}`));
    const results = await pipeline.exec();
    const matches = [];
    ids.forEach((id, i) => {
      let d = results[i];
      if (!d) return;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      if (!d.setup) return;
      const m = d.match;
      const s = d.setup;
      matches.push({
        matchId:     id,
        teamA:       s.teamA || s.team1 || '?',
        teamB:       s.teamB || s.team2 || '?',
        overs:       s.overs,
        innings:     m?.innings || 1,
        score:       m ? `${m.runs}/${m.wickets}` : '0/0',
        done:        m?.done || false,
        hasPassword: !!d.hasPassword,
        updatedAt:   d.updatedAt,
      });
    });
    matches.sort((a, b) => b.updatedAt - a.updatedAt);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ matches });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
