const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readDB, writeDB, getCurrentUser } = require('../db');
const { logSecurityEvent, clientIp } = require('../services/security');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'public', 'storage', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  }
});
const upload = multer({ storage });

// Never echo internal session credentials back in user payloads
function publicUser(u) {
  if (!u) return u;
  const { session_token, session_expires_at, ...safe } = u;
  return safe;
}

// ============================================================
// TELEGRAM initData CRYPTOGRAPHIC VERIFICATION (HMAC-SHA256)
// Official algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ============================================================
function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string' || !initData.trim()) return null;
  if (!botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of params.entries()) {
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    // Replay protection: auth_date must not be older than 24h
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    const tgUser = JSON.parse(userStr);
    if (!tgUser || !tgUser.id) return null;
    return tgUser;
  } catch (e) {
    return null;
  }
}

router.post('/telegram-login', (req, res) => {
  const db = readDB();
  const ip = clientIp(req);
  const initData = (req.body && req.body.initData) || '';
  const botToken = process.env.BOT_TOKEN || (db.settings && db.settings.bot_token) || '';

  let telegramUser = verifyTelegramInitData(initData, botToken);

  // Explicit opt-in dev bypass ONLY (never enabled by default)
  if (!telegramUser && process.env.ALLOW_DEV_LOGIN === 'true') {
    try {
      telegramUser = JSON.parse(new URLSearchParams(initData).get('user') || 'null');
    } catch (e) {}
    if (!telegramUser) {
      telegramUser = { id: 1, first_name: 'DevUser', username: 'dev_user', photo_url: '/storage/logo/logo.png' };
    }
  }

  if (!telegramUser) {
    logSecurityEvent(db, 'FAKE_INIT_DATA', {
      user_id: null,
      user_name: '',
      ip,
      details: 'Rejected login: missing/invalid initData HMAC-SHA256 signature or expired auth_date'
    });
    return res.status(401).json({ message: 'Unauthorized: invalid Telegram initData' });
  }

  let user = db.users.find(u => String(u.telegram_id) === String(telegramUser.id));
  let created = false;
  if (!user) {
    user = {
      id: telegramUser.id,
      telegram_id: String(telegramUser.id),
      first_name: telegramUser.first_name || 'User',
      last_name: telegramUser.last_name || '',
      username: telegramUser.username || '',
      photo_url: telegramUser.photo_url || null,
      wallet_balance: 0.0,
      is_vip: false,
      vip_expires_at: null,
      role: 'user',
      created_at: new Date().toISOString()
    };
    db.users.push(user);
    created = true;
  } else {
    // Update live profile info from Telegram (photo, names, username)
    if (telegramUser.first_name && user.first_name !== telegramUser.first_name) {
      user.first_name = telegramUser.first_name;
    }
    if (telegramUser.last_name !== undefined && user.last_name !== telegramUser.last_name) {
      user.last_name = telegramUser.last_name;
    }
    if (telegramUser.username !== undefined && user.username !== telegramUser.username) {
      user.username = telegramUser.username;
    }
    if (telegramUser.photo_url && user.photo_url !== telegramUser.photo_url) {
      user.photo_url = telegramUser.photo_url;
    }
  }

  // Cryptographically unpredictable session token (64 hex chars, 30-day expiry)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  user.session_token = sessionToken;
  user.session_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  writeDB(db);

  res.json({
    token: sessionToken,
    user: publicUser(user),
    wallet_balance: parseFloat(user.wallet_balance || 0),
    is_vip: Boolean(user.is_vip),
    vip_expires_at: user.vip_expires_at
  });
});

router.get('/me', (req, res) => {
  const db = readDB();
  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const purchases = (db.purchases || []).filter(p => String(p.user_id) === String(user.id));
  const purchasedMovies = purchases.filter(p => p.movie_id && !p.episode_id)
    .map(p => db.movies.find(m => String(m.id) === String(p.movie_id))).filter(Boolean);
  const purchasedEpisodes = purchases.filter(p => p.episode_id).map(p => ({ id: p.episode_id }));

  res.json({ user: publicUser(user), purchased_movies: purchasedMovies, purchased_episodes: purchasedEpisodes });
});

router.get('/transactions/history', (req, res) => {
  const db = readDB();
  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const uid = String(user.id);
  const tgid = String(user.telegram_id || '');
  const isMine = (t) => String(t.userId ?? t.user_id) === uid || (t.telegram_id && String(t.telegram_id) === tgid);

  const merged = [];
  const seenKeys = new Set();

  // 1) Newly recorded transactions (source of truth going forward)
  for (const t of (db.transactions || [])) {
    if (!isMine(t)) continue;
    merged.push(t);
    if (t.billNo) seenKeys.add(String(t.billNo));
  }

  // 2) Legacy backfill (pre-history data), deduped by billNo
  for (const p of (db.purchases || [])) {
    const key = 'P' + p.id;
    if (!isMine(p) || seenKeys.has(key)) continue;
    const movie = (db.movies || []).find(m => String(m.id) === String(p.movie_id));
    merged.push({
      id: key, billNo: key, userId: p.user_id,
      type: 'MOVIE_PURCHASE',
      title: 'ទិញរឿង: ' + (movie?.title_kh || movie?.title_en || p.movie_id),
      amount: -Math.abs(parseFloat(p.amount) || 0),
      direction: 'OUT', status: 'COMPLETED',
      createdAt: p.created_at
    });
    seenKeys.add(key);
  }
  for (const tx of [...(db.bakong_transactions || []), ...(db.aba_transactions || [])]) {
    if (tx.status !== 'completed' && tx.status !== 'PAID') continue;
    const key = tx.bill_no || tx.tran_id;
    if (!isMine(tx) || seenKeys.has(key)) continue;
    merged.push({
      id: key, billNo: key, userId: tx.user_id,
      type: tx.type === 'vip' ? 'VIP_PURCHASE' : 'TOPUP',
      title: tx.type === 'vip' ? 'ទិញកញ្ចប់ VIP ប្រចាំខែ' : 'បញ្ចូលទឹកប្រាក់ KHQR',
      amount: tx.type === 'vip' ? -Math.abs(parseFloat(tx.amount) || 0) : Math.abs(parseFloat(tx.amount) || 0),
      direction: tx.type === 'vip' ? 'OUT' : 'IN', status: 'PAID',
      createdAt: tx.completed_at || tx.created_at
    });
    seenKeys.add(key);
  }

  merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({
    transactions: merged,
    wallet_balance: parseFloat(user.wallet_balance || 0),
    is_vip: Boolean(user.is_vip),
    vip_expires_at: user.vip_expires_at || null
  });
});

router.get('/user/topup-packages', (req, res) => {
  res.json(readDB().topup_packages || []);
});

router.post('/user/topup-request', upload.single('screenshot'), (req, res) => {
  const db = readDB();
  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });
  const packageId = parseInt(req.body.package_id);
  const pkg = (db.topup_packages || []).find(p => p.id === packageId);

  const topup = {
    id: Date.now(),
    user_id: user.id,
    package_id: packageId,
    amount: pkg ? pkg.price : 1.0,
    received_amount: pkg ? pkg.balance_amount : 1.0,
    screenshot: req.file ? `/storage/screenshots/${req.file.filename}` : null,
    status: 'pending',
    created_at: new Date().toISOString()
  };

  db.topups = db.topups || [];
  db.topups.push(topup);
  writeDB(db);
  res.json({ topup_id: topup.id });
});

router.get('/user/topup-status', (req, res) => {
  const topup = (readDB().topups || []).find(t => t.id === parseInt(req.query.id));
  if (!topup) return res.status(404).json({ message: 'Topup not found' });
  res.json({ status: topup.status, received_amount: topup.received_amount || topup.amount });
});

router.get('/user/vip-plans', (req, res) => {
  res.json(readDB().vip_plans || []);
});

router.post('/user/vip-request', upload.single('screenshot'), (req, res) => {
  const db = readDB();
  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });
  const planId = parseInt(req.body.plan_id);
  const plan = (db.vip_plans || []).find(p => p.id === planId);

  const vip = {
    id: Date.now(),
    user_id: user.id,
    plan_id: planId,
    amount: plan ? plan.price : 2.5,
    duration_days: plan ? plan.duration_days : 30,
    screenshot: req.file ? `/storage/screenshots/${req.file.filename}` : null,
    status: 'pending',
    created_at: new Date().toISOString()
  };

  db.vip_requests = db.vip_requests || [];
  db.vip_requests.push(vip);
  writeDB(db);
  res.json({ vip_id: vip.id });
});

router.get('/user/vip-status', (req, res) => {
  const vip = (readDB().vip_requests || []).find(v => v.id === parseInt(req.query.id));
  if (!vip) return res.status(404).json({ message: 'VIP request not found' });
  res.json({ status: vip.status });
});

module.exports = router;
