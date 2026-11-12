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

// Record a balance-changing event in the user's transaction history
// type: 'TOPUP' | 'MOVIE_PURCHASE' | 'VIP_PURCHASE'
// amount: positive for TOPUP, negative for spending entries
function recordTransaction(db, { userId, telegramId, type, title, amount, status = 'COMPLETED', billNo = null }) {
  db.transactions = db.transactions || [];
  db.transactions.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    billNo: billNo || null,
    userId: userId,
    telegram_id: telegramId != null ? String(telegramId) : null,
    type: type,
    title: title,
    amount: +parseFloat(amount || 0).toFixed(2),
    direction: parseFloat(amount) >= 0 ? 'IN' : 'OUT',
    status: status,
    createdAt: new Date().toISOString()
  });
}

module.exports = { readDB, writeDB, getCurrentUser, recordTransaction };
