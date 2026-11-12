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

// User-movies (Purchases report)
function toCambodiaDateStr(isoOrDate) {
  const d = new Date(isoOrDate || Date.now());
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

router.get('/data/user-movies', (req, res) => {
  const db = readDB();
  let purchases = (db.purchases || []).map(p => {
    const movie = (db.movies || []).find(m => String(m.id) === String(p.movie_id));
    const ep = p.episode_id ? (db.episodes || []).find(e => String(e.id) === String(p.episode_id)) : null;
    const user = (db.users || []).find(u => String(u.id) === String(p.user_id) || String(u.telegram_id) === String(p.user_id));
    const price = parseFloat(p.amount ?? p.price ?? 0) || 0;
    const movieTitle = movie ? (movie.title_kh || movie.title_en || 'ភាពយន្ត') : `រឿង #${p.movie_id || ''}`;
    const displayTitle = p.episode_id
      ? `${movieTitle} — ភាគទី ${ep ? ep.episode_number : p.episode_id}${ep && ep.title ? ` (${ep.title})` : ''}`
      : movieTitle;

    return {
      ...p,
      item_type: p.episode_id ? 'episode' : 'movie',
      display_title: displayTitle,
      movie_title: movieTitle,
      poster_path: (ep && ep.poster_path) || (movie && (movie.poster_path || movie.backdrop_path)) || '',
      purchase_price: price,
      user_name: user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : `អតិថិជន #${p.user_id || ''}`,
      user: user ? {
        id: user.id,
        telegram_id: user.telegram_id || user.id,
        first_name: user.first_name || 'អតិថិជន',
        last_name: user.last_name || '',
        username: user.username || '',
        photo_url: user.photo_url || ''
      } : {
        id: p.user_id,
        telegram_id: p.user_id || 'N/A',
        first_name: 'អតិថិជន',
        last_name: '',
        username: '',
        photo_url: ''
      }
    };
  });

  // Sort newest first
  purchases.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

  // Filter by search, from_date, and to_date (Cambodia UTC+7)
  const q = String(req.query.search || '').trim().toLowerCase();
  const fromDate = String(req.query.from_date || '').trim();
  const toDate = String(req.query.to_date || '').trim();

  if (q) {
    purchases = purchases.filter(p =>
      (p.display_title || '').toLowerCase().includes(q) ||
      (p.user?.first_name || '').toLowerCase().includes(q) ||
      (p.user?.last_name || '').toLowerCase().includes(q) ||
      (p.user?.username || '').toLowerCase().includes(q) ||
      String(p.user?.telegram_id || '').toLowerCase().includes(q)
    );
  }
  if (fromDate) {
    purchases = purchases.filter(p => {
      const dStr = toCambodiaDateStr(p.created_at);
      return dStr && dStr >= fromDate;
    });
  }
  if (toDate) {
    purchases = purchases.filter(p => {
      const dStr = toCambodiaDateStr(p.created_at);
      return dStr && dStr <= toDate;
    });
  }

  const totalRev = purchases.reduce((sum, p) => sum + (parseFloat(p.purchase_price) || 0), 0);

  res.json({
    purchases: paginate(purchases, req.query.page, 10),
    stats: {
      total_movies_sold: purchases.length,
      total_revenue: totalRev.toFixed(2)
    }
  });
});

// Trash movies
router.get('/data/trash/movies', (req, res) => res.json({ movies: paginate([], req.query.page, 10) }));
router.post('/data/trash/movies/:id/restore', (req, res) => res.json({ message: 'Restored' }));
router.delete('/data/trash/movies/:id/force', (req, res) => res.json({ message: 'Force deleted' }));

// Super report
router.get('/data/super-report', (req, res) => {
  const db = readDB();
  const admins = db.admins || [];
  const movies = db.movies || [];
  const episodes = db.episodes || [];

  const q = String(req.query.search || '').trim().toLowerCase();
  const uploaderFilter = String(req.query.uploader_id || 'all').trim();
  const fromDate = String(req.query.from_date || '').trim();
  const toDate = String(req.query.to_date || '').trim();

  const toDateStr = (iso) => {
    const d = new Date(iso || Date.now());
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };

  // Enrich all purchases with movie, episode, and uploader info
  let enriched = (db.purchases || []).map(p => {
    const movie = movies.find(m => String(m.id) === String(p.movie_id));
    const ep = p.episode_id ? episodes.find(e => String(e.id) === String(p.episode_id)) : null;

    const rawUploaderId = movie ? (movie.uploader_id ?? movie.admin_id ?? movie.created_by ?? null) : null;
    const uploader = rawUploaderId !== null
      ? admins.find(a => String(a.id) === String(rawUploaderId))
      : null;

    const uploaderKey = uploader
      ? String(uploader.id)
      : (rawUploaderId !== null ? String(rawUploaderId) : 'super_admin');
    const uploaderName = uploader
      ? (uploader.name || uploader.username || uploader.email || `Uploader #${uploader.id}`)
      : (rawUploaderId !== null ? `Uploader #${rawUploaderId}` : 'Super Admin');

    const baseTitle = movie ? (movie.title_kh || movie.title_en || 'ភាពយន្ត') : `រឿង #${p.movie_id || ''}`;
    const displayTitle = p.episode_id
      ? `${baseTitle} — ភាគទី ${ep ? ep.episode_number : p.episode_id}`
      : baseTitle;

    const price = parseFloat(p.amount ?? p.price ?? 0) || 0;

    return {
      ...p,
      movie_id: p.movie_id,
      movie_title: displayTitle,
      poster_path: (ep && ep.poster_path) || (movie && (movie.poster_path || movie.backdrop_path)) || '',
      uploader_id: uploaderKey,
      uploader_name: uploaderName,
      movie_price: price
    };
  });

  // Apply date range filter first so uploader commission tiers reflect the selected period
  if (fromDate) {
    enriched = enriched.filter(r => {
      const d = toDateStr(r.created_at);
      return d && d >= fromDate;
    });
  }
  if (toDate) {
    enriched = enriched.filter(r => {
      const d = toDateStr(r.created_at);
      return d && d <= toDate;
    });
  }

  // Calculate total sales per uploader to determine tier rate (Level 1: 15%, Level 2 >= $50: 20%, Level 3 >= $200: 30%)
  const salesByUploader = {};
  for (const r of enriched) {
    salesByUploader[r.uploader_id] = (salesByUploader[r.uploader_id] || 0) + r.movie_price;
  }

  enriched = enriched.map(r => {
    const uSales = salesByUploader[r.uploader_id] || 0;
    const rate = uSales >= 200 ? 30 : (uSales >= 50 ? 20 : 15);
    const earned = +(r.movie_price * (rate / 100)).toFixed(4);
    return {
      ...r,
      commission_rate: rate,
      commission_earned: earned
    };
  });

  // Filter by selected uploader
  if (uploaderFilter && uploaderFilter !== 'all') {
    enriched = enriched.filter(r => String(r.uploader_id) === uploaderFilter);
  }

  // Filter by search keyword
  if (q) {
    enriched = enriched.filter(r =>
      (r.movie_title || '').toLowerCase().includes(q) ||
      (r.uploader_name || '').toLowerCase().includes(q) ||
      String(r.movie_id || '').toLowerCase().includes(q)
    );
  }

  // Sort newest first
  enriched.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

  // Count uploaded movies matching filters
  let uploadedMovies = movies;
  if (uploaderFilter && uploaderFilter !== 'all') {
    uploadedMovies = uploadedMovies.filter(m => {
      const uid = m.uploader_id ?? m.admin_id ?? m.created_by ?? 'super_admin';
      return String(uid) === uploaderFilter;
    });
  }
  if (fromDate) {
    uploadedMovies = uploadedMovies.filter(m => !m.created_at || toDateStr(m.created_at) >= fromDate);
  }
  if (toDate) {
    uploadedMovies = uploadedMovies.filter(m => !m.created_at || toDateStr(m.created_at) <= toDate);
  }

  const totalSales = enriched.reduce((sum, r) => sum + r.movie_price, 0);
  const totalCommission = enriched.reduce((sum, r) => sum + r.commission_earned, 0);
  const netProfit = Math.max(0, totalSales - totalCommission);
  const activeRate = totalSales >= 200 ? 30 : (totalSales >= 50 ? 20 : 15);
  const activeLevel = totalSales >= 200 ? 'Level 3' : (totalSales >= 50 ? 'Level 2' : 'Level 1');

  res.json({
    kpis: {
      total_sales: totalSales.toFixed(2),
      total_commission: totalCommission.toFixed(2),
      net_profit: netProfit.toFixed(3),
      total_movies_sold: enriched.length,
      total_uploaded: uploadedMovies.length,
      current_level: activeLevel,
      current_rate: activeRate + '%',
      monthly_total_sales: totalSales.toFixed(2),
      next_target: totalSales >= 200 ? 'Max' : (totalSales >= 50 ? '200.00' : '50.00')
    },
    records: paginate(enriched, req.query.page, 15),
    uploaders: admins.map(a => ({
      id: a.id,
      name: a.name || a.username || a.email || `Uploader #${a.id}`
    }))
  });
});

// Seasons & Episodes
router.get('/data/movies/:id/seasons', (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const movie = (db.movies || []).find(m => m.id === movieId);
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const seasons = (db.seasons || []).filter(s => s.movie_id === movieId).map(s => ({
    ...s,
    episodes: (db.episodes || []).filter(ep => ep.season_id === s.id)
  }));

  res.json({
    ...movie,
    seasons: seasons.length ? seasons : [
      { id: 1, movie_id: movieId, season_number: 1, title: "រដូវកាលទី ១", episodes: (db.episodes || []).filter(ep => ep.movie_id === movieId) }
    ]
  });
});

router.post('/data/movies/:id/seasons', (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const season = {
    id: Date.now(),
    movie_id: movieId,
    season_number: parseInt(req.body.season_number || 1),
    title: req.body.title || `រដូវកាលទី ${req.body.season_number || 1}`
  };
  db.seasons = db.seasons || [];
  db.seasons.push(season);
  writeDB(db);
  res.json({ message: 'Season created', season });
});

router.post('/data/seasons/:id/episodes', (req, res) => {
  const db = readDB();
  const seasonId = parseInt(req.params.id);
  const season = (db.seasons || []).find(s => s.id === seasonId);
  const episode = {
    id: Date.now(),
    movie_id: season ? season.movie_id : 1,
    season_id: seasonId,
    episode_number: parseInt(req.body.episode_number || 1),
    title: req.body.title || `ភាគទី ${req.body.episode_number || 1}`,
    video_url: req.body.video_url || '',
    runtime_minutes: req.body.runtime_minutes || 25,
    price: 0.25
  };
  db.episodes = db.episodes || [];
  db.episodes.push(episode);
  writeDB(db);
  res.json({ message: 'Episode created', episode });
});

module.exports = router;
