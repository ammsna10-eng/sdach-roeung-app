const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { readDB, writeDB, getCurrentUser } = require('../db');

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

router.post('/telegram-login', (req, res) => {
  const db = readDB();
  let telegramUser = null;
  try {
    const searchParams = new URLSearchParams(req.body.initData || '');
    const userStr = searchParams.get('user');
    if (userStr) telegramUser = JSON.parse(userStr);
  } catch (e) {}

  if (!telegramUser) {
    telegramUser = { id: 924441299, first_name: "SnA", username: "AmmSnA", photo_url: "/storage/logo/logo.png" };
  }

  let user = db.users.find(u => String(u.telegram_id) === String(telegramUser.id));
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
    writeDB(db);
  } else {
    // Update live profile info from Telegram (photo, names, username)
    let updated = false;
    if (telegramUser.first_name && user.first_name !== telegramUser.first_name) {
      user.first_name = telegramUser.first_name;
      updated = true;
    }
    if (telegramUser.last_name !== undefined && user.last_name !== telegramUser.last_name) {
      user.last_name = telegramUser.last_name;
      updated = true;
    }
    if (telegramUser.username !== undefined && user.username !== telegramUser.username) {
      user.username = telegramUser.username;
      updated = true;
    }
    if (telegramUser.photo_url && user.photo_url !== telegramUser.photo_url) {
      user.photo_url = telegramUser.photo_url;
      updated = true;
    }
    if (updated) writeDB(db);
  }

  res.json({
    token: `token_${user.id}`,
    user: user,
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

  res.json({ user, purchased_movies: purchasedMovies, purchased_episodes: purchasedEpisodes });
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
  const packageId = parseInt(req.body.package_id);
  const pkg = (db.topup_packages || []).find(p => p.id === packageId);

  const topup = {
    id: Date.now(),
    user_id: user ? user.id : 924441299,
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
  const planId = parseInt(req.body.plan_id);
  const plan = (db.vip_plans || []).find(p => p.id === planId);

  const vip = {
    id: Date.now(),
    user_id: user ? user.id : 924441299,
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
