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
router.get('/data/user-movies', (req, res) => {
  const db = readDB();
  const purchases = (db.purchases || []).map(p => {
    const movie = (db.movies || []).find(m => m.id === p.movie_id);
    const user = (db.users || []).find(u => String(u.id) === String(p.user_id));
    return {
      ...p,
      movie_title: movie ? movie.title_kh : 'ភាពយន្ត',
      user_name: user ? user.first_name : 'SnA'
    };
  });
  const totalRev = purchases.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

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
  const purchases = db.purchases || [];
  const totalRev = purchases.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

  res.json({
    kpis: {
      total_sales: totalRev.toFixed(2),
      total_commission: (totalRev * 0.2).toFixed(2),
      net_profit: (totalRev * 0.8).toFixed(2),
      total_movies_sold: purchases.length,
      total_uploaded: (db.movies || []).length,
      current_level: "Level 1",
      current_rate: "20%",
      monthly_total_sales: totalRev.toFixed(2),
      next_target: "500.00"
    },
    records: paginate(purchases, req.query.page, 10),
    uploaders: db.admins || []
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
