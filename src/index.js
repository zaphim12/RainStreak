import CITY_ZIPS from '../city-zips.js';

const MIN_MM = 1.0;
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CONCURRENCY = 8;
// Zips refreshed per tick. Each zip costs 2 outbound fetches (geocode + weather),
// and Workers on the free plan cap a single invocation at 50 subrequests total —
// 20 zips = 40 fetches, leaving headroom under that ceiling.
const SEED_BATCH_SIZE = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function computeStreak(zip) {
  const geoRes = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (geoRes.status === 404) { const e = new Error('NF'); e.code = 'NF'; throw e; }
  if (!geoRes.ok) throw new Error('geo failed');
  const geoData = await geoRes.json();
  const place = geoData.places[0];
  const lat = +place.latitude, lon = +place.longitude;
  const city = place['place name'], state = place['state abbreviation'];

  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(); start.setUTCDate(start.getUTCDate() - 61);
  const fmt = d => d.toISOString().slice(0, 10);
  const wxUrl =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${fmt(start)}&end_date=${fmt(end)}` +
    `&daily=precipitation_sum&timezone=auto`;
  const wxRes = await fetch(wxUrl);
  if (!wxRes.ok) { const e = new Error('WX'); e.code = 'WX'; throw e; }
  const wx = await wxRes.json();

  const days = wx.daily.time.map((t, i) => ({ t, mm: wx.daily.precipitation_sum[i] }));
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].mm != null && days[i].mm >= MIN_MM) streak++;
    else break;
  }

  return { zip, city, state, streak, ts: new Date().toISOString() };
}

async function getStreak(db, zip) {
  const row = await db.prepare('SELECT * FROM streaks WHERE zip = ?').bind(zip).first();
  if (!row) return null;
  if (Date.now() - new Date(row.ts).getTime() >= TTL_MS) return null;
  return row;
}

async function saveStreak(db, entry) {
  await db.prepare(
    `INSERT INTO streaks (zip, city, state, streak, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(zip) DO UPDATE SET city = excluded.city, state = excluded.state,
       streak = excluded.streak, ts = excluded.ts`
  ).bind(entry.zip, entry.city, entry.state, entry.streak, entry.ts).run();
}

async function getLeaderboard(db, limit, offset) {
  const { results } = await db.prepare(
    'SELECT * FROM streaks ORDER BY streak DESC, ts DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  const { total } = await db.prepare('SELECT COUNT(*) AS total FROM streaks').first();
  return { entries: results, total };
}

async function setLastRefresh(db, ts) {
  await db.prepare(
    `INSERT INTO meta (key, value) VALUES ('lastRefresh', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(ts).run();
}

async function getCursor(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'refreshCursor'").first();
  return row ? parseInt(row.value, 10) : 0;
}

async function setCursor(db, cursor) {
  await db.prepare(
    `INSERT INTO meta (key, value) VALUES ('refreshCursor', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(String(cursor)).run();
}

// Rotates through CITY_ZIPS a bounded slice at a time (see SEED_BATCH_SIZE) so each
// invocation stays under the free-plan subrequest cap. Called by the cron trigger
// and by the manual admin endpoint; a full pass over all seed zips takes multiple ticks.
async function refreshNextBatch(db) {
  const cursor = await getCursor(db);
  const zips = Array.from({ length: SEED_BATCH_SIZE },
    (_, i) => CITY_ZIPS[(cursor + i) % CITY_ZIPS.length]);

  for (let i = 0; i < zips.length; i += CONCURRENCY) {
    const chunk = zips.slice(i, i + CONCURRENCY);
    await Promise.allSettled(chunk.map(async zip => {
      try { await saveStreak(db, await computeStreak(zip)); } catch { /* skip unresolvable/failed zips */ }
    }));
  }

  const nextCursor = (cursor + SEED_BATCH_SIZE) % CITY_ZIPS.length;
  await setCursor(db, nextCursor);
  if (nextCursor < cursor) await setLastRefresh(db, new Date().toISOString());
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/admin/refresh' && request.method === 'POST') {
      if (!env.REFRESH_SECRET || request.headers.get('x-refresh-secret') !== env.REFRESH_SECRET) {
        return json({ error: 'Unauthorized.' }, 401);
      }
      ctx.waitUntil(refreshNextBatch(env.DB));
      return json({ status: 'Refresh batch started.' }, 202);
    }

    const streakMatch = url.pathname.match(/^\/api\/streak\/(\d{5})$/);
    if (streakMatch) {
      const zip = streakMatch[1];
      const cached = await getStreak(env.DB, zip);
      if (cached) return json(cached);

      try {
        const entry = await computeStreak(zip);
        await saveStreak(env.DB, entry);
        return json(entry);
      } catch (e) {
        if (e.code === 'NF') return json({ error: 'Zip code not found.', code: 'NF' }, 404);
        if (e.code === 'WX') return json({ error: 'Weather data unavailable.', code: 'WX' }, 502);
        return json({ error: 'Something went wrong.' }, 500);
      }
    }
    if (url.pathname.startsWith('/api/streak/') || url.pathname === '/api/streak') {
      return json({ error: 'Invalid zip code.' }, 400);
    }

    if (url.pathname === '/api/leaderboard') {
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 10, 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset')) || 0, 0);
      return json(await getLeaderboard(env.DB, limit, offset));
    }

    return json({ error: 'Not found.' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshNextBatch(env.DB));
  },
};
