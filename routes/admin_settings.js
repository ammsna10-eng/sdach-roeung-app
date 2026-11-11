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

// Genres
router.get('/data/genres', (req, res) => res.json(paginate(readDB().genres || [], req.query.page, 10)));
router.post('/data/genres', (req, res) => {
  const db = readDB();
  const genre = { id: Date.now(), name: req.body.name };
  db.genres = db.genres || [];
  db.genres.push(genre);
  writeDB(db);
  res.json({ message: 'Genre created', genre });
});
router.put('/data/genres/:id', (req, res) => {
  const db = readDB();
  const g = (db.genres || []).find(x => x.id === parseInt(req.params.id));
  if (g) { g.name = req.body.name; writeDB(db); }
  res.json({ message: 'Genre updated', genre: g });
});
router.delete('/data/genres/:id', (req, res) => {
  const db = readDB();
  db.genres = (db.genres || []).filter(x => x.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Genre deleted' });
});

// Countries
router.get('/data/countries', (req, res) => res.json(paginate(readDB().countries || [], req.query.page, 10)));
router.post('/data/countries', (req, res) => {
  const db = readDB();
  const country = { id: Date.now(), name: req.body.name };
  db.countries = db.countries || [];
  db.countries.push(country);
  writeDB(db);
  res.json({ message: 'Country created', country });
});
router.put('/data/countries/:id', (req, res) => {
  const db = readDB();
  const c = (db.countries || []).find(x => x.id === parseInt(req.params.id));
  if (c) { c.name = req.body.name; writeDB(db); }
  res.json({ message: 'Country updated', country: c });
});
router.delete('/data/countries/:id', (req, res) => {
  const db = readDB();
  db.countries = (db.countries || []).filter(x => x.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Country deleted' });
});

// Admins
router.get('/data/admins', (req, res) => res.json(paginate(readDB().admins || [], req.query.page, 10)));
router.post('/data/admins', (req, res) => {
  const db = readDB();
  const admin = { id: Date.now(), name: req.body.name, email: req.body.email, password: req.body.password || 'password123', role: 'admin' };
  db.admins = db.admins || [];
  db.admins.push(admin);
  writeDB(db);
  res.json({ message: 'Admin created', admin });
});
router.put('/data/admins/:id', (req, res) => {
  const db = readDB();
  const a = (db.admins || []).find(x => x.id === parseInt(req.params.id));
  if (a) {
    if (req.body.name) a.name = req.body.name;
    if (req.body.email) a.email = req.body.email;
    if (req.body.password) a.password = req.body.password;
    writeDB(db);
  }
  res.json({ message: 'Admin updated', admin: a });
});
router.delete('/data/admins/:id', (req, res) => {
  const db = readDB();
  db.admins = (db.admins || []).filter(x => x.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ message: 'Admin deleted' });
});

// Comments
router.get('/data/comments', (req, res) => {
  const db = readDB();
  const all = [];
  (db.movies || []).forEach(m => (m.comments || []).forEach(c => all.push({ ...c, movie_title: m.title_kh, movie_id: m.id })));
  res.json({
    comments: paginate(all, req.query.page, 10),
    stats: { total_comments: all.length, main_comments: all.length, total_replies: 0, today_comments: all.length },
    movies: db.movies || []
  });
});
router.delete('/data/comments/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  (db.movies || []).forEach(m => { m.comments = (m.comments || []).filter(c => c.id !== id); });
  writeDB(db);
  res.json({ message: 'Comment deleted' });
});

// Database Export / Pre-flight Sync API
router.get(['/export-db', '/data/export-db'], (req, res) => {
  const secret = req.query.secret || req.headers['x-sync-secret'];
  const expectedSecret = process.env.SYNC_SECRET || 'sdach_db_sync_secret_2026_x9k2';

  const isAdmin = req.session && req.session.admin;
  if (!isAdmin && secret !== expectedSecret) {
    return res.status(403).json({ error: 'Unauthorized: Invalid sync secret' });
  }

  const db = readDB();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="db_backup_${Date.now()}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

module.exports = router;
