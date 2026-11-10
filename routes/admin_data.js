const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../db');

function paginate(arr = [], page = 1, perPage = 10) {
  const p = Math.max(1, parseInt(page) || 1);
  const start = (p - 1) * perPage;
  return {
    data: arr.slice(start, start + perPage),
    current_page: p,
    last_page: Math.ceil(arr.length / perPage) || 1,
    per_page: perPage,
    total: arr.length
  };
}

router.get('/data/users', (req, res) => {
  const db = readDB();
  const users = db.users || [];
  const vipCount = users.filter(u => u.is_vip).length;
  const totalBalance = users.reduce((sum, u) => sum + parseFloat(u.wallet_balance || 0), 0);
  const purchases = db.purchases || [];

  res.json({
    users: paginate(users, req.query.page, 10),
    stats: {
      total_users: users.length,
      total_vip_users: vipCount,
      total_balance: totalBalance.toFixed(2),
      total_movies_bought: purchases.length
    },
    vip_plans: db.vip_plans || []
  });
});

router.put('/data/users/:id', (req, res) => {
  const db = readDB();
  const user = (db.users || []).find(u => String(u.id) === String(req.params.id));
  if (!user) return res.status(404).json({ message: 'User not found' });

  if (req.body.balance !== undefined) user.wallet_balance = parseFloat(req.body.balance);
  if (req.body.is_vip !== undefined) user.is_vip = Boolean(req.body.is_vip);
  if (req.body.vip_action === 'add' && req.body.add_days) {
    user.is_vip = true;
    const now = new Date();
    now.setDate(now.getDate() + parseInt(req.body.add_days));
    user.vip_expires_at = now.toISOString();
  }

  writeDB(db);
  res.json({ message: 'User updated', user });
});

router.get('/data/movies', (req, res) => {
  const db = readDB();
  const movies = db.movies || [];
  res.json({
    movies: paginate(movies, req.query.page, 10),
    genres: db.genres || [],
    countries: db.countries || [],
    stats: {
      total_movies: movies.length,
      public_movies: movies.filter(m => m.status === 'public').length,
      draft_movies: movies.filter(m => m.status === 'draft').length,
      deleted_movies: 0
    },
    current_user: db.admins?.[0] || { role: 'super_admin' }
  });
});

router.post('/data/movies', (req, res) => {
  const db = readDB();
  const movie = {
    id: Date.now(),
    title_kh: req.body.title_kh || 'គ្មានចំណងជើង',
    title_en: req.body.title_en || '',
    slug: (req.body.title_en || 'movie').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    type: req.body.type || 'movie',
    access_type: req.body.access_type || 'paid',
    price: parseFloat(req.body.price || 0.5),
    rating: parseFloat(req.body.rating || 9.5),
    poster_path: req.body.poster_path || '/storage/logo/logo.png',
    backdrop_path: req.body.backdrop_path || req.body.poster_path || '/storage/logo/logo.png',
    trailer_url: req.body.trailer_url || '',
    video_url: req.body.video_url || '',
    overview: req.body.overview || '',
    language_type: req.body.language_type || 'khmer_dubbed',
    release_year: req.body.release_year || 2025,
    status: req.body.status || 'public',
    is_slider: Boolean(req.body.is_slider),
    is_popular: Boolean(req.body.is_popular),
    is_latest: true,
    is_dubbed: req.body.language_type === 'khmer_dubbed',
    country_id: req.body.country_id || 1,
    genres: req.body.genres || [{ id: 1, name: "Action" }],
    comments: []
  };

  db.movies = db.movies || [];
  db.movies.unshift(movie);
  writeDB(db);
  res.json({ message: 'Movie created', movie });
});

router.put('/data/movies/:id', (req, res) => {
  const db = readDB();
  const movie = (db.movies || []).find(m => m.id === parseInt(req.params.id));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });
  Object.assign(movie, req.body);
  writeDB(db);
  res.json({ message: 'Movie updated', movie });
});

router.delete('/data/movies/:id', (req, res) => {
  const db = readDB();
  db.movies = (db.movies || []).filter(m => m.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Movie deleted' });
});

router.get('/data/topups', (req, res) => {
  const db = readDB();
  const topups = (db.topups || []).map(t => ({
    ...t,
    user: (db.users || []).find(u => String(u.id) === String(t.user_id)) || { first_name: 'Unknown User' }
  }));
  const approved = topups.filter(t => t.status === 'approved');
  const pending = topups.filter(t => t.status === 'pending');
  const rejected = topups.filter(t => t.status === 'rejected');
  const revenue = approved.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

  res.json({
    topups: paginate(topups, req.query.page, 10),
    stats: {
      pending_topups: pending.length,
      total_approved: approved.length,
      total_pending: pending.length,
      total_rejected: rejected.length,
      topup_revenue: revenue.toFixed(2)
    }
  });
});

router.put('/data/topups/:id', (req, res) => {
  const db = readDB();
  const topup = (db.topups || []).find(t => t.id === parseInt(req.params.id));
  if (!topup) return res.status(404).json({ message: 'Topup not found' });

  topup.status = req.body.status;
  if (req.body.status === 'approved') {
    const user = (db.users || []).find(u => String(u.id) === String(topup.user_id));
    if (user) {
      const added = parseFloat(topup.received_amount || topup.amount || 0);
      user.wallet_balance = +(parseFloat(user.wallet_balance || 0) + added).toFixed(2);
    }
  }

  writeDB(db);
  res.json({ message: 'Topup updated', topup });
});

module.exports = router;
