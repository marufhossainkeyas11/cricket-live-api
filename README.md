

# Cricket Live API — Setup Guide

Cricket Score PWA থেকে Vercel-এ live score push করার সম্পূর্ণ guide।

---

## ফোল্ডার স্ট্রাকচার

```
cricket-live-api/
├── api/
│   ├── score.js      ← GET/POST endpoint
│   └── matches.js    ← active match list
├── viewer.html       ← দর্শকদের live page
├── live.js           ← PWA-তে যোগ করার module
├── package.json
└── vercel.json
```

---

## ধাপ ১ — Upstash Redis তৈরি করুন

1. [console.upstash.com](https://console.upstash.com) → **Create Database**
2. Name: যেকোনো নাম দিন, যেমন `cricket-live`
3. Region: **ap-southeast-1 (Singapore)** — বাংলাদেশের কাছে
4. Database তৈরি হলে → **REST API** ট্যাবে যান
5. এই দুটো value কপি করুন:
   ```
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   ```

---

## ধাপ ২ — Vercel-এ Environment Variables সেট করুন

Vercel Dashboard → আপনার project → **Settings → Environment Variables** → দুটো variable যোগ করুন:

```
LIVECS_KV_REST_API_URL    = (Upstash REST URL)
LIVECS_KV_REST_API_TOKEN  = (Upstash REST Token)
```

> ⚠️ নাম হুবহু এভাবেই দিতে হবে — `LIVECS_` prefix সহ।

---

## ধাপ ৩ — Vercel Deploy

```bash
# Terminal এ:
cd cricket-live-api
npm install

# Vercel CLI (না থাকলে):
npm i -g vercel

# Deploy:
vercel

# প্রথমবার কিছু প্রশ্ন করবে:
# - Link to existing project? → N (নতুন)
# - Project name: cricket-live-api
# - Root directory: ./ (Enter)
# - Framework: Other (Enter)
```

Deploy হলে একটা URL পাবেন যেমন:
`https://cricket-live-api-abc123.vercel.app`

---

## ধাপ ৪ — live.js এ URL দিন

`live.js` ফাইলের ২য় লাইন:
```js
const API_BASE = 'https://cricket-live-api-abc123.vercel.app'; // আপনার URL
```

---

## ধাপ ৫ — Cricket Score PWA-তে যোগ করুন

`index.html` এ `app.js` এর পরে:
```html
<script src="./live.js"></script>
```

---

## ব্যবহার

### Scorer (আপনি)
1. Scoring screen এ **📡** button দেখবেন (নিচে ডানে)
2. Click করুন → Panel খুলবে
3. **Match ID** দিন: যেমন `dhaka-vs-ctg-2025` (ইউনিক হতে হবে)
4. **Scorer Token** দিন: যেমন `mySecret123` (অন্তত ৮ অক্ষর, গোপন রাখুন)
5. **Save & Activate** চাপুন
6. **Viewer link** copy করুন → দর্শকদের পাঠান

### দর্শক
- Link খুলুন → 5 সেকেন্ড পরপর auto-refresh
- কোনো install লাগবে না

---

## Multiple Scorers

একই matchId দিয়ে শুধু **একজনই** scorer হতে পারবে।
আলাদা match চললে আলাদা matchId ব্যবহার করুন।

```
dhaka-vs-ctg-match1   ← scorer 1
sylhet-vs-khulna      ← scorer 2
```

**`/viewer.html`** (ম্যাচ ID ছাড়া) সব active match দেখায়।

---

## API Reference

```
POST /api/score
Body: { matchId, scorerToken, setup, match, inn1, inn1FullData, screen }
→ 200: { ok, matchId, viewUrl }
→ 403: অন্য scorer এর match
→ 429: rate limited (২ সেকেন্ড)

GET /api/score?matchId=xxx
→ 200: full match state
→ 404: not found

GET /api/matches
→ 200: { matches: [...] }
```

---

## Free Tier সীমা

| Service        | Free Limit         | যথেষ্ট? |
|---------------|--------------------|--------|
| Upstash Redis | 10,000 req/day     | সীমিত  |
| Upstash Redis | 256MB storage      | হ্যাঁ  |
| Vercel Functions | 100GB/month     | হ্যাঁ  |
