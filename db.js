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

function getLeaderboard(limit = 10, offset = 0) {
  const all = Object.values(readDB().streaks)
    .sort((a, b) => b.streak - a.streak || new Date(b.ts) - new Date(a.ts));
  return { entries: all.slice(offset, offset + limit), total: all.length };
}

function getAllZips() {
  return Object.keys(readDB().streaks);
}

function setLastRefresh(ts) {
  const db = readDB();
  db.lastRefresh = ts;
  writeDB(db);
}

function getLastRefresh() {
  return readDB().lastRefresh || null;
}

module.exports = { getStreak, saveStreak, getLeaderboard, getAllZips, setLastRefresh, getLastRefresh };
