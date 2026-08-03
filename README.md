# RainStreak

Track how many consecutive days it has rained in your area. Enter a US zip code and RainStreak fetches historical weather data from [Open-Meteo](https://open-meteo.com/) to calculate your current rain streak.

## Architecture

- **Backend:** a [Cloudflare Worker](https://developers.cloudflare.com/workers/) ([src/index.js](src/index.js)) serving `/api/streak/:zip` and `/api/leaderboard`, backed by a [D1](https://developers.cloudflare.com/d1/) database for caching and the leaderboard. A Cron Trigger fires every 5 minutes and refreshes the next 20 seed zips in rotation (see "Seed rotation" below).
- **Frontend:** a single static file, [public/index.html](public/index.html), that calls the Worker's API. It can be served from anywhere — including pasted directly into a Squarespace page — as long as `API_BASE` in its `<script>` points at your deployed Worker.

Both live on Cloudflare's free tier: no cold starts, no sleeping, no card required, and no monthly bill for a project at this scale.

## First-time setup

Requires **Node.js 22+** (Wrangler's minimum) — check with `node -v` and upgrade if needed.

```bash
npm install
npx wrangler login          # opens a browser to authorize your Cloudflare account

npx wrangler d1 create rainstreak-db
# copy the printed database_id into wrangler.toml (replace REPLACE_WITH_YOUR_DATABASE_ID)

npm run db:migrate:remote    # creates the streaks/meta tables in the live D1 database
npm run db:migrate:local     # (optional) same, for local `wrangler dev` testing

npm run deploy               # publishes the Worker; prints your *.workers.dev URL
```

Paste the printed Worker URL into `API_BASE` near the top of the `<script>` block in [public/index.html](public/index.html).

## Local development

```bash
npm run dev
```

Runs the Worker locally via Wrangler (against the local D1 replica from `db:migrate:local`). Open `public/index.html` directly in a browser with `API_BASE` pointed at `http://localhost:8787` to test end-to-end.

## Hosting the frontend on Squarespace

`public/index.html` is one file but maps to two different Squarespace slots — don't paste the whole thing into one Code Block, since that drags along a stray `</head>` and a nested `<body>` that belong to the file's own document shell, not Squarespace's.

1. Deploy the Worker (above) and confirm `API_BASE` in `public/index.html` points at it.
2. On the target page, open **Page Settings → Advanced → Page Header Code Injection** and paste just these two head-appropriate pieces (lines 7 and 8–20 of the file):
   ```html
   <script src="https://cdn.tailwindcss.com"></script>
   <style>
     @keyframes fall { from { transform: translateY(-80px); } to { transform: translateY(110vh); } }
     .drop { position: fixed; top: 0; width: 1.5px; border-radius: 999px; background: linear-gradient(to bottom, transparent, #7dd3fc); animation: fall linear infinite; pointer-events: none; will-change: transform; }
     ::-webkit-scrollbar { width: 5px; }
     ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
   </style>
   ```
3. Add a **Code Block** to the page body and paste everything from `<div id="rain" ...>` through the final `</script>` — i.e. lines 24–198, the actual markup and the inline script. Do not include `<!DOCTYPE html>`, `<html>`, `<head>`, `</head>`, `<body>`, `</body>`, or `</html>` — Squarespace supplies those itself.
4. Save and publish. The Worker already sends permissive CORS headers (`Access-Control-Allow-Origin: *`), so requests from your Squarespace domain will succeed without extra configuration.
5. If you'd rather keep the API restricted to your own domain, change `CORS_HEADERS` in [src/index.js](src/index.js) from `'*'` to your Squarespace site's URL and redeploy.

## Seed rotation

`city-zips.js` lists ~700 representative US zip codes that keep the leaderboard populated. Each zip needs 2 outbound fetches (geocode + weather), and Workers on Cloudflare's free plan cap a single invocation at 50 outbound subrequests — so refreshing all ~700 zips can't happen in one shot. Instead, `refreshNextBatch` in [src/index.js](src/index.js) advances a cursor (stored in D1's `meta` table) and refreshes 20 zips per tick; the Cron Trigger fires every 5 minutes, so a full pass takes roughly 3 hours. Cached entries expire after 6 hours, so this comfortably keeps the seed list fresh. Zips a visitor searches directly are computed and cached on demand via `/api/streak/:zip`, independent of this rotation.

### Manually triggering a refresh batch

Useful right after first deploying, when the seed list hasn't rotated through yet:

```bash
curl -X POST -H "x-refresh-secret: <your secret>" https://<your-worker>.workers.dev/api/admin/refresh
```

Each call advances the rotation by one batch (20 zips), same as one cron tick. The secret is set via `npx wrangler secret put REFRESH_SECRET` (not stored in this repo) — without a matching header the endpoint returns 401.
