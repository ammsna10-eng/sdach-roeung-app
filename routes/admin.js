const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const posterStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'public', 'storage', 'posters');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'poster_' + Date.now() + ext);
  }
});
const uploadPoster = multer({ storage: posterStorage });

const qrStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'public', 'storage', 'qrs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'qr_' + Date.now() + ext);
  }
});
const uploadQr = multer({ storage: qrStorage });

// Upload Poster API
router.post('/data/upload-poster', uploadPoster.single('poster'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'គ្មានរូបភាពត្រូវបានជ្រើសរើស' });
  const relativeUrl = '/storage/posters/' + req.file.filename;
  res.json({ message: 'Upload poster ជោគជ័យ!', url: relativeUrl });
});

// Admin Auth
router.post('/login', (req, res) => {
  const db = readDB();
  const { email, password } = req.body;
  const admin = (db.admins || []).find(a => a.email === email && a.password === password);
  if (!admin) return res.status(401).json({ message: 'អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!' });

  res.json({
    token: 'admin_token_' + admin.id,
    role: admin.role || 'super_admin',
    user: admin
  });
});

router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

router.get('/data/dashboard-stats', (req, res) => {
  const db = readDB();
  const purchases = db.purchases || [];
  const topups = db.topups || [];
  const totalRevenue = purchases.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
  const pendingTopups = topups.filter(t => t.status === 'pending').length;

  res.json({
    total_users: (db.users || []).length,
    total_movies: (db.movies || []).length,
    total_revenue: totalRevenue.toFixed(2),
    pending_topups: pendingTopups,
    total_topups: topups.length
  });
});

router.get('/data/uploader/dashboard-stats', (req, res) => {
  const db = readDB();
  res.json({
    total_movies: (db.movies || []).length,
    total_episodes: (db.episodes || []).length
  });
});

// ==================== TOPUP PACKAGES ====================
router.get('/data/topup-packages', (req, res) => {
  const pkgs = (readDB().topup_packages || []).map(p => ({
    ...p,
    name: p.name !== undefined ? p.name : (p.title || '')
  }));
  res.json(pkgs);
});

const handleSavePackage = (req, res) => {
  const db = readDB();
  const pkgId = req.params.id ? parseInt(req.params.id) : null;
  const isUpdate = Boolean(pkgId);

  let existing = null;
  if (isUpdate) {
    existing = (db.topup_packages || []).find(p => p.id === pkgId);
    if (!existing) return res.status(404).json({ message: 'រកមិនឃើញកញ្ចប់នេះទេ' });
  }

  const priceVal = req.body.price !== undefined && req.body.price !== '' ? parseFloat(req.body.price) : (existing ? existing.price : 1.0);
  const balanceVal = req.body.balance_amount !== undefined && req.body.balance_amount !== '' ? parseFloat(req.body.balance_amount) : priceVal;

  // Name/Title is completely optional! If empty or 'undefined', keep it clean ''
  let rawName = req.body.name !== undefined ? req.body.name : (req.body.title !== undefined ? req.body.title : '');
  if (rawName === 'undefined' || rawName === 'null') rawName = '';
  const nameVal = String(rawName).trim();

  let qrImg = existing ? existing.qr_image : '/storage/logo/logo.png';
  if (req.file) {
    qrImg = '/storage/qrs/' + req.file.filename;
  } else if (req.body.qr_image && typeof req.body.qr_image === 'string' && req.body.qr_image.startsWith('/')) {
    qrImg = req.body.qr_image;
  }

  const isActive = req.body.is_active !== undefined ? Boolean(parseInt(req.body.is_active) || req.body.is_active === 'true' || req.body.is_active === true) : true;

  if (isUpdate) {
    existing.name = nameVal;
    existing.title = nameVal || ('កញ្ចប់ $' + priceVal.toFixed(2));
    existing.price = priceVal;
    existing.balance_amount = balanceVal;
    existing.qr_image = qrImg;
    existing.is_active = isActive;
    writeDB(db);
    return res.json({ message: 'បានកែប្រែកញ្ចប់ជោគជ័យ!', package: existing });
  } else {
    const newPkg = {
      id: Date.now(),
      name: nameVal,
      title: nameVal || ('កញ្ចប់ $' + priceVal.toFixed(2)),
      price: priceVal,
      balance_amount: balanceVal,
      qr_image: qrImg,
      is_active: isActive
    };
    db.topup_packages = db.topup_packages || [];
    db.topup_packages.push(newPkg);
    writeDB(db);
    return res.json({ message: 'បានបង្កើតកញ្ចប់ថ្មីជោគជ័យ!', package: newPkg });
  }
};

router.post('/data/topup-packages', uploadQr.single('qr_image'), handleSavePackage);
router.post('/data/topup-packages/:id', uploadQr.single('qr_image'), handleSavePackage);
router.put('/data/topup-packages/:id', uploadQr.single('qr_image'), handleSavePackage);

router.delete('/data/topup-packages/:id', (req, res) => {
  const db = readDB();
  db.topup_packages = (db.topup_packages || []).filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Package deleted' });
});

// ==================== VIP PLANS ====================
router.get('/data/vip-plans', (req, res) => res.json(readDB().vip_plans || []));

const handleSaveVipPlan = (req, res) => {
  const db = readDB();
  const planId = req.params.id ? parseInt(req.params.id) : null;
  const isUpdate = Boolean(planId);

  let existing = null;
  if (isUpdate) {
    existing = (db.vip_plans || []).find(p => p.id === planId);
    if (!existing) return res.status(404).json({ message: 'រកមិនឃើញគម្រោង VIP នេះទេ' });
  }

  const priceVal = req.body.price !== undefined && req.body.price !== '' ? parseFloat(req.body.price) : (existing ? existing.price : 2.5);
  const daysVal = req.body.duration_days !== undefined && req.body.duration_days !== '' ? parseInt(req.body.duration_days) : (existing ? existing.duration_days : 30);

  let rawTitle = req.body.title !== undefined ? req.body.title : '';
  if (rawTitle === 'undefined' || rawTitle === 'null') rawTitle = '';
  const titleVal = String(rawTitle).trim() || ('VIP ' + daysVal + ' ថ្ងៃ');

  let qrImg = existing ? existing.qr_image : '/storage/logo/logo.png';
  if (req.file) {
    qrImg = '/storage/qrs/' + req.file.filename;
  } else if (req.body.qr_image && typeof req.body.qr_image === 'string' && req.body.qr_image.startsWith('/')) {
    qrImg = req.body.qr_image;
  }

  const desc = req.body.description !== undefined && req.body.description !== 'undefined' ? req.body.description : (existing ? existing.description : '');
  const isActive = req.body.is_active !== undefined ? Boolean(parseInt(req.body.is_active) || req.body.is_active === 'true' || req.body.is_active === true) : true;

  if (isUpdate) {
    existing.title = titleVal;
    existing.price = priceVal;
    existing.duration_days = daysVal;
    existing.description = desc;
    existing.qr_image = qrImg;
    existing.is_active = isActive;
    writeDB(db);
    return res.json({ message: 'បានកែប្រែគម្រោង VIP ជោគជ័យ!', plan: existing });
  } else {
    const newPlan = {
      id: Date.now(),
      title: titleVal,
      price: priceVal,
      duration_days: daysVal,
      description: desc,
      qr_image: qrImg,
      is_active: isActive
    };
    db.vip_plans = db.vip_plans || [];
    db.vip_plans.push(newPlan);
    writeDB(db);
    return res.json({ message: 'បានបង្កើតគម្រោង VIP ថ្មីជោគជ័យ!', plan: newPlan });
  }
};

router.post('/data/vip-plans', uploadQr.single('qr_image'), handleSaveVipPlan);
router.post('/data/vip-plans/:id', uploadQr.single('qr_image'), handleSaveVipPlan);
router.put('/data/vip-plans/:id', uploadQr.single('qr_image'), handleSaveVipPlan);

router.delete('/data/vip-plans/:id', (req, res) => {
  const db = readDB();
  db.vip_plans = (db.vip_plans || []).filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Plan deleted' });
});

const { broadcastNewMovie } = require('../services/telegram_notifier');

// Broadcast
router.post('/data/movies/:id/broadcast-telegram', async (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const movie = (db.movies || []).find(m => m.id === movieId);
  if (!movie) {
    return res.status(404).json({ message: 'រកមិនឃើញទិន្នន័យភាពយន្តឡើយ (Movie not found)' });
  }

  try {
    const report = await broadcastNewMovie(movie);
    movie.is_send_to_channel = true;
    writeDB(db);
    res.json({
      message: `បានផ្សាយទៅ Telegram ជោគជ័យ! (ផ្ញើបាន ${report.sent_count} នាក់)`,
      success: true,
      report
    });
  } catch (err) {
    console.error('Error broadcasting movie:', err);
    res.status(500).json({ message: 'មានបញ្ហាក្នុងការផ្សាយទៅកាន់ Telegram: ' + err.message });
  }
});

// Mount other admin routers
router.use('/', require('./admin_data'));
router.use('/', require('./admin_settings'));
router.use('/', require('./admin_reports'));

module.exports = router;
