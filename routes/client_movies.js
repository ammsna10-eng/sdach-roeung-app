const express = require('express');
const router = express.Router();
const { readDB, writeDB, getCurrentUser } = require('../db');

router.get('/user/movies', (req, res) => {
  const db = readDB();
  const m = db.movies || [];
  res.json({
    slider: m.filter(x => x.is_slider),
    latest: m.filter(x => x.is_latest),
    popular: m.filter(x => x.is_popular),
    dubbed: m.filter(x => x.is_dubbed),
    series: m.filter(x => x.type === 'series'),
    all: m
  });
});

router.get('/user/movies/:id', (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const movie = (db.movies || []).find(m => m.id === movieId);
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const user = getCurrentUser(req, db);
  const isVip = Boolean(user && user.is_vip);
  const purchases = (db.purchases || []).filter(p => String(p.user_id) === String(user?.id));
  const hasPurchased = isVip || movie.access_type === 'free' || purchases.some(p => p.movie_id === movieId && !p.episode_id);
  const purchasedEpisodes = purchases.filter(p => p.movie_id === movieId && p.episode_id).map(p => p.episode_id);

  const seasons = (db.seasons || []).filter(s => s.movie_id === movieId).map(s => ({
    ...s,
    episodes: (db.episodes || []).filter(ep => ep.season_id === s.id)
  }));

  res.json({
    movie: {
      ...movie,
      seasons: seasons.length ? seasons : [{ id: 1, season_number: 1, title: "រដូវកាលទី ១", episodes: (db.episodes || []).filter(ep => ep.movie_id === movieId) }],
      comments: movie.comments || []
    },
    has_purchased: hasPurchased,
    is_vip: isVip,
    purchased_episodes: purchasedEpisodes,
    qualities: { "1080": "1080p", "720": "720p", "480": "480p" }
  });
});

router.post('/user/movies/:id/purchase', (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const movie = (db.movies || []).find(m => m.id === movieId);
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const price = parseFloat(movie.price || 0);
  if (parseFloat(user.wallet_balance) < price) {
    return res.status(400).json({ message: 'សមតុល្យលុយមិនគ្រប់គ្រាន់ទេ!' });
  }

  user.wallet_balance = +(parseFloat(user.wallet_balance) - price).toFixed(2);
  db.purchases = db.purchases || [];
  db.purchases.push({ id: Date.now(), user_id: user.id, movie_id: movieId, amount: price, created_at: new Date().toISOString() });
  writeDB(db);

  res.json({ new_balance: user.wallet_balance, message: 'ការទិញរឿងបានជោគជ័យ!' });
});

router.post('/user/episodes/:id/purchase', (req, res) => {
  const db = readDB();
  const epId = parseInt(req.params.id);
  const episode = (db.episodes || []).find(ep => ep.id === epId);
  if (!episode) return res.status(404).json({ message: 'Episode not found' });

  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const price = parseFloat(episode.price || 0.25);
  if (parseFloat(user.wallet_balance) < price) {
    return res.status(400).json({ message: 'សមតុល្យលុយមិនគ្រប់គ្រាន់ទេ!' });
  }

  user.wallet_balance = +(parseFloat(user.wallet_balance) - price).toFixed(2);
  db.purchases = db.purchases || [];
  db.purchases.push({ id: Date.now(), user_id: user.id, movie_id: episode.movie_id, episode_id: epId, amount: price, created_at: new Date().toISOString() });
  writeDB(db);

  res.json({ new_balance: user.wallet_balance, message: 'ការទិញភាគបានជោគជ័យ!' });
});

router.get('/stream/movies/:id', (req, res) => {
  const db = readDB();
  const movieId = parseInt(req.params.id);
  const epId = req.query.episode_id ? parseInt(req.query.episode_id) : null;
  if (epId) {
    const ep = (db.episodes || []).find(e => e.id === epId);
    if (ep && ep.video_url) return res.json({ stream_url: ep.video_url });
  }
  const movie = (db.movies || []).find(m => m.id === movieId);
  if (movie && movie.video_url) return res.json({ stream_url: movie.video_url });
  res.json({ stream_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" });
});

module.exports = router;
