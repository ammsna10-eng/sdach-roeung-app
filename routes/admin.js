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

// Upload Poster API (allows direct image upload via Admin Panel)
router.post('/data/upload-poster', uploadPoster.single('poster'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'គ្មានរូបភាពត្រូវបានជ្រើសរើស' });
  const relativeUrl = `/storage/posters/${req.file.filename}`;
  res.json({
    message: 'Upload poster ជោគជ័យ!',
    url: relativeUrl
  });
});


// Admin Auth
router.post('/login', (req, res) => {
  const db = readDB();
  const { email, password } = req.body;
  const admin = (db.admins || []).find(a => a.email === email && a.password === password);
  if (!admin) return res.status(401).json({ message: 'អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ!' });

  res.json({
    token: `admin_token_${admin.id}`,
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

// Topup Packages
router.get('/data/topup-packages', (req, res) => res.json(readDB().topup_packages || []));
router.post('/data/topup-packages', (req, res) => {
  const db = readDB();
  const pkg = {
    id: Date.now(),
    title: req.body.title,
    price: parseFloat(req.body.price),
    balance_amount: parseFloat(req.body.balance_amount || req.body.price),
    qr_image: req.body.qr_image || '/storage/logo/logo.png',
    is_active: Boolean(req.body.is_active)
  };
  db.topup_packages = db.topup_packages || [];
  db.topup_packages.push(pkg);
  writeDB(db);
  res.json({ message: 'Package created', package: pkg });
});
router.put('/data/topup-packages/:id', (req, res) => {
  const db = readDB();
  const pkg = (db.topup_packages || []).find(p => p.id === parseInt(req.params.id));
  if (pkg) { Object.assign(pkg, req.body); writeDB(db); }
  res.json({ message: 'Package updated', package: pkg });
});
router.delete('/data/topup-packages/:id', (req, res) => {
  const db = readDB();
  db.topup_packages = (db.topup_packages || []).filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Package deleted' });
});

// VIP Plans
router.get('/data/vip-plans', (req, res) => res.json(readDB().vip_plans || []));
router.post('/data/vip-plans', (req, res) => {
  const db = readDB();
  const plan = {
    id: Date.now(),
    title: req.body.title,
    price: parseFloat(req.body.price),
    duration_days: parseInt(req.body.duration_days || 30),
    description: req.body.description || '',
    qr_image: req.body.qr_image || '/storage/logo/logo.png',
    is_active: Boolean(req.body.is_active)
  };
  db.vip_plans = db.vip_plans || [];
  db.vip_plans.push(plan);
  writeDB(db);
  res.json({ message: 'Plan created', plan });
});
router.put('/data/vip-plans/:id', (req, res) => {
  const db = readDB();
  const plan = (db.vip_plans || []).find(p => p.id === parseInt(req.params.id));
  if (plan) { Object.assign(plan, req.body); writeDB(db); }
  res.json({ message: 'Plan updated', plan });
});
router.delete('/data/vip-plans/:id', (req, res) => {
  const db = readDB();
  db.vip_plans = (db.vip_plans || []).filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Plan deleted' });
});

// Broadcast
router.post('/data/movies/:id/broadcast-telegram', (req, res) => {
  res.json({ message: 'Broadcasted to Telegram channel successfully!' });
});

// Mount other admin routers
router.use('/', require('./admin_data'));
router.use('/', require('./admin_settings'));
router.use('/', require('./admin_reports'));

module.exports = router;
