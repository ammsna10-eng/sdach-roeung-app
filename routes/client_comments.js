const express = require('express');
const router = express.Router();
const { readDB, writeDB, getCurrentUser } = require('../db');

router.post('/movies/:id/comments', (req, res) => {
  const db = readDB();
  const movie = (db.movies || []).find(m => m.id === parseInt(req.params.id));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const user = getCurrentUser(req, db);
  const newComment = {
    id: Date.now(),
    text: req.body.text,
    created_at: new Date().toISOString(),
    user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url || '/storage/logo/logo.png' },
    replies: []
  };

  movie.comments = movie.comments || [];
  if (req.body.parent_id) {
    const parent = movie.comments.find(c => c.id === parseInt(req.body.parent_id));
    if (parent) { parent.replies = parent.replies || []; parent.replies.push(newComment); }
    else movie.comments.unshift(newComment);
  } else {
    movie.comments.unshift(newComment);
  }

  writeDB(db);
  res.json({ comment: newComment });
});

router.put('/comments/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  for (const m of (db.movies || [])) {
    for (const c of (m.comments || [])) {
      if (c.id === id) { c.text = req.body.text; writeDB(db); return res.json({ comment: c }); }
      for (const r of (c.replies || [])) {
        if (r.id === id) { r.text = req.body.text; writeDB(db); return res.json({ comment: r }); }
      }
    }
  }
  res.status(404).json({ message: 'Comment not found' });
});

router.delete('/comments/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  for (const m of (db.movies || [])) {
    m.comments = (m.comments || []).filter(c => c.id !== id);
    for (const c of m.comments) c.replies = (c.replies || []).filter(r => r.id !== id);
  }
  writeDB(db);
  res.json({ message: 'Comment deleted' });
});

module.exports = router;
