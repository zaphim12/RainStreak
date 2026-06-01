const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');
const TTL = 6 * 60 * 60 * 1000; // 6 hours

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { streaks: {} }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data));
}

function getStreak(zip) {
  const entry = readDB().streaks[zip];
  if (!entry) return null;
  if (Date.now() - new Date(entry.ts).getTime() >= TTL) return null;
  return entry;
}

function saveStreak(entry) {
  const db = readDB();
  db.streaks[entry.zip] = entry;
  writeDB(db);
}

function getLeaderboard() {
  return Object.values(readDB().streaks)
    .sort((a, b) => b.streak - a.streak || new Date(b.ts) - new Date(a.ts))
    .slice(0, 10);
}

module.exports = { getStreak, saveStreak, getLeaderboard };
