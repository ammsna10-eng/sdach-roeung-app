const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../db');
const { broadcastNewMovie } = require('../services/telegram_notifier');

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

// Helper: Normalize movie genres into clean [{ id, name }] objects
function normalizeGenres(inputGenres, dbGenres = []) {
  const genreMap = new Map(dbGenres.map(g => [Number(g.id), g]));
  const result = [];
  if (Array.isArray(inputGenres)) {
    inputGenres.forEach(g => {
      if (!g) return;
      if (typeof g === 'object' && g.id && g.name) {
        result.push({ id: Number(g.id), name: g.name });
      } else {
        const idNum = Number(typeof g === 'object' ? g.id : g);
        if (genreMap.has(idNum)) {
          result.push(genreMap.get(idNum));
        }
      }
    });
  }
  if (result.length === 0 && dbGenres.length > 0) {
    result.push(dbGenres[0]);
  }
  return result;
}

router.get('/data/movies', (req, res) => {
  const db = readDB();
  const dbGenres = db.genres || [];
  const movies = (db.movies || []).map(m => ({
    ...m,
    genres: normalizeGenres(m.genres, dbGenres)
  }));

  res.json({
    movies: paginate(movies, req.query.page, 10),
    genres: dbGenres,
    countries: db.countries || [],
    stats: {
      total_movies: movies.length,
      public_movies: movies.filter(m => m.status === 'public' || m.status === 'published').length,
      draft_movies: movies.filter(m => m.status === 'draft').length,
      deleted_movies: 0
    },
    current_user: db.admins?.[0] || { role: 'super_admin' }
  });
});

router.post('/data/movies', (req, res) => {
  const db = readDB();
  const dbGenres = db.genres || [];
  const cleanGenres = normalizeGenres(req.body.genres, dbGenres);

  let isDub;
  if (req.body.language_type !== undefined && req.body.language_type !== null) {
    isDub = req.body.language_type === 'dub' || req.body.language_type === 'human' || req.body.language_type === 'khmer_dubbed';
  } else {
    isDub = req.body.is_dubbed === true;
  }

  const movie = {
    id: Date.now(),
    title_kh: req.body.title_kh || 'គ្មានចំណងជើង',
    title_en: req.body.title_en || '',
    slug: (req.body.title_en || 'movie-' + Date.now()).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    type: req.body.type || 'movie',
    access_type: req.body.access_type || 'paid',
    price: parseFloat(req.body.price !== undefined ? req.body.price : 0.5),
    rating: parseFloat(req.body.rating || 9.5),
    poster_path: req.body.poster_path || '/storage/logo/logo.png',
    backdrop_path: req.body.backdrop_path || req.body.poster_path || '/storage/logo/logo.png',
    trailer_url: req.body.trailer_url || '',
    video_url: req.body.video_url || '',
    overview: req.body.overview || '',
    language_type: isDub ? 'dub' : 'sub',
    release_year: req.body.release_year || new Date().getFullYear(),
    runtime_minutes: req.body.runtime_minutes || '',
    status: req.body.status || 'published',
    is_slider: req.body.is_slider !== undefined ? Boolean(req.body.is_slider) : true,
    is_popular: req.body.is_popular !== undefined ? Boolean(req.body.is_popular) : true,
    is_latest: true,
    is_dubbed: isDub,
    country_id: req.body.country_id ? Number(req.body.country_id) : 1,
    genres: cleanGenres,
    comments: [],
    is_send_to_channel: Boolean(req.body.is_send_to_channel)
  };

  const shouldBroadcast = req.body.is_send_to_channel === true || 
                          req.body.broadcast === true || 
                          req.body.notify_telegram === true;

  if (shouldBroadcast) {
    movie.is_send_to_channel = true;
  }

  db.movies = db.movies || [];
  db.movies.unshift(movie);
  writeDB(db);

  if (shouldBroadcast) {
    broadcastNewMovie(movie).catch(err => {
      console.error('Background telegram broadcast failed:', err.message);
    });
  }

  res.json({ message: 'បានបង្កើតរឿងថ្មីជោគជ័យ!', movie });
});

router.put('/data/movies/:id', (req, res) => {
  const db = readDB();
  const dbGenres = db.genres || [];
  const movie = (db.movies || []).find(m => m.id === parseInt(req.params.id));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const cleanGenres = req.body.genres ? normalizeGenres(req.body.genres, dbGenres) : normalizeGenres(movie.genres, dbGenres);
  let isDub;
  if (req.body.language_type !== undefined && req.body.language_type !== null) {
    isDub = req.body.language_type === 'dub' || req.body.language_type === 'human' || req.body.language_type === 'khmer_dubbed';
  } else if (req.body.is_dubbed !== undefined && req.body.is_dubbed !== null) {
    isDub = Boolean(req.body.is_dubbed);
  } else {
    isDub = movie.language_type === 'dub' || movie.is_dubbed === true;
  }

  const updateData = { ...req.body };
  delete updateData.is_dubbed;
  delete updateData.language_type;

  Object.assign(movie, updateData, {
    genres: cleanGenres,
    language_type: isDub ? 'dub' : 'sub',
    is_dubbed: isDub,
    price: req.body.price !== undefined ? parseFloat(req.body.price) : movie.price,
    rating: req.body.rating !== undefined ? parseFloat(req.body.rating) : movie.rating,
    is_popular: req.body.is_popular !== undefined ? Boolean(req.body.is_popular) : (movie.is_popular !== undefined ? movie.is_popular : true),
    is_slider: req.body.is_slider !== undefined ? Boolean(req.body.is_slider) : (movie.is_slider !== undefined ? movie.is_slider : true)
  });

  writeDB(db);
  res.json({ message: 'បានកែប្រែរឿងជោគជ័យ!', movie });
});

router.delete('/data/movies/:id', (req, res) => {
  const db = readDB();
  db.movies = (db.movies || []).filter(m => m.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Movie deleted' });
});

function normalizeTopupStatus(st) {
  const s = String(st || 'pending').toLowerCase();
  if (['approved', 'completed', 'paid', 'success'].includes(s)) return 'approved';
  if (['rejected', 'failed', 'expired', 'cancelled', 'canceled'].includes(s)) return 'rejected';
  return 'pending';
}

function toCambodiaDate(iso) {
  const d = new Date(iso || Date.now());
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

router.get('/data/topups', (req, res) => {
  const db = readDB();
  const seen = new Set();
  const merged = [];

  // 1. Collect from bakong_transactions (live KHQR TopUps)
  for (const b of (db.bakong_transactions || [])) {
    const key = String(b.tran_id || b.bill_no || b.id || '');
    if (key) seen.add(key);
    merged.push({
      id: b.tran_id || b.bill_no || b.id,
      tran_id: b.tran_id || b.bill_no || '',
      user_id: b.user_id,
      amount: parseFloat(b.payAmount ?? b.amount ?? 0) || 0,
      received_amount: parseFloat(b.creditAmount ?? b.received_amount ?? b.amount ?? 0) || 0,
      package_name: b.package_name || (b.type === 'vip' ? 'VIP Package' : 'TopUp KHQR'),
      type: b.type || 'topup',
      payment_screenshot: b.payment_screenshot || null,
      status: normalizeTopupStatus(b.status),
      created_at: b.created_at || new Date().toISOString()
    });
  }

  // 2. Collect from manual db.topups if not already included
  for (const t of (db.topups || [])) {
    const key = String(t.tran_id || t.bill_no || t.id || '');
    if (key && seen.has(key)) continue;
    merged.push({
      id: t.id,
      tran_id: t.tran_id || String(t.id || ''),
      user_id: t.user_id,
      amount: parseFloat(t.amount ?? 0) || 0,
      received_amount: parseFloat(t.received_amount ?? t.amount ?? 0) || 0,
      package_name: t.package_name || 'Manual TopUp',
      type: t.type || 'topup',
      payment_screenshot: t.payment_screenshot || null,
      status: normalizeTopupStatus(t.status),
      created_at: t.created_at || new Date().toISOString()
    });
  }

  // Attach user details
  let list = merged.map(item => {
    const user = (db.users || []).find(u => String(u.id) === String(item.user_id) || String(u.telegram_id) === String(item.user_id));
    return {
      ...item,
      user: user ? {
        id: user.id,
        telegram_id: user.telegram_id || user.id,
        first_name: user.first_name || 'អតិថិជន',
        last_name: user.last_name || '',
        username: user.username || '',
        photo_url: user.photo_url || ''
      } : {
        id: item.user_id,
        telegram_id: item.user_id || 'N/A',
        first_name: 'អតិថិជន',
        last_name: '',
        username: '',
        photo_url: ''
      }
    };
  });

  // Sort newest first
  list.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

  // Apply search & date filters first so KPI stats match filtered range
  const q = String(req.query.search || '').trim().toLowerCase();
  const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
  const fromDate = String(req.query.from_date || '').trim();
  const toDate = String(req.query.to_date || '').trim();

  if (q) {
    list = list.filter(t =>
      (t.user?.first_name || '').toLowerCase().includes(q) ||
      (t.user?.last_name || '').toLowerCase().includes(q) ||
      (t.user?.username || '').toLowerCase().includes(q) ||
      String(t.user?.telegram_id || '').toLowerCase().includes(q) ||
      String(t.tran_id || '').toLowerCase().includes(q) ||
      (t.package_name || '').toLowerCase().includes(q)
    );
  }
  if (fromDate) {
    list = list.filter(t => {
      const d = toCambodiaDate(t.created_at);
      return d && d >= fromDate;
    });
  }
  if (toDate) {
    list = list.filter(t => {
      const d = toCambodiaDate(t.created_at);
      return d && d <= toDate;
    });
  }

  const approved = list.filter(t => t.status === 'approved');
  const pending = list.filter(t => t.status === 'pending');
  const rejected = list.filter(t => t.status === 'rejected');
  const revenue = approved.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const tableList = (statusFilter && statusFilter !== 'all')
    ? list.filter(t => t.status === statusFilter)
    : list;

  res.json({
    topups: paginate(tableList, req.query.page, 10),
    stats: {
      total_sales: revenue.toFixed(2),
      topup_revenue: revenue.toFixed(2),
      pending_topups: pending.length,
      total_approved: approved.length,
      total_pending: pending.length,
      total_rejected: rejected.length
    }
  });
});

router.put('/data/topups/:id', (req, res) => {
  const db = readDB();
  const idParam = String(req.params.id);
  const newStatus = normalizeTopupStatus(req.body.status);

  let record = (db.topups || []).find(t => String(t.id) === idParam || String(t.tran_id) === idParam);
  let isBakong = false;
  if (!record) {
    record = (db.bakong_transactions || []).find(b => String(b.tran_id) === idParam || String(b.bill_no) === idParam || String(b.id) === idParam);
    isBakong = true;
  }
  if (!record) return res.status(404).json({ message: 'Topup not found' });

  const prevStatus = normalizeTopupStatus(record.status);
  record.status = isBakong && newStatus === 'approved' ? 'completed' : newStatus;

  if (newStatus === 'approved' && prevStatus !== 'approved') {
    const user = (db.users || []).find(u => String(u.id) === String(record.user_id) || String(u.telegram_id) === String(record.user_id));
    if (user) {
      const added = parseFloat(record.creditAmount ?? record.received_amount ?? record.amount ?? 0) || 0;
      user.wallet_balance = +(parseFloat(user.wallet_balance || 0) + added).toFixed(2);
    }
  }

  writeDB(db);
  res.json({ message: 'Topup updated', topup: record });
});

module.exports = router;
