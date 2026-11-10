const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    return { users: [], movies: [], seasons: [], episodes: [], purchases: [], topups: [], vip_requests: [], admins: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getCurrentUser(req, db) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '') || req.query.token;
  if (!token) return db.users[0] || null;
  const userId = token.replace('token_', '');
  return db.users.find(u => String(u.id) === String(userId)) || db.users[0] || null;
}

module.exports = { readDB, writeDB, getCurrentUser };
