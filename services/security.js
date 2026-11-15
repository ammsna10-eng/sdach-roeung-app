const crypto = require('crypto');
const { writeDB } = require('../db');

// ============================================================
// SECURITY CORE: shared across client routes & super admin APIs
// ============================================================

const MAX_SECURITY_LOGS = 200;
const WATCHER_TTL_MS = 60000;      // active viewer = pinged within last 60s
const STREAM_TOKEN_TTL_S = 1200;   // signed stream URL valid for 20 minutes
const MAX_SIG_IP_HISTORY = 5000;

// In-memory live watching registry: key `${userId}:${movieId}:${epId||'movie'}`
const activeWatchers = new Map();

// Anti-sharing registry: signed-token payload (base64) -> { ips: Set, exp: ms }
const sigIpHistory = new Map();

function pruneWatchers() {
  const cutoff = Date.now() - WATCHER_TTL_MS;
  for (const [key, w] of activeWatchers.entries()) {
    if (!w.last_ping || w.last_ping < cutoff) activeWatchers.delete(key);
  }
}

function pruneSigIpHistory() {
  if (sigIpHistory.size < MAX_SIG_IP_HISTORY) return;
  const now = Date.now();
  for (const [sig, rec] of sigIpHistory.entries()) {
    if (!rec.exp || rec.exp < now) sigIpHistory.delete(sig);
  }
  // Hard cap as a last resort
  while (sigIpHistory.size > MAX_SIG_IP_HISTORY) {
    const first = sigIpHistory.keys().next().value;
    sigIpHistory.delete(first);
  }
}

// ------------------------------------------------------------
// Security audit log (db.security_logs, latest 200 events)
// ------------------------------------------------------------
function logSecurityEvent(db, type, { user_id = null, user_name = '', ip = '', details = '' } = {}) {
  try {
    db.security_logs = db.security_logs || [];
    db.security_logs.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      type: String(type),
      user_id: user_id === undefined ? null : user_id,
      user_name: user_name || '',
      ip: ip || '',
      details: String(details || '').slice(0, 500)
    });
    if (db.security_logs.length > MAX_SECURITY_LOGS) {
      db.security_logs = db.security_logs.slice(-MAX_SECURITY_LOGS);
    }
    writeDB(db);
    console.log(`[SECURITY] ${type}${user_name ? ' | user: ' + user_name : ''}${ip ? ' | ip: ' + ip : ''}${details ? ' | ' + details : ''}`);
  } catch (e) {
    console.error('[SECURITY] Failed to record event:', e.message);
  }
}

// ------------------------------------------------------------
// VIP entitlement (auto-expires & persists)
// ------------------------------------------------------------
function hasActiveVip(user, db) {
  if (!user || user.is_vip !== true) return false;
  if (!user.vip_expires_at) return true;
  const valid = new Date(user.vip_expires_at).getTime() > Date.now();
  if (!valid) {
    user.is_vip = false;
    if (db) writeDB(db);
  }
  return valid;
}

// ------------------------------------------------------------
// Signed short-lived stream tokens (HMAC-SHA256)
// payload: { uid, mid, eid, exp, ip, u }  (u = upstream URL)
// ------------------------------------------------------------
function getStreamSecret(db) {
  return process.env.STREAM_SECRET
    || process.env.BOT_TOKEN
    || (db && db.settings && db.settings.bot_token)
    || 'sdach_stream_fallback_secret_CHANGE_ME';
}

function signStreamToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

function signUpstreamForProxy(basePayload, upstreamUrl, secret) {
  return signStreamToken({ ...basePayload, u: upstreamUrl }, secret);
}

function verifyStreamToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// Client IP (behind reverse proxy e.g. Render)
// ------------------------------------------------------------
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  let ip = '';
  if (xff) ip = String(xff).split(',')[0].trim();
  if (!ip) ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').trim();
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4)
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ------------------------------------------------------------
// Live watchers registry
// ------------------------------------------------------------
function touchWatcher({ user, movie, ep = null, ip = '', status = 'FREE' }) {
  pruneWatchers();
  if (!user || !movie) return null;
  const key = `${user.id}:${movie.id}:${ep ? ep.id : 'movie'}`;
  const entry = {
    user_id: user.id,
    user_name: (user.first_name || '') + (user.last_name ? ' ' + user.last_name : ''),
    telegram_id: user.telegram_id || user.id,
    movie_id: movie.id,
    movie_title: movie.title_kh || movie.title_en || String(movie.id),
    episode_id: ep ? ep.id : null,
    episode_title: ep ? (ep.title_kh || ep.title_en || ('ភាគ ' + (ep.episode_number || ''))) : null,
    ip: ip || '',
    status: status,
    last_ping: Date.now()
  };
  activeWatchers.set(key, entry);
  return entry;
}

function dropWatchersForUser(userId) {
  for (const [key, w] of activeWatchers.entries()) {
    if (String(w.user_id) === String(userId)) activeWatchers.delete(key);
  }
}

function getActiveWatchers() {
  pruneWatchers();
  return Array.from(activeWatchers.values());
}

// ------------------------------------------------------------
// Token sharing detection: same sig used from >1 distinct IP
// ------------------------------------------------------------
function checkSigIpReuse(sigData, ip, expMs) {
  pruneSigIpHistory();
  let rec = sigIpHistory.get(sigData);
  if (!rec) {
    rec = { ips: new Set(), exp: expMs || 0 };
    sigIpHistory.set(sigData, rec);
  }
  if (ip) rec.ips.add(ip);
  return rec.ips.size <= 1;
}

module.exports = {
  WATCHER_TTL_MS,
  STREAM_TOKEN_TTL_S,
  activeWatchers,
  logSecurityEvent,
  hasActiveVip,
  getStreamSecret,
  signStreamToken,
  signUpstreamForProxy,
  verifyStreamToken,
  clientIp,
  touchWatcher,
  dropWatchersForUser,
  getActiveWatchers,
  checkSigIpReuse
};
