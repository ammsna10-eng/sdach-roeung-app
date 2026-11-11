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
  const user = (!token) ? (db.users[0] || null) : ((db.users.find(u => String(u.id) === String(token.replace('token_', '')))) || db.users[0] || null);
  if (user && user.is_vip && user.vip_expires_at) {
    if (new Date(user.vip_expires_at).getTime() < Date.now()) {
      user.is_vip = false;
      writeDB(db);
    }
  }
  return user;
}

module.exports = { readDB, writeDB, getCurrentUser };
