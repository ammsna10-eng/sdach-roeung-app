const express = require('express');
const router = express.Router();
const { Readable } = require('stream');
const { readDB, writeDB, getCurrentUser, recordTransaction } = require('../db');
const {
  logSecurityEvent,
  hasActiveVip,
  getStreamSecret,
  signStreamToken,
  signUpstreamForProxy,
  verifyStreamToken,
  clientIp,
  touchWatcher,
  getActiveWatchers,
  checkSigIpReuse,
  STREAM_TOKEN_TTL_S
} = require('../services/security');

// ============================================================
// SHARED SANITIZATION: never leak raw upstream video_url
// ============================================================
function stripVideoUrlsDeep(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripVideoUrlsDeep);
  const clean = {};
  for (const key of Object.keys(obj)) {
    if (key === 'video_url' || key === 'videoUrl' || key === 'stream_url') continue;
    clean[key] = stripVideoUrlsDeep(obj[key]);
  }
  return clean;
}

function sanitizeMovieForClient(m, genreMap = null) {
  const safe = stripVideoUrlsDeep(m);
  if (genreMap && Array.isArray(m.genres)) {
    const cleanGenres = [];
    m.genres.forEach(g => {
      if (!g) return;
      if (typeof g === 'object' && g.id && g.name) {
        cleanGenres.push(g);
      } else {
        const idNum = Number(typeof g === 'object' ? g.id : g);
        if (genreMap.has(idNum)) cleanGenres.push(genreMap.get(idNum));
      }
    });
    safe.genres = cleanGenres;
  }
  let isDub;
  if (m.language_type !== undefined && m.language_type !== null) {
    isDub = m.language_type === 'dub' || m.language_type === 'human' || m.language_type === 'khmer_dubbed';
  } else {
    isDub = m.is_dubbed === true;
  }
  return {
    ...safe,
    is_dubbed: isDub,
    is_popular: m.is_popular !== undefined ? Boolean(m.is_popular) : true,
    is_slider: m.is_slider !== undefined ? Boolean(m.is_slider) : true
  };
}

// ============================================================
// ENTITLEMENT CHECK (shared by stream & watching heartbeat)
// ============================================================
function checkEntitlement(db, user, movie, epId = null) {
  if (!movie) return false;
  if (movie.access_type === 'free') return true;
  if (user && hasActiveVip(user, db)) return true;
  if (!user) return false;
  const purchases = (db.purchases || []).filter(p => String(p.user_id) === String(user.id));
  if (purchases.some(p => String(p.movie_id) === String(movie.id) && !p.episode_id)) return true;
  if (epId && purchases.some(p => String(p.movie_id) === String(movie.id) && String(p.episode_id) === String(epId))) return true;
  return false;
}

// ============================================================
// GET /user/movies — public catalog (fully sanitized)
// ============================================================
router.get('/user/movies', (req, res) => {
  const db = readDB();
  const dbGenres = db.genres || [];
  const genreMap = new Map(dbGenres.map(g => [Number(g.id), g]));
  const rawMovies = db.movies || [];

  // SECURITY: Never expose video_url (movie objects or nested episodes)
  const m = rawMovies.map(mv => sanitizeMovieForClient(mv, genreMap));
  res.json({
    slider: m.filter(x => x.is_slider),
    latest: m.filter(x => x.is_latest),
    popular: m.filter(x => x.is_popular),
    dubbed: m.filter(x => x.is_dubbed),
    series: m.filter(x => x.type === 'series'),
    genres: dbGenres,
    all: m
  });
});

// ============================================================
// GET /user/movies/:id — detail (metadata only, never video_url)
// ============================================================
router.get('/user/movies/:id', (req, res) => {
  const db = readDB();
  const movieId = req.params.id;
  const movie = (db.movies || []).find(m => String(m.id) === String(movieId));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const user = getCurrentUser(req, db);
  const isVip = hasActiveVip(user, db);
  const purchases = (db.purchases || []).filter(p => String(p.user_id) === String(user?.id));
  const hasPurchased = isVip || movie.access_type === 'free' || purchases.some(p => String(p.movie_id) === String(movieId) && !p.episode_id);
  const purchasedEpisodes = purchases.filter(p => String(p.movie_id) === String(movieId) && p.episode_id).map(p => p.episode_id);

  const rawSeasons = (db.seasons || []).filter(s => String(s.movie_id) === String(movieId)).map(s => ({
    ...s,
    episodes: (db.episodes || []).filter(ep => String(ep.season_id) === String(s.id))
  }));

  const fallbackSeasons = [{ id: 1, season_number: 1, title: "រដូវកាលទី ១", episodes: (db.episodes || []).filter(ep => String(ep.movie_id) === String(movieId)) }];
  const targetSeasons = rawSeasons.length ? rawSeasons : fallbackSeasons;

  // SECURITY: video_url is NEVER exposed here — playback goes through
  // /api/stream/movies/:id which mints a signed short-lived proxy URL.
  const sanitizedSeasons = targetSeasons.map(s => ({
    ...s,
    episodes: stripVideoUrlsDeep(s.episodes || [])
  }));

  const movieToSend = stripVideoUrlsDeep(movie);

  res.json({
    movie: {
      ...movieToSend,
      seasons: sanitizedSeasons,
      comments: movie.comments || []
    },
    has_purchased: hasPurchased,
    is_vip: isVip,
    purchased_episodes: purchasedEpisodes,
    qualities: { "1080": "1080p", "720": "720p", "480": "480p" }
  });
});

// ============================================================
// POST /user/movies/:id/purchase — wallet purchase (no video_url!)
// Frontend must play via GET /api/stream/movies/:id afterwards.
// ============================================================
router.post('/user/movies/:id/purchase', (req, res) => {
  const db = readDB();
  const movieId = req.params.id;
  const movie = (db.movies || []).find(m => String(m.id) === String(movieId));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const price = parseFloat(movie.price || 0);
  if (parseFloat(user.wallet_balance) < price) {
    return res.status(400).json({ message: 'សមតុល្យលុយមិនគ្រប់គ្រាន់ទេ!' });
  }

  user.wallet_balance = +(parseFloat(user.wallet_balance) - price).toFixed(2);
  db.purchases = db.purchases || [];
  const purchaseRec = { id: Date.now(), user_id: user.id, movie_id: movie.id, amount: price, created_at: new Date().toISOString() };
  db.purchases.push(purchaseRec);
  recordTransaction(db, {
    userId: user.id,
    telegramId: user.telegram_id || user.id,
    type: 'MOVIE_PURCHASE',
    title: 'ទិញរឿង: ' + (movie.title_kh || movie.title_en || movie.id),
    amount: -price,
    status: 'COMPLETED',
    billNo: 'P' + purchaseRec.id
  });
  writeDB(db);

  res.json({
    new_balance: user.wallet_balance,
    message: 'ការទិញរឿងបានជោគជ័យ!',
    play_via: `/api/stream/movies/${movie.id}`
  });
});

// ============================================================
// POST /user/episodes/:id/purchase — wallet purchase (no video_url!)
// ============================================================
router.post('/user/episodes/:id/purchase', (req, res) => {
  const db = readDB();
  const epId = req.params.id;
  const episode = (db.episodes || []).find(ep => String(ep.id) === String(epId));
  if (!episode) return res.status(404).json({ message: 'Episode not found' });

  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const price = parseFloat(episode.price || 0.25);
  if (parseFloat(user.wallet_balance) < price) {
    return res.status(400).json({ message: 'សមតុល្យលុយមិនគ្រប់គ្រាន់ទេ!' });
  }

  user.wallet_balance = +(parseFloat(user.wallet_balance) - price).toFixed(2);
  db.purchases = db.purchases || [];
  const purchaseRec = { id: Date.now(), user_id: user.id, movie_id: episode.movie_id, episode_id: episode.id, amount: price, created_at: new Date().toISOString() };
  db.purchases.push(purchaseRec);
  recordTransaction(db, {
    userId: user.id,
    telegramId: user.telegram_id || user.id,
    type: 'MOVIE_PURCHASE',
    title: 'ទិញភាគ: ' + (episode.title_kh || episode.title_en || ('ភាគ ' + (episode.episode_number || ''))).trim(),
    amount: -price,
    status: 'COMPLETED',
    billNo: 'P' + purchaseRec.id
  });
  writeDB(db);

  res.json({
    new_balance: user.wallet_balance,
    message: 'ការទិញភាគបានជោគជ័យ!',
    play_via: `/api/stream/movies/${episode.movie_id}?episode_id=${episode.id}`
  });
});

// ============================================================
// GET /stream/movies/:id — entitlement-gated signed stream URL
// Returns a short-lived (20 min) HMAC-signed proxy URL. The raw
// upstream video_url is NEVER sent to any client.
// ============================================================
router.get('/stream/movies/:id', (req, res) => {
  const db = readDB();
  const movieId = req.params.id;
  const epId = req.query.episode_id || null;
  const movie = (db.movies || []).find(m => String(m.id) === String(movieId));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  // STRICT SERVER-SIDE AUTH + ENTITLEMENT CHECK
  const user = getCurrentUser(req, db);
  const ip = clientIp(req);
  if (!user) {
    logSecurityEvent(db, 'UNAUTHORIZED_STREAM', {
      user_id: null,
      user_name: '',
      ip,
      details: `Stream request without valid session for movie ${movieId}`
    });
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const entitled = checkEntitlement(db, user, movie, epId);
  if (!entitled) {
    logSecurityEvent(db, 'UNAUTHORIZED_STREAM', {
      user_id: user.id,
      user_name: user.first_name || '',
      ip,
      details: `No entitlement for movie ${movieId} (episode ${epId || '-'}) — access_type: ${movie.access_type}`
    });
    return res.status(403).json({ message: 'សូមទិញរឿង ឬជាវ VIP ជាមុនសិនដើម្រាប់ទស្សនា!' });
  }

  // Resolve the upstream source
  let targetUrl = null;
  let isHls = false;
  if (epId) {
    const ep = (db.episodes || []).find(e => String(e.id) === String(epId));
    if (ep && ep.video_url) {
      targetUrl = ep.video_url;
    } else {
      return res.status(404).json({ message: 'Video stream not available' });
    }
  } else if (movie.video_url) {
    targetUrl = movie.video_url;
  } else {
    return res.status(404).json({ message: 'Video stream not available' });
  }

  if (/\.(m3u8)(\?|$)/i.test(targetUrl)) isHls = true;

  const secret = getStreamSecret(db);
  const payload = {
    uid: String(user.id),
    mid: String(movieId),
    eid: epId ? String(epId) : null,
    exp: Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_S,
    ip: ip,
    u: targetUrl
  };
  const sig = signStreamToken(payload, secret);

  res.json({
    stream_url: '/api/video-proxy?sig=' + encodeURIComponent(sig),
    type: isHls ? 'hls' : 'mp4',
    expires_in: STREAM_TOKEN_TTL_S
  });
});

// ============================================================
// GET /video-proxy — validates sig, enforces anti-sharing, and
// proxies/streams the video with HTTP Range support for Plyr.
// ============================================================
router.get('/video-proxy', async (req, res) => {
  const db = readDB();
  const sig = req.query.sig;
  const secret = getStreamSecret(db);
  const ip = clientIp(req);

  const payload = verifyStreamToken(sig, secret);
  if (!payload || !payload.u) {
    logSecurityEvent(db, 'INVALID_STREAM_SIG', {
      user_id: null,
      user_name: '',
      ip,
      details: 'Proxy request with missing/invalid/expired stream signature'
    });
    return res.status(403).json({ message: 'Forbidden: invalid stream token' });
  }

  // IP-binding + multi-IP sharing detection
  if (payload.ip && ip && payload.ip !== ip) {
    logSecurityEvent(db, 'TOKEN_SHARING', {
      user_id: payload.uid,
      user_name: '',
      ip,
      details: `Signed stream token minted for IP ${payload.ip} used from ${ip} (movie ${payload.mid})`
    });
    return res.status(403).json({ message: 'Forbidden: stream token shared across IPs' });
  }
  if (!checkSigIpReuse(String(sig).split('.')[0], ip, (payload.exp || 0) * 1000)) {
    logSecurityEvent(db, 'TOKEN_SHARING', {
      user_id: payload.uid,
      user_name: '',
      ip,
      details: `Same stream token accessed from multiple distinct IPs simultaneously (movie ${payload.mid})`
    });
    return res.status(403).json({ message: 'Forbidden: stream token shared across IPs' });
  }

  const upstreamUrl = payload.u;
  const proxyPayload = { ...payload, exp: Math.min(payload.exp, Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_S) };

  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    headers['User-Agent'] = 'Mozilla/5.0 (compatible; SdachRoeungProxy/1.0)';
    const upstream = await fetch(upstreamUrl, { headers, redirect: 'follow' });

    // HLS manifest: rewrite segment/playlist URLs into signed proxy URLs
    const contentType = upstream.headers.get('content-type') || '';
    if (/mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(upstreamUrl)) {
      const text = await upstream.text();
      const base = (() => { try { return new URL(upstreamUrl).href; } catch (e) { return upstreamUrl; } })();
      const rewritten = rewriteHlsManifest(text, base, proxyPayload, secret);
      res.set('Content-Type', contentType || 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(rewritten);
    }

    const passHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
    for (const h of passHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!res.get('Accept-Ranges')) res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'no-store');
    res.status(upstream.status);

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    logSecurityEvent(db, 'PROXY_ERROR', {
      user_id: payload.uid,
      user_name: '',
      ip,
      details: 'Upstream fetch failed: ' + (err.message || 'unknown')
    });
    res.status(502).json({ message: 'Upstream stream error' });
  }
});

// Rewrite absolute & relative URIs inside an HLS manifest into signed proxy URLs
function rewriteHlsManifest(text, baseUrl, basePayload, secret) {
  const signChild = (rawUrl) => {
    try {
      const abs = new URL(rawUrl, baseUrl).href;
      return '/api/video-proxy?sig=' + encodeURIComponent(signUpstreamForProxy(basePayload, abs, secret));
    } catch (e) {
      return rawUrl;
    }
  };
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // Rewrite URI="..." attributes (e.g. #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF)
      return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${signChild(u)}"`);
    }
    return signChild(t);
  }).join('\n');
}

// ============================================================
// POST /watching/ping — Live Watching heartbeat (every 20s)
// Re-verifies entitlement server-side; flags BYPASS_ATTEMPT.
// ============================================================
router.post('/watching/ping', (req, res) => {
  const db = readDB();
  const user = getCurrentUser(req, db);
  if (!user) return res.status(401).json({ force_stop: true, message: 'Unauthorized' });

  const movieId = req.body.movie_id;
  const epId = req.body.episode_id || null;
  const ip = clientIp(req);
  const movie = (db.movies || []).find(m => String(m.id) === String(movieId));
  if (!movie) return res.status(404).json({ message: 'Movie not found' });

  const entitled = checkEntitlement(db, user, movie, epId);
  if (!entitled) {
    const ep = epId ? (db.episodes || []).find(e => String(e.id) === String(epId)) : null;
    touchWatcher({
      user,
      movie,
      ep,
      ip,
      status: 'BYPASS_ATTEMPT'
    });
    logSecurityEvent(db, 'BYPASS_ATTEMPT', {
      user_id: user.id,
      user_name: user.first_name || '',
      ip,
      details: `Watching ping without entitlement for movie ${movie.id} (${movie.title_kh || movie.title_en || movie.id})`
    });
    return res.json({ force_stop: true, message: 'សូមទិញរឿង ឬជាវ VIP ជាមុនសិនដើម្បីទស្សនា!' });
  }

  let status = 'FREE';
  if (hasActiveVip(user, db)) status = 'VIP';
  else if (movie.access_type !== 'free') status = 'PURCHASED';

  const ep = epId ? (db.episodes || []).find(e => String(e.id) === String(epId)) : null;
  touchWatcher({ user, movie, ep, ip, status });

  res.json({ ok: true, active_watchers: getActiveWatchers().length });
});

module.exports = router;
