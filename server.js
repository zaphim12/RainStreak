const express = require('express');
const path = require('path');
const { getStreak, saveStreak, getLeaderboard, getAllZips, setLastRefresh, getLastRefresh } = require('./db');
const CITY_ZIPS = require('./city-zips');

const MIN_MM = 1.0;
const PORT = process.env.PORT || 3000;

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

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/streak/:zip', async (req, res) => {
  const { zip } = req.params;
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Invalid zip code.' });

  const cached = getStreak(zip);
  if (cached) return res.json(cached);

  try {
    const entry = await computeStreak(zip);
    saveStreak(entry);
    res.json(entry);
  } catch (e) {
    if (e.code === 'NF') return res.status(404).json({ error: 'Zip code not found.', code: 'NF' });
    if (e.code === 'WX') return res.status(502).json({ error: 'Weather data unavailable.', code: 'WX' });
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  res.json(getLeaderboard(limit, offset));
});

async function refreshAll() {
  const zips = [...new Set([...CITY_ZIPS, ...getAllZips()])];
  console.log(`Daily refresh: updating ${zips.length} ZIP codes...`);
  for (const zip of zips) {
    await new Promise(r => setTimeout(r, 400));
    try { saveStreak(await computeStreak(zip)); } catch { /* skip */ }
  }
  setLastRefresh(new Date().toISOString());
  console.log('Daily refresh complete.');
}

function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(6, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    refreshAll();
    setInterval(refreshAll, 24 * 60 * 60 * 1000);
  }, next - now);
}

app.listen(PORT, () => {
  console.log(`RainStreak running on http://localhost:${PORT}`);
  scheduleDailyRefresh();
  // Run immediately on startup if no refresh has happened in the last 23 hours
  const last = getLastRefresh();
  if (!last || Date.now() - new Date(last).getTime() >= 23 * 60 * 60 * 1000) {
    refreshAll();
  }
});
