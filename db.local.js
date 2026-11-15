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

// ZERO-TRUST: resolve the caller strictly by its cryptographically random
// session_token (Bearer header or ?token=). Never trust user_id/telegram_id
// query/body params and never fall back to db.users[0].
function getCurrentUser(req, db) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  if (!token && req.query && req.query.token) token = String(req.query.token).trim();
  if (!token) return null;
  const user = (db.users || []).find(u => u && u.session_token && String(u.session_token) === token) || null;
  if (!user) return null;
  if (user.session_expires_at && new Date(user.session_expires_at).getTime() < Date.now()) return null;
  if (user.is_vip && user.vip_expires_at) {
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
